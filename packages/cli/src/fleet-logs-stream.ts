/**
 * `fleet logs -f` — live multi-host SSE multiplex.
 *
 * Slice 6a of `docs/CONTROL_PLANE_PLAN.md` (PR #27 follow-up to #50).
 * `fleet logs` (no `-f`) in 0.7.4 ships a snapshot reader that hangs up
 * on the first heartbeat; this module is the follow-mode counterpart.
 *
 * Shape:
 *
 *   - {@link tailLogsMultiHost} opens ONE long-lived SSE connection per
 *     configured host (`host.url/logs`) and streams chunks to a single
 *     stdout-bound renderer. No merge-by-timestamp — live streams are
 *     inherently ordered by arrival; we tag every emitted frame with
 *     `[host/agent]` and let the terminal interleave naturally.
 *   - Graceful degradation: if ONE host's socket drops, we log a
 *     warning + reconnect with exponential backoff (capped at 30s).
 *     Other hosts keep streaming — a bad host MUST NOT bounce the
 *     rest. This is the same error-isolation contract as the
 *     snapshot fan-out (`fanOut` / `{ok, err}`).
 *   - Client lifecycle: the returned handle's `stop()` cancels every
 *     per-host reader + clears reconnect timers. `fleet-cross-host-cli`
 *     wires `SIGINT` to this handle so Ctrl+C produces a clean exit.
 *     No orphaned fetch calls.
 *
 * The host-side `/logs` route IS the SSE endpoint already — there is
 * no `?follow=1` toggle to flip; the snapshot mode is simply "read a
 * fixed N frames then close." Follow mode is "don't close until
 * `stop()` is called." See `packages/core/src/observability/logs-sse-route.ts`.
 *
 * @since 0.7.5 — POST_ENTERPRISE_BACKLOG.md #50 follow-up (Slice 6a)
 */

import type { FleetHost } from '@declaragent/core';
import { resolveBearerToken } from './cross-host-control-plane-client.js';

/** A single decoded log frame (one SSE `event: log` frame). */
export interface MultiHostLogLine {
  readonly host: string;
  readonly agentId: string | undefined;
  readonly ts: number;
  readonly text: string;
  /** Raw JSON payload when the frame carried structured data. Best-effort. */
  readonly data?: Record<string, unknown>;
}

/** System-notice frames (host-side back-pressure drops, tailer errors, etc). */
export interface MultiHostLogSystem {
  readonly host: string;
  readonly kind: 'connected' | 'disconnected' | 'dropped' | 'reconnecting' | 'error';
  readonly message: string;
  /** Reconnect delay in ms when `kind === 'reconnecting'`. */
  readonly retryInMs?: number;
}

export type MultiHostLogEvent =
  | { readonly kind: 'log'; readonly line: MultiHostLogLine }
  | { readonly kind: 'system'; readonly event: MultiHostLogSystem };

export interface TailLogsMultiHostOptions {
  /** Hosts to fan out across. */
  readonly hosts: readonly FleetHost[];
  /**
   * Optional agent filter threaded into each host's `?agent=<id>` query.
   * When omitted the default is `?all=1` (multi-agent on each host).
   */
  readonly agent?: string;
  /** Override `fetch` — tests inject a deterministic stream. */
  readonly fetchImpl?: typeof fetch;
  /** Override env lookup for bearer resolution. */
  readonly env?: Record<string, string | undefined>;
  /**
   * Handler for every event — log line or system notice. The renderer
   * that `fleet logs -f` uses writes to stdout; tests capture the
   * stream as an array.
   */
  readonly onEvent: (event: MultiHostLogEvent) => void;
  /**
   * Initial reconnect delay in ms. Doubled on each consecutive failure
   * up to {@link maxReconnectDelayMs}. Reset to this value on the next
   * successful connect. Default 500 ms.
   */
  readonly initialReconnectDelayMs?: number;
  /** Ceiling for the exponential backoff. Default 30_000 ms. */
  readonly maxReconnectDelayMs?: number;
  /**
   * Override the timer factory. Tests use a fake-clock variant so the
   * backoff doesn't actually sleep.
   */
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface TailLogsMultiHostHandle {
  /**
   * Cancel every active stream + reconnect timer. Returns once every
   * per-host reader has acknowledged its `cancel()`. Safe to call more
   * than once.
   */
  stop: () => Promise<void>;
  /**
   * Resolves when every host has terminated permanently. Today that
   * only happens via `stop()` — hosts reconnect forever. Exposed for
   * tests and any future `--max-duration` knob.
   */
  done: Promise<void>;
}

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Open one long-lived SSE stream per host + merge events into the
 * caller's handler. Returns a handle whose `stop()` tears every socket
 * down cleanly.
 *
 * Reconnect policy: on connect-failure OR mid-stream disconnect the
 * host's reader loop emits a `reconnecting` system event + waits for
 * `currentDelay` ms, then retries. Delay doubles each consecutive
 * failure up to `maxReconnectDelayMs`. A successful connect resets the
 * delay to `initialReconnectDelayMs`. Stop requests cancel the pending
 * backoff timer, so `stop()` during an inter-attempt wait returns
 * promptly rather than waiting out the full backoff.
 */
export function tailLogsMultiHost(opts: TailLogsMultiHostOptions): TailLogsMultiHostHandle {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const initialDelay = opts.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
  const maxDelay = opts.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  const setTimer = opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer =
    opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let stopped = false;
  const perHostState: PerHostState[] = opts.hosts.map((host) => ({
    host,
    currentDelay: initialDelay,
    aborter: null,
    backoffTimer: null,
    done: false,
  }));

  const settled: Array<Promise<void>> = perHostState.map((state) =>
    runHostLoop(state, {
      fetchImpl,
      env,
      agent: opts.agent,
      onEvent: opts.onEvent,
      setTimer,
      clearTimer,
      initialDelay,
      maxDelay,
      isStopped: () => stopped,
    }),
  );

  const done = Promise.all(settled).then(() => {
    // `done` resolves only when every per-host loop has exited — which
    // happens on stop(). `Promise.all` preserves that guarantee even
    // when N=0 hosts (resolves immediately).
  });

  return {
    async stop() {
      if (stopped) {
        await done;
        return;
      }
      stopped = true;
      for (const state of perHostState) {
        if (state.aborter) {
          try {
            state.aborter.abort();
          } catch {
            // abort can throw on some platforms; swallow.
          }
        }
        if (state.backoffTimer !== null) {
          clearTimer(state.backoffTimer);
          state.backoffTimer = null;
        }
      }
      await done;
    },
    done,
  };
}

interface PerHostState {
  readonly host: FleetHost;
  currentDelay: number;
  aborter: AbortController | null;
  backoffTimer: unknown | null;
  done: boolean;
}

interface HostLoopDeps {
  readonly fetchImpl: typeof fetch;
  readonly env: Record<string, string | undefined>;
  readonly agent: string | undefined;
  readonly onEvent: (event: MultiHostLogEvent) => void;
  readonly setTimer: (cb: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly initialDelay: number;
  readonly maxDelay: number;
  readonly isStopped: () => boolean;
}

async function runHostLoop(state: PerHostState, deps: HostLoopDeps): Promise<void> {
  while (!deps.isStopped()) {
    const aborter = new AbortController();
    state.aborter = aborter;
    try {
      await streamOnce(state.host, aborter, deps);
      // A successful stream that ended cleanly (server closed the
      // socket) still deserves a reconnect attempt — servers bounce
      // on idle-timeout or redeploy. Reset the backoff on each clean
      // termination, same as connect-success.
      state.currentDelay = deps.initialDelay;
      if (!deps.isStopped()) {
        deps.onEvent({
          kind: 'system',
          event: {
            host: state.host.name,
            kind: 'disconnected',
            message: 'stream ended; reconnecting',
          },
        });
      }
    } catch (err) {
      if (deps.isStopped()) break;
      const msg = err instanceof Error ? err.message : String(err);
      deps.onEvent({
        kind: 'system',
        event: { host: state.host.name, kind: 'error', message: msg },
      });
    }

    if (deps.isStopped()) break;

    // Schedule the next attempt. `stop()` can fire WHILE we're waiting
    // — it clears `backoffTimer` so the sleep resolves early.
    const delay = state.currentDelay;
    deps.onEvent({
      kind: 'system',
      event: {
        host: state.host.name,
        kind: 'reconnecting',
        message: `retrying in ${delay}ms`,
        retryInMs: delay,
      },
    });
    await new Promise<void>((resolve) => {
      const handle = deps.setTimer(() => {
        state.backoffTimer = null;
        resolve();
      }, delay);
      state.backoffTimer = handle;
    });
    state.currentDelay = Math.min(state.currentDelay * 2, deps.maxDelay);
  }
  state.done = true;
}

async function streamOnce(
  host: FleetHost,
  aborter: AbortController,
  deps: HostLoopDeps,
): Promise<void> {
  const base = host.url.replace(/\/+$/, '');
  const sp = new URLSearchParams();
  if (deps.agent !== undefined && deps.agent !== '') {
    sp.set('agent', deps.agent);
  } else {
    sp.set('all', '1');
  }
  const url = `${base}/logs?${sp.toString()}`;
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
  };
  if (host.auth?.bearer) {
    headers.authorization = `Bearer ${resolveBearerToken(host.auth.bearer, { env: deps.env })}`;
  }

  const res = await deps.fetchImpl(url, {
    method: 'GET',
    headers,
    signal: aborter.signal,
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  if (!res.body) {
    throw new Error('response has no body');
  }
  deps.onEvent({
    kind: 'system',
    event: { host: host.name, kind: 'connected', message: `streaming from ${url}` },
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const frame of parts) {
        emitFrame(host, frame, deps);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore — reader may already be closed by the abort signal
    }
  }
}

function emitFrame(host: FleetHost, frame: string, deps: HostLoopDeps): void {
  const lines = frame.split('\n').filter((l) => l.length > 0);
  let event = 'message';
  let data: string | undefined;
  for (const l of lines) {
    // `:` comment lines (heartbeats) — drop silently.
    if (l.startsWith(':')) continue;
    if (l.startsWith('event:')) {
      event = l.slice(6).trim();
    } else if (l.startsWith('data:')) {
      data = (data ? `${data}\n` : '') + l.slice(5).trimStart();
    }
  }
  if (data === undefined) return;

  if (event === 'log') {
    const parsed = tryParseJson(data);
    const { ts, text, agentId, raw } = extractLogFields(parsed, data);
    const line: MultiHostLogLine = {
      host: host.name,
      agentId,
      ts,
      text,
      ...(raw !== undefined && { data: raw }),
    };
    deps.onEvent({ kind: 'log', line });
    return;
  }

  if (event === 'system') {
    const parsed = tryParseJson(data);
    const msg =
      typeof parsed?.message === 'string'
        ? parsed.message
        : typeof parsed?.system === 'string'
          ? parsed.system
          : data;
    const kind: MultiHostLogSystem['kind'] =
      parsed?.system === 'dropped'
        ? 'dropped'
        : parsed?.system === 'tailer-error'
          ? 'error'
          : 'error';
    deps.onEvent({
      kind: 'system',
      event: { host: host.name, kind, message: msg },
    });
  }
}

function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractLogFields(
  parsed: Record<string, unknown> | null,
  raw: string,
): {
  ts: number;
  text: string;
  agentId: string | undefined;
  raw: Record<string, unknown> | undefined;
} {
  if (parsed === null) {
    return { ts: Date.now(), text: raw, agentId: undefined, raw: undefined };
  }
  const ts =
    typeof parsed.ts === 'number'
      ? parsed.ts
      : typeof parsed.timestamp === 'number'
        ? parsed.timestamp
        : Date.now();
  const text =
    typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.text === 'string'
        ? parsed.text
        : raw;
  const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : undefined;
  return { ts, text, agentId, raw: parsed };
}

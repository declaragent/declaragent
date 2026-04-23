/**
 * `/logs` — Server-Sent Events endpoint for live log tailing.
 *
 * Completes Slice 1 of `docs/CONTROL_PLANE_PLAN.md` by landing the
 * last of the five control-plane routes (`/metrics`, `/status`,
 * `/events`, `/dlq`, `/audit` ship in earlier PRs). Reads from the
 * per-agent JSON-lines log files the `up` daemon already writes to
 * `~/.declaragent/logs/<agent>.log` via
 * {@link ../../cli/src/up-lifecycle.openAgentLog} and re-frames each
 * line as an SSE `event: log\ndata: {...}\n\n` frame.
 *
 * Design choices:
 *
 *   - **SSE over WebSocket.** One-way server → client. HTTP/1.1
 *     compatible. Native `EventSource` API on every browser + a
 *     `fetch`-based reader in the CLI. No framing layer.
 *   - **Heartbeats.** Every 15s we emit `: keep-alive\n\n` (a
 *     comment-only frame) so proxies + load balancers don't close
 *     the idle socket. Clients that ignore comments see nothing.
 *   - **Back-pressure.** The tailer can outrun the socket on a
 *     busy agent. We buffer up to 1024 pending frames; once that
 *     queue fills, we drop the whole buffer and emit a single
 *     `{"system":"dropped","count":N}` so the client can reconnect
 *     or resync from `/events`. Dropping is preferred to blocking
 *     the tailer — a stuck SSE client must not back-pressure the
 *     file I/O loop.
 *   - **Resource discipline.** Every stream registers its tailer
 *     with the underlying `ReadableStream`'s `cancel` hook. When
 *     the client drops the socket, the controller reports `cancel`
 *     and we destroy the tailer + stop the heartbeat timer. We
 *     also honour `request.signal.abort` as a belt-and-suspenders
 *     cleanup path (Bun's runtime wires AbortController into
 *     Request.signal when the client disconnects).
 *
 * @since 0.7.0-slice.1 (PR 1.2)
 */

import type { ControlPlaneRoute } from './control-plane-server.js';
import { type LogTailer, createLogTailer } from './log-tail.js';

// ── Route options + query ──────────────────────────────────────────────────

/**
 * Host-supplied policy for which log files the `/logs` endpoint is
 * allowed to stream. The route doesn't know the `up` daemon's path
 * layout — it calls back into the host (the `up-cli.ts` wiring)
 * which maps `?agent=<id>` to the concrete `~/.declaragent/logs/<id>.log`
 * file paths.
 *
 * Returning `null` is the "unknown agent" signal → 400. Returning
 * an empty array is "valid query but no files to tail" → 200 with
 * an immediate `system: no-paths` frame (rare — tests rely on this
 * to assert the error path; production callers should return null).
 */
export type ResolveLogPaths = (
  query: LogsQuery,
) => LogsResolvedPaths | null | Promise<LogsResolvedPaths | null>;

export interface LogsQuery {
  /** Literal `?agent=` param. Undefined when the caller wants the multiplex. */
  readonly agent: string | undefined;
  /** Literal `?since=` param. ms-epoch or ISO-8601. Callers decide how to seek. */
  readonly since: string | undefined;
  /**
   * Literal `?all=1` marker. When true, the caller explicitly opted into
   * the fan-out variant and the route enforces `fanOutLimit` + scope
   * gating. When false, the route falls back to the single-agent path
   * (`?agent=<id>`) or, for back-compat, the legacy no-param multiplex
   * — which is ALSO bounded by `fanOutLimit` so a 50-agent `up`
   * process doesn't open 50 watchers by accident.
   *
   * @since 0.7.3 — POST_ENTERPRISE_BACKLOG.md #20
   */
  readonly all: boolean;
  /** URL of the request, for callers that want to parse additional params. */
  readonly url: URL;
}

export interface LogsResolvedPaths {
  /** Absolute paths to tail. One per log file; multiple files may map to one agent. */
  readonly paths: readonly ResolvedLogPath[];
  /** When true, the tailer replays the whole file before following. */
  readonly fromStart?: boolean;
}

export interface ResolvedLogPath {
  readonly path: string;
  readonly agentId: string;
}

export interface LogsRouteOptions {
  path?: string;
  resolvePaths: ResolveLogPaths;
  /**
   * Heartbeat interval in ms. Default 15_000. Tests override to
   * 50ms so assertions on the comment frame don't take 15s.
   */
  heartbeatMs?: number;
  /**
   * Maximum pending frames before the back-pressure drop kicks in.
   * Default 1024. On drop, we replace the queue with a single
   * `system: dropped` frame carrying the count we discarded.
   */
  maxBufferedFrames?: number;
  /**
   * Soft cap on how many log files one fan-out request may tail. Mirrors
   * the `logs.fanOutLimit` knob in `agent.yaml` / `fleet.yaml`. When the
   * resolver returns more paths than this, the route answers 413
   * `Payload Too Large` with a JSON body naming the cap — operators
   * either narrow to `?agent=<id>` or bump the cap.
   *
   * Default 50. Chosen as a conservative floor: each tailer holds one
   * file descriptor + one `fs.watch`; 50 is well under the typical
   * `ulimit -n` ceiling (1024+) even on constrained hosts. Raise this
   * only after confirming the host's FD budget can absorb the spike.
   *
   * @since 0.7.3 — POST_ENTERPRISE_BACKLOG.md #20
   */
  fanOutLimit?: number;
  /**
   * Minimum gap in ms between two `event: log` frames for the SAME
   * agent. Keeps a single chatty agent from saturating the SSE socket
   * during a `?all=1` fan-out — lines arriving inside the window are
   * coalesced into the tail buffer and flushed on the next tick. Set
   * to 0 to disable (default). Applied only on `?all=1`; single-agent
   * tails skip coalescing because the natural file-watch cadence is
   * already the rate-limit in that case.
   *
   * Rate-limited coalescing never drops a line — it only queues it
   * behind the back-pressure buffer. If the buffer overflows during
   * coalescing, the existing `system: dropped` notice fires.
   *
   * @since 0.7.3 — POST_ENTERPRISE_BACKLOG.md #20
   */
  coalescePerAgentMs?: number;
  /**
   * Testing seam — override the tailer factory so unit tests can
   * drive lines deterministically instead of touching the disk.
   */
  tailerFactory?: (opts: {
    paths: readonly ResolvedLogPath[];
    fromStart: boolean;
  }) => LogTailer;
}

// ── Route ──────────────────────────────────────────────────────────────────

/**
 * `GET /logs` — SSE live-tail of one or more agent log files.
 *
 * Query params:
 *   - `agent` (optional) — limit to one agent. Omit to multiplex all running agents.
 *   - `since` (optional) — ms-epoch or ISO-8601 offset. When set, the
 *     tailer starts at byte 0 of each file; callers filter on the
 *     wire.
 *
 * Response:
 *   - `200 text/event-stream`. Every log line is an `event: log`
 *     frame with JSON body. Heartbeats are `: keep-alive` comments.
 *     Disconnects tear the tailer down.
 *   - `400 application/json` when `resolvePaths` returns `null` for
 *     an unknown agent. Error body: `{ "error": "..." }`.
 *   - `405` for non-GET.
 */
/**
 * Default soft cap on fan-out watchers. N=50 is documented in
 * {@link LogsRouteOptions.fanOutLimit}. Operators flip this via the
 * `logs.fanOutLimit` knob that the CLI passes through from `agent.yaml`.
 */
const DEFAULT_FAN_OUT_LIMIT = 50;

export function logsRoute(opts: LogsRouteOptions): ControlPlaneRoute {
  const path = opts.path ?? '/logs';
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxBuffered = opts.maxBufferedFrames ?? 1024;
  const fanOutLimit = opts.fanOutLimit ?? DEFAULT_FAN_OUT_LIMIT;
  const coalesceMs = Math.max(0, opts.coalescePerAgentMs ?? 0);
  const makeTailer =
    opts.tailerFactory ?? (({ paths, fromStart }) => createLogTailer({ paths, fromStart }));

  return {
    path,
    async fetch(req) {
      if (req.method !== 'GET') {
        return new Response('method not allowed', {
          status: 405,
          headers: { Allow: 'GET' },
        });
      }

      const url = new URL(req.url);
      const all = url.searchParams.get('all') === '1';
      const agentParam = url.searchParams.get('agent') ?? undefined;

      // Mutual-exclusion: `?agent=` picks one; `?all=1` picks every
      // hosted agent. Mixing them is ambiguous → 400. (The server-side
      // scope gate fires before this branch, so a caller that reaches
      // here with `?all=1` is already scope-authorised.)
      if (all && agentParam !== undefined && agentParam !== '') {
        return jsonError(400, '?all=1 and ?agent= are mutually exclusive');
      }

      const query: LogsQuery = {
        agent: agentParam,
        since: url.searchParams.get('since') ?? undefined,
        all,
        url,
      };

      let resolved: LogsResolvedPaths | null;
      try {
        resolved = await opts.resolvePaths(query);
      } catch (err) {
        return jsonError(500, `path resolver failed: ${errMsg(err)}`);
      }
      if (resolved === null) {
        return jsonError(400, `unknown agent "${query.agent ?? ''}"`);
      }

      // Enforce the fan-out cap BEFORE we open any watcher. Applies to
      // both `?all=1` and the legacy no-param multiplex so a naive
      // operator tailing a 200-agent `up` doesn't blow through the FD
      // budget. Single-agent `?agent=<id>` is always one path → never
      // hits the cap.
      if (resolved.paths.length > fanOutLimit) {
        return new Response(
          JSON.stringify({
            error: `log fan-out exceeds cap (${resolved.paths.length} > ${fanOutLimit}). Narrow with ?agent=<id> or raise logs.fanOutLimit.`,
            limit: fanOutLimit,
            requested: resolved.paths.length,
          }),
          {
            status: 413,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          },
        );
      }

      const tailer = makeTailer({
        paths: resolved.paths,
        fromStart: Boolean(resolved.fromStart),
      });

      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let pending: Uint8Array[] = [];
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closed = false;
      // Per-agent coalescing state — only populated when `?all=1` +
      // `coalesceMs > 0`. Maps agentId → { last flush ts, scheduled
      // timer, queued lines }.  See `enqueueLogLine` below.
      const coalesceActive = all && coalesceMs > 0;
      const coalesceState = new Map<
        string,
        {
          nextAllowedAt: number;
          timer: ReturnType<typeof setTimeout> | null;
          queued: string[];
        }
      >();

      const canFlush = (): boolean => {
        if (!controller || closed) return false;
        // `desiredSize` is positive when the consumer is ready, 0
        // when at the high-water mark, null when the stream is
        // errored. Anything <= 0 means we should buffer rather
        // than enqueue directly.
        const desired = controller.desiredSize;
        return desired === null ? false : desired > 0;
      };

      const flush = (): void => {
        if (!controller || closed) return;
        while (pending.length > 0 && canFlush()) {
          const frame = pending.shift();
          if (!frame) break;
          try {
            controller.enqueue(frame);
          } catch {
            // Controller already closed — happens during cancel
            // races. Drop the frame and stop flushing.
            closed = true;
            break;
          }
        }
      };

      const enqueueRaw = (bytes: Uint8Array): void => {
        if (closed) return;
        // Back-pressure: if we're buffering more than the cap, drop
        // everything and emit a single system notice. We reset the
        // queue rather than dropping oldest because the consumer is
        // better off with a "you missed N lines" signal than with a
        // half-stale tail. 1024 lines × ~200 bytes = ~200KB ceiling.
        if (pending.length >= maxBuffered) {
          const dropped = pending.length;
          pending = [];
          pending.push(formatSystemFrame(encoder, { system: 'dropped', count: dropped }));
        }
        pending.push(bytes);
        flush();
      };

      const emitLogFrame = (agentId: string, line: string): void => {
        if (closed) return;
        // The log writer emits well-formed JSON per line; re-emit
        // as-is, adding the `agentId` field if the line doesn't
        // already carry one. If parsing fails we wrap the raw text
        // so a non-JSON log entry doesn't kill the stream.
        let payload: string;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (typeof obj.agent !== 'string' && typeof obj.agentId !== 'string') {
            obj.agentId = agentId;
          }
          payload = JSON.stringify(obj);
        } catch {
          payload = JSON.stringify({ agentId, raw: line });
        }
        enqueueRaw(encoder.encode(`event: log\ndata: ${payload}\n\n`));
      };

      const flushCoalesced = (agentId: string): void => {
        const slot = coalesceState.get(agentId);
        if (!slot) return;
        const lines = slot.queued;
        slot.queued = [];
        slot.timer = null;
        slot.nextAllowedAt = Date.now() + coalesceMs;
        for (const line of lines) emitLogFrame(agentId, line);
      };

      const enqueueLogLine = (agentId: string, line: string): void => {
        if (closed) return;
        // Fast path — no coalescing or single-agent stream: emit the
        // frame immediately, exactly like the pre-0.7.3 behaviour.
        if (!coalesceActive) {
          emitLogFrame(agentId, line);
          return;
        }

        // Rate-limited fan-out: per-agent coalescing. We flush a line
        // straight away when the last flush for this agent happened
        // `coalesceMs` ago or longer. Otherwise we queue and arm a
        // one-shot timer for the remainder of the window. Lines are
        // NEVER dropped here — the back-pressure path below is the
        // only drop site.
        const now = Date.now();
        let slot = coalesceState.get(agentId);
        if (!slot) {
          slot = { nextAllowedAt: 0, timer: null, queued: [] };
          coalesceState.set(agentId, slot);
        }
        if (now >= slot.nextAllowedAt && slot.queued.length === 0) {
          slot.nextAllowedAt = now + coalesceMs;
          emitLogFrame(agentId, line);
          return;
        }
        slot.queued.push(line);
        if (!slot.timer) {
          const delay = Math.max(1, slot.nextAllowedAt - now);
          slot.timer = setTimeout(() => flushCoalesced(agentId), delay);
        }
      };

      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          controller = ctrl;

          // Initial comment frame so eager proxies know the stream is
          // alive before the first real line lands. Harmless for well-
          // behaved clients.
          enqueueRaw(encoder.encode(': stream-open\n\n'));

          // Heartbeat loop — comment frames only, ignored by
          // `EventSource`. We don't .unref() here because the timer
          // is bound to the stream lifetime and is cleaned up in
          // `cancel` / on abort.
          heartbeat = setInterval(() => {
            enqueueRaw(encoder.encode(': keep-alive\n\n'));
          }, heartbeatMs);

          // Pump the tailer. We don't await here — the whole point
          // of the stream is to deliver lines as they arrive.
          void (async () => {
            try {
              for await (const { agentId, line } of tailer) {
                if (closed) break;
                enqueueLogLine(agentId, line);
              }
            } catch (err) {
              enqueueRaw(
                encoder.encode(
                  `event: system\ndata: ${JSON.stringify({
                    system: 'tailer-error',
                    message: errMsg(err),
                  })}\n\n`,
                ),
              );
            }
          })();

          // AbortController signal fires on client disconnect under
          // Bun. Mirror the cleanup so we don't double-close.
          if (req.signal) {
            if (req.signal.aborted) {
              shutdown();
            } else {
              req.signal.addEventListener('abort', shutdown, { once: true });
            }
          }
        },
        pull() {
          // Consumer has space again — drain whatever we stashed in
          // `pending`.
          flush();
        },
        cancel() {
          shutdown();
        },
      });

      function shutdown(): void {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        // Drop any pending coalesce timers — the client is gone, no
        // reason to wake up the event loop to flush into a closed stream.
        for (const slot of coalesceState.values()) {
          if (slot.timer) {
            clearTimeout(slot.timer);
            slot.timer = null;
          }
          slot.queued.length = 0;
        }
        coalesceState.clear();
        void tailer.destroy();
        pending = [];
        try {
          controller?.close();
        } catch {
          // already closed
        }
      }

      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          // Disable proxy buffering — critical for nginx + certain
          // cloud load-balancers that batch small responses by
          // default, which defeats the point of a live tail.
          'x-accel-buffering': 'no',
        },
      });
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatSystemFrame(encoder: TextEncoder, body: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: system\ndata: ${JSON.stringify(body)}\n\n`);
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

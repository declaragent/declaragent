/**
 * Cross-host control-plane HTTP client.
 *
 * Slice 3 of `docs/CONTROL_PLANE_PLAN.md` / POST_ENTERPRISE_BACKLOG.md
 * #50. Today `declaragent fleet ps / logs / events / dlq` each read a
 * single local `up` process's control socket. In a multi-host deploy
 * that's a per-host view. This module adds the fan-out layer:
 *
 *   - A tiny HTTP client (`fetch`-based, Bun native) that hits each
 *     configured host's `/status`, `/events`, `/dlq`, `/logs` endpoint
 *     with bearer auth + per-request timeout.
 *   - {@link fanOut} — runs a per-host call concurrently and returns
 *     `{ok, err}` discriminated-union results so one bad host never
 *     tanks the aggregate. Callers decide whether to partial-render or
 *     fail.
 *   - A bearer-token resolver accepting `env:NAME` / `file:/abs/path` /
 *     literal strings. Mirrors the existing secret-resolver shapes so
 *     operators don't learn a new convention for this one config
 *     surface.
 *
 * Design notes:
 *
 *   - We don't reuse `control-socket-client.ts`. That helper is a unix-
 *     socket JSON-RPC path (per-agent RPC). The cross-host path is HTTP
 *     against the `up` daemon's `/metrics` port — a distinct transport
 *     with a distinct wire format. The two clients share nothing at
 *     the bits level; sharing a common name would just conflate them.
 *   - The `?all=1` in-process fan-out on `/events` + `/dlq` + `/logs`
 *     is the host-side merge (PR #19/#20). This module is the OUTER
 *     fan-out — N parallel HTTP calls, one per host, merged by
 *     timestamp. When `?all=1` is not set we pass through `hosts[]`
 *     one call per host, then merge.
 *   - Errors do NOT throw out of `fanOut`. Every host result is an
 *     explicit `{ok: T}` or `{err: Error}`. Callers that want fail-fast
 *     behaviour can inspect `err` entries themselves.
 *
 * Per-host auth is ONE bearer per host. Per-agent auth (Agent A's
 * Sprint 4 work on the RPC envelope registry) is orthogonal — that
 * governs incoming RPC AT a host, not the outgoing cross-host calls
 * from the CLI.
 *
 * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #50
 */

import { readFileSync } from 'node:fs';
import type { DlqResponse, EventsResponse, FleetHost, UpStatusSnapshot } from '@declaragent/core';

/** Discriminated-union result for a single-host call. */
export type HostResult<T> = { readonly ok: T } | { readonly err: HostError };

export interface HostError {
  readonly host: string;
  readonly message: string;
  /** HTTP status when available; `undefined` for connect / abort errors. */
  readonly status?: number;
}

/** Per-host outcome tagged with its host name for merged rendering. */
export interface HostTaggedResult<T> {
  readonly host: string;
  readonly result: HostResult<T>;
}

const DEFAULT_TIMEOUT_MS = 5000;

// ── Bearer token resolution ────────────────────────────────────────────

/**
 * Resolve a `FleetHost.auth.bearer` value into the literal token to put
 * on the wire. Supports `env:NAME`, `file:/absolute/path`, and literal
 * strings. Unresolved refs throw — a missing env var is a config error,
 * not a runtime fall-through to "no auth header."
 */
export interface BearerResolverDeps {
  readonly env?: Record<string, string | undefined>;
  readonly readFile?: (p: string) => string;
}

export function resolveBearerToken(bearer: string, deps: BearerResolverDeps = {}): string {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  if (bearer.startsWith('env:')) {
    const name = bearer.slice(4);
    const v = env[name];
    if (v === undefined || v === '') {
      throw new Error(`bearer token env var "${name}" is not set`);
    }
    return v;
  }
  if (bearer.startsWith('file:')) {
    const path = bearer.slice(5);
    try {
      return readFile(path).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`bearer token file "${path}" unreadable: ${msg}`);
    }
  }
  return bearer;
}

// ── Client ─────────────────────────────────────────────────────────────

export interface CrossHostClientOptions {
  /** Override `fetch`. Production calls Bun's global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Override the environment lookup for bearer resolution (tests). */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Build the headers + resolved URL + abort signal for a single host
 * call. Exported for tests + for the logs streamer which consumes the
 * same shape.
 */
export function buildHostRequest(
  host: FleetHost,
  path: string,
  search: URLSearchParams | undefined,
  timeoutMs: number,
  env: Record<string, string | undefined>,
): {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  cancel: () => void;
} {
  const base = host.url.replace(/\/+$/, '');
  const qs = search && search.toString().length > 0 ? `?${search.toString()}` : '';
  const url = `${base}${path}${qs}`;
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (host.auth?.bearer) {
    const token = resolveBearerToken(host.auth.bearer, { env });
    headers.authorization = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    url,
    headers,
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function callJson<T>(
  host: FleetHost,
  path: string,
  search: URLSearchParams | undefined,
  options: CrossHostClientOptions,
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const timeout = host.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { url, headers, signal, cancel } = buildHostRequest(host, path, search, timeout, env);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      const err = new Error(`${res.status} ${res.statusText}${snippet ? `: ${snippet}` : ''}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  } finally {
    cancel();
  }
}

function toHostError(host: FleetHost, err: unknown): HostError {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number } | null)?.status;
  return status !== undefined ? { host: host.name, message, status } : { host: host.name, message };
}

export interface CrossHostControlPlaneClient {
  getStatus(host: FleetHost): Promise<UpStatusSnapshot>;
  getEvents(host: FleetHost, opts?: GetEventsOpts): Promise<EventsResponse>;
  getDlq(host: FleetHost, opts?: GetDlqOpts): Promise<DlqResponse>;
}

export interface GetEventsOpts {
  readonly kind?: string;
  readonly since?: number | string;
  readonly state?: 'circuit-open';
  readonly outcome?: string;
  readonly correlation?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Fan out across every agent on that host (host-side ?all=1). */
  readonly all?: boolean;
}

export interface GetDlqOpts {
  readonly kind?: 'dispatch';
  readonly reason?: string;
  readonly minAttempts?: number;
  readonly since?: number | string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly all?: boolean;
}

function buildEventsSearch(opts: GetEventsOpts | undefined): URLSearchParams {
  const sp = new URLSearchParams();
  if (!opts) return sp;
  if (opts.kind) sp.set('kind', opts.kind);
  if (opts.since !== undefined) sp.set('since', String(opts.since));
  if (opts.state) sp.set('state', opts.state);
  if (opts.outcome) sp.set('outcome', opts.outcome);
  if (opts.correlation) sp.set('correlation', opts.correlation);
  if (opts.limit !== undefined) sp.set('limit', String(opts.limit));
  if (opts.cursor) sp.set('cursor', opts.cursor);
  if (opts.all) sp.set('all', '1');
  return sp;
}

function buildDlqSearch(opts: GetDlqOpts | undefined): URLSearchParams {
  const sp = new URLSearchParams();
  if (!opts) return sp;
  if (opts.kind) sp.set('kind', opts.kind);
  if (opts.reason) sp.set('reason', opts.reason);
  if (opts.minAttempts !== undefined) sp.set('minAttempts', String(opts.minAttempts));
  if (opts.since !== undefined) sp.set('since', String(opts.since));
  if (opts.limit !== undefined) sp.set('limit', String(opts.limit));
  if (opts.cursor) sp.set('cursor', opts.cursor);
  if (opts.all) sp.set('all', '1');
  return sp;
}

export function createCrossHostControlPlaneClient(
  options: CrossHostClientOptions = {},
): CrossHostControlPlaneClient {
  return {
    getStatus(host) {
      return callJson<UpStatusSnapshot>(host, '/status', undefined, options);
    },
    getEvents(host, opts) {
      return callJson<EventsResponse>(host, '/events', buildEventsSearch(opts), options);
    },
    getDlq(host, opts) {
      return callJson<DlqResponse>(host, '/dlq', buildDlqSearch(opts), options);
    },
  };
}

// ── Parallel fan-out + merge ───────────────────────────────────────────

/**
 * Run `call(host)` across every host concurrently. One host's failure
 * is isolated to its slot in the returned array — callers get
 * `HostTaggedResult<T>[]` preserving input order.
 */
export async function fanOut<T>(
  hosts: readonly FleetHost[],
  call: (host: FleetHost) => Promise<T>,
): Promise<readonly HostTaggedResult<T>[]> {
  const results = await Promise.allSettled(hosts.map((h) => call(h)));
  return results.map((r, i) => {
    const host = hosts[i];
    // `hosts[i]` is always defined — same length as `results`.
    if (!host) {
      throw new Error('fanOut: host index out of range');
    }
    if (r.status === 'fulfilled') {
      return { host: host.name, result: { ok: r.value } };
    }
    return { host: host.name, result: { err: toHostError(host, r.reason) } };
  });
}

/**
 * Narrow a `HostTaggedResult` array into `{ successes, failures }`. A
 * convenience wrapper — callers that want richer rendering iterate the
 * raw array themselves.
 */
export function partitionResults<T>(results: readonly HostTaggedResult<T>[]): {
  readonly successes: readonly { readonly host: string; readonly value: T }[];
  readonly failures: readonly HostError[];
} {
  const successes: { host: string; value: T }[] = [];
  const failures: HostError[] = [];
  for (const r of results) {
    if ('ok' in r.result) {
      successes.push({ host: r.host, value: r.result.ok });
    } else {
      failures.push(r.result.err);
    }
  }
  return { successes, failures };
}

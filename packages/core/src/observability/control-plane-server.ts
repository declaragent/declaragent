/**
 * Control-plane HTTP server — router-based extension of the 0.6.0
 * `/metrics` listener.
 *
 * Ships as the HTTP substrate for `docs/CONTROL_PLANE_PLAN.md` Slice 1.
 * The 0.6.0 {@link startPrometheusExporter} served a single hard-coded
 * `/metrics` path. The control-plane plan adds `/status`, `/events`,
 * `/dlq`, `/audit`, and `/logs` to the same listener so an operator's
 * `declaragent fleet <verb>` CLI can fan out to one port per `up`
 * process instead of discovering a different service per capability.
 *
 * This module is the minimal substrate the rest of the plan extends:
 *
 *   - {@link ControlPlaneRoute}         — the handler contract.
 *   - {@link startControlPlaneServer}   — binds a Bun HTTP listener
 *                                         and dispatches incoming
 *                                         requests to the matching
 *                                         route.
 *   - {@link metricsRoute}              — delegates to an existing
 *                                         {@link PrometheusRegistry}.
 *   - {@link statusRoute}               — serves a JSON snapshot of
 *                                         the current `up` state.
 *
 * Slice 1 scope (this file):
 *   - Localhost-only by default; remote bind is refused unless the
 *     caller opts in via {@link ControlPlaneServerOptions.allowRemote}.
 *   - No auth layer. Auth + rate-limit + remote bind land in Slice 2
 *     (see CONTROL_PLANE_PLAN.md §5.1 + §8).
 *   - No `/events`, `/dlq`, `/audit`, or `/logs` routes. Those are
 *     Slice 1 PR 1.1 / 1.2 follow-ups; this file lands the router
 *     contract + the first two routes so subsequent PRs just plug in.
 *
 * @since 0.7.0-slice.1
 */

import {
  type ControlPlaneAuth,
  type ControlPlaneAuthContext,
  applyControlPlaneAuth,
} from './control-plane-auth.js';
import type { PrometheusRegistry } from './prometheus.js';

// ── Route contract ─────────────────────────────────────────────────────────

/**
 * A single HTTP handler bound to an exact pathname. The server matches
 * `new URL(request.url).pathname` against {@link path} and invokes
 * {@link fetch} for the first route whose path matches.
 *
 * Keeping the match exact (not prefix / regex) matches the plan's
 * read-only, low-surface-area posture — every control-plane endpoint
 * has a single canonical URL. If a future endpoint needs path
 * parameters (e.g. `DELETE /dlq/<eventId>` from Slice 5), the route
 * can register its own matcher by inspecting the request inside
 * {@link fetch} and returning `undefined` to fall through.
 */
export interface ControlPlaneRoute {
  readonly path: string;
  /**
   * Handle the request, or return `undefined` to decline (falls
   * through to the next route or 404). Allowed HTTP methods live
   * inside the handler — it returns 405 itself if the request
   * method isn't supported.
   */
  fetch(request: Request): Promise<Response | undefined> | Response | undefined;
}

// ── Server ─────────────────────────────────────────────────────────────────

export interface ControlPlaneServerListenOptions {
  port: number;
  hostname: string;
  /**
   * Incoming-request handler. The second argument carries transport
   * observations the middleware needs — `peerIp` lets the auth layer
   * enforce `allowLoopback: { trustedProxies }` correctly behind a
   * reverse proxy.
   *
   * Back-compat: `context` is optional. Listener stubs in older tests
   * that invoke `fetch(req)` without a second arg keep working; the
   * server only loses proxy-aware loopback evaluation, which is the
   * legacy behaviour anyway.
   *
   * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #7
   */
  fetch: (req: Request, context?: { peerIp?: string }) => Promise<Response> | Response;
}

export interface ControlPlaneServerInstance {
  readonly port: number;
  readonly hostname: string;
  stop(): Promise<void> | void;
}

export interface ControlPlaneServerOptions {
  /** Routes to register. Matched in declaration order. */
  routes: readonly ControlPlaneRoute[];
  /** HTTP listen port. Default 9464 (matches the 0.6.0 metrics port). */
  port?: number;
  /** Host to bind. Default `127.0.0.1`. */
  hostname?: string;
  /**
   * Accept non-localhost clients. Default `false`. Slice 2 wires
   * this to `agent.yaml#observability.bindAddress`.
   */
  allowRemote?: boolean;
  /**
   * Optional auth middleware. When supplied, every request passes
   * through {@link applyControlPlaneAuth} before route dispatch.
   * Missing / bad tokens produce a typed 401 before the router sees
   * the request. Omit for back-compat (no auth; existing behaviour).
   *
   * @since 0.7.0-slice.2
   */
  auth?: ControlPlaneAuth;
  /** Test override. Replace Bun.serve with a fake listener. */
  listen?: (opts: ControlPlaneServerListenOptions) => Promise<ControlPlaneServerInstance>;
}

export interface ControlPlaneServerHandle {
  readonly port: number;
  readonly hostname: string;
  readonly routes: readonly string[];
  close(): Promise<void>;
}

export async function startControlPlaneServer(
  opts: ControlPlaneServerOptions,
): Promise<ControlPlaneServerHandle> {
  const port = opts.port ?? 9464;
  const hostname = opts.hostname ?? '127.0.0.1';
  const allowRemote = opts.allowRemote ?? false;
  const listen = opts.listen ?? defaultListen;
  const routes = opts.routes;
  const auth = opts.auth;

  assertUniquePaths(routes);

  async function fetch(req: Request, ctx?: { peerIp?: string }): Promise<Response> {
    if (!allowRemote && !isLocalClient(req)) {
      return new Response('remote control-plane disabled', { status: 403 });
    }
    // Pre-compute the matched route path (if any) so per-route scope
    // overrides can be enforced *inside* the auth middleware. Matching
    // twice (once here, once in the loop below) is cheap — `routes` is
    // a tiny array (≤ 6 entries) and the comparison is string equality.
    //
    // Multi-agent fan-out gating (POST_ENTERPRISE_BACKLOG.md #19 / #20):
    // when the request carries `?all=1`, we surface a synthetic key
    // `${pathname}?all=1` to the auth middleware so operators can
    // require a dedicated scope (convention: `control:fan-out`) to
    // execute the fan-out variant. The literal scope token is operator
    // policy — the server just forwards the synthetic path; nothing
    // here hard-codes `control:fan-out`.
    //
    // The synthetic path is ONLY visible to the scope lookup — route
    // dispatch still matches `url.pathname` (the fan-out handling lives
    // inside the route handler, it doesn't get a separate route entry).
    const url = new URL(req.url);
    let routePath: string | undefined;
    for (const route of routes) {
      if (route.path === url.pathname) {
        routePath = route.path;
        break;
      }
    }
    const scopeLookupPath =
      routePath !== undefined && url.searchParams.get('all') === '1'
        ? `${routePath}?all=1`
        : routePath;
    // Auth fires BEFORE route dispatch. Loopback bypass (the default)
    // keeps same-host curls + `declaragent ps` working without a token;
    // a non-loopback request with a bad / missing token gets a typed
    // 401 straight from the middleware. Per-route scope overrides land
    // in the same 401 flow (`insufficient-scope` reason).
    if (auth) {
      const authContext: ControlPlaneAuthContext = {
        ...(ctx?.peerIp !== undefined && { peerIp: ctx.peerIp }),
        ...(scopeLookupPath !== undefined && { routePath: scopeLookupPath }),
      };
      const result = await applyControlPlaneAuth(auth, req, authContext);
      if (!result.ok) return result.response;
    }
    for (const route of routes) {
      if (route.path !== url.pathname) continue;
      const res = await route.fetch(req);
      if (res) return res;
    }
    return new Response('not found', { status: 404 });
  }

  const server = await listen({ port, hostname, fetch });
  let closed = false;
  return {
    port: server.port,
    hostname: server.hostname,
    routes: routes.map((r) => r.path),
    async close() {
      if (closed) return;
      closed = true;
      await server.stop();
    },
  };
}

function assertUniquePaths(routes: readonly ControlPlaneRoute[]): void {
  const seen = new Set<string>();
  for (const r of routes) {
    if (seen.has(r.path)) {
      throw new Error(`control-plane server: duplicate route "${r.path}" — paths must be unique`);
    }
    seen.add(r.path);
  }
}

function isLocalClient(req: Request): boolean {
  // Mirrors `startPrometheusExporter`'s defense-in-depth. When the
  // server binds `127.0.0.1` the socket layer already refuses remote
  // peers; this Host-header check catches the rare forward-proxy
  // case where the peer tunnels through localhost.
  const host = req.headers.get('host');
  if (!host) return true;
  const hostname = host.split(':')[0] ?? '';
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Route paths that legitimately hold a connection open for long
 * periods. Only paths in this set get `idleTimeout = 0` applied by the
 * default Bun listener (POST_ENTERPRISE_BACKLOG.md #21). Adding a new
 * streaming route (e.g. a future `/audit/stream`) means appending its
 * path here so the listener stops aborting its connection at 30s.
 *
 * Exported for testing — production callers should not branch on
 * this directly.
 */
export const STREAMING_ROUTE_PATHS: ReadonlySet<string> = new Set(['/logs']);

/**
 * Default server-level idle timeout in seconds. Short-lived routes
 * (`/metrics`, `/status`, `/events`, `/dlq`, `/audit`) inherit this.
 * Streaming routes (see {@link STREAMING_ROUTE_PATHS}) opt out
 * per-request via `server.timeout(req, 0)`.
 *
 * Exported for testing.
 */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 30;

const defaultListen: NonNullable<ControlPlaneServerOptions['listen']> = async ({
  port,
  hostname,
  fetch,
}) => {
  // biome-ignore lint/suspicious/noExplicitAny: Bun global is not typed in this repo.
  const bun = (globalThis as any).Bun;
  if (!bun || typeof bun.serve !== 'function') {
    throw new Error(
      'control-plane server: Bun.serve not available. Supply an explicit `listen` option in non-Bun hosts.',
    );
  }
  // `Bun.serve` passes the server as the 2nd arg to `fetch`. We use
  // `server.requestIP(req)` to resolve the immediate TCP peer — needed
  // by the auth middleware to evaluate `allowLoopback: { trustedProxies }`.
  //
  // Per-request idle-timeout narrowing (POST_ENTERPRISE_BACKLOG.md #21):
  // Bun's default `idleTimeout` applies to every request, but SSE
  // responses (`/logs`) can legitimately stay open for minutes at a
  // time while the client tails a quiet agent's log. Previously we set
  // `idleTimeout: 0` on the whole server — that disabled connection-
  // abort protection for `/status`, `/events`, `/dlq`, etc. as well.
  //
  // Now the server uses Bun's default short idle timeout and only
  // `/logs` calls `server.timeout(request, 0)` to opt into long-lived
  // streaming. Short-lived JSON routes keep the default cap. We look
  // up the "will this be a streaming route?" decision from the matched
  // route path BEFORE calling `fetch` so the timeout extension is in
  // place before the SSE handler starts pushing frames.
  // biome-ignore lint/suspicious/noExplicitAny: Bun's server handle is untyped here.
  const dispatch = (req: Request, server: any): Promise<Response> | Response => {
    const peer = server?.requestIP?.(req);
    const peerIp: string | undefined =
      peer && typeof peer === 'object' && typeof peer.address === 'string'
        ? peer.address
        : undefined;
    // Scope the "no idle timeout" relaxation to streaming routes only.
    // Today that's just `/logs`, identified by its registered path.
    try {
      const url = new URL(req.url);
      if (STREAMING_ROUTE_PATHS.has(url.pathname) && typeof server?.timeout === 'function') {
        // 0 = disable idle timeout for this one request. Non-streaming
        // routes inherit the server-level default (DEFAULT_IDLE_TIMEOUT_SECONDS).
        server.timeout(req, 0);
      }
    } catch {
      // `new URL` on a malformed request URL would throw; fall through
      // to the default timeout — the route loop's 404 will handle the
      // request shortly.
    }
    return fetch(req, peerIp !== undefined ? { peerIp } : undefined);
  };
  const server = bun.serve({
    port,
    hostname,
    // Default idle timeout (seconds). 30s is enough for a slow audit
    // verify under load but still catches a zombie connection quickly
    // enough that a leak on `/events` paging can't accumulate file
    // descriptors. Long-lived SSE routes extend this per-request via
    // `server.timeout(req, 0)` in `dispatch` above.
    idleTimeout: DEFAULT_IDLE_TIMEOUT_SECONDS,
    fetch: dispatch,
  });
  return {
    port: server.port,
    hostname: server.hostname ?? hostname,
    async stop() {
      await server.stop();
    },
  };
};

// ── Built-in routes ────────────────────────────────────────────────────────

/**
 * `/metrics` — Prometheus text-format scrape.
 *
 * Drop-in replacement for the hand-rolled handler inside
 * {@link startPrometheusExporter}. Produces the same body + headers so
 * existing scrape configs keep working after the `up` daemon switches
 * to {@link startControlPlaneServer}.
 */
export function metricsRoute(
  registry: PrometheusRegistry,
  opts: { path?: string } = {},
): ControlPlaneRoute {
  const path = opts.path ?? '/metrics';
  return {
    path,
    fetch(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' },
        });
      }
      const body = registry.scrape();
      return new Response(req.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    },
  };
}

// ── /status ────────────────────────────────────────────────────────────────

/**
 * JSON body served by the `/status` endpoint. Schema matches
 * CONTROL_PLANE_PLAN.md §6 (`/status`) — one row per agent with its
 * sources, channels, and a small bag of per-agent metrics.
 *
 * Slice 1 is additive: later slices may grow fields on
 * {@link UpAgentStatus} (e.g. builder-mode marker, tenant rollups).
 * Consumers MUST tolerate unknown keys; `version: 1` is a SemVer
 * floor that only breaks on a field removal.
 */
export interface UpStatusSnapshot {
  readonly version: 1;
  /** CLI version that started the `up` daemon, e.g. `"0.6.0"`. */
  readonly cliVersion: string;
  /** PID of the daemon process serving this endpoint. */
  readonly pid: number;
  /** ISO-8601 timestamp of `up` start. */
  readonly startedAt: string;
  /** Absolute path to the `agent.yaml` or `fleet.yaml` driving `up`. */
  readonly manifestPath: string;
  readonly agents: readonly UpAgentStatus[];
}

export interface UpAgentStatus {
  readonly id: string;
  /** Absolute path to the agent directory. */
  readonly path: string;
  /** Uptime in ms since this specific agent's sources bound. */
  readonly uptimeMs: number;
  readonly sources: readonly UpSourceStatus[];
  readonly channels: readonly UpChannelStatus[];
  /** Tiny rollup of the runtime counters most operators want at a glance. */
  readonly metrics: UpAgentMetricsRollup;
  /**
   * Per-agent PID fidelity.
   *
   * Today `declaragent up` hosts every agent in a single process, so
   * every `agents[i].hostedBy.pid` equals the daemon's pid ({@link
   * UpStatusSnapshot.pid}). This field makes that collapsing explicit:
   * a future out-of-process-per-agent topology (or a sidecar runner)
   * can populate a distinct pid per agent without a schema break, and
   * operators can scan for `hostedBy.pid !== snapshot.pid` to find
   * agents running outside the daemon process.
   *
   * `hostedBy.index` is a stable slot number within the daemon process
   * (0..n-1 by agents iteration order) — useful when every agent
   * shares a pid but logs need to correlate with a position.
   *
   * See: docs/POST_ENTERPRISE_BACKLOG.md #45.
   *
   * @since 0.7.2
   */
  readonly hostedBy?: UpAgentHost;
}

/**
 * Describes the process hosting a given agent. See {@link UpAgentStatus.hostedBy}
 * for why this is optional.
 *
 * @since 0.7.2
 */
export interface UpAgentHost {
  /**
   * PID of the hosting process. When multiple agents share one daemon
   * this equals the daemon pid — the field's value is that the
   * collapsing is documented instead of silently assumed.
   */
  readonly pid: number;
  /** Stable slot index within the hosting process (0..n-1). */
  readonly index: number;
}

export interface UpSourceStatus {
  readonly type: string;
  readonly id: string;
  readonly summary: string;
}

export interface UpChannelStatus {
  readonly type: string;
  readonly id: string;
  readonly ready: boolean;
}

export interface UpAgentMetricsRollup {
  readonly eventsDispatched: number;
  readonly eventsRejected: number;
  /** Count of currently-open circuit breakers for this agent. */
  readonly breakerOpen: number;
}

/**
 * Callback shape the `up` daemon supplies. Kept async so future
 * implementations can read live SQLite counters without blocking the
 * I/O thread; the Slice 1 in-memory source builds the snapshot
 * synchronously and wraps it in `Promise.resolve`.
 */
export type UpStatusProvider = () => UpStatusSnapshot | Promise<UpStatusSnapshot>;

export function statusRoute(
  provider: UpStatusProvider,
  opts: { path?: string } = {},
): ControlPlaneRoute {
  const path = opts.path ?? '/status';
  return {
    path,
    async fetch(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return new Response('method not allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' },
        });
      }
      try {
        const snapshot = await provider();
        if (snapshot.version !== 1) {
          // Defensive — a misbehaving provider surfaces here before
          // wire format drifts.
          return jsonError(500, 'invalid status snapshot version');
        }
        const body = JSON.stringify(snapshot);
        return new Response(req.method === 'HEAD' ? null : body, {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonError(500, `status provider failed: ${message}`);
      }
    },
  };
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

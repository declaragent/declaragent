/**
 * Control-plane HTTP auth middleware.
 *
 * Slice 2 (CONTROL_PLANE_PLAN.md §9 PR 2) of `docs/CONTROL_PLANE_PLAN.md`.
 * The 0.7.0 Slice 1 listener shipped in `control-plane-server.ts` serves
 * `/metrics`, `/status`, `/events`, `/dlq`, `/audit`, and `/logs` on a
 * localhost-only socket with zero auth. Slice 2 adds a pluggable Bearer
 * token verifier that fires BEFORE route dispatch, so:
 *
 *   - Remote scrape rigs (Prometheus federations, aggregator CLIs on
 *     other hosts) can authenticate with an OIDC / OAuth2 token.
 *   - Same-host curls + `declaragent ps` keep working out of the box —
 *     requests arriving on the loopback interface bypass auth by default
 *     (`allowLoopback: true`). Zero-trust deployments flip this flag
 *     explicitly.
 *
 * The middleware is transport-agnostic in two directions:
 *
 *   - It does NOT know about OIDC/OAuth2 internals. The verifier is a
 *     single async callable handed in by the CLI wiring, which builds
 *     it on top of `@declaragent/plugin-agent-rpc/auth` so this package
 *     stays free of a plugin dep. That mirrors how `AuthVerifyRegistry`
 *     is assembled for RPC envelopes.
 *   - It does NOT mutate the HTTP `Request` object. When verification
 *     succeeds, we expose the resolved {@link ControlPlanePrincipal} via
 *     the middleware return value — routes that care about the caller
 *     receive it through a separate channel (see §"Principal propagation"
 *     below). The `Request` stays immutable so the route layer's existing
 *     contract doesn't grow a second (optional) parameter.
 *
 * Principal propagation:
 *   Slice 2 does not yet plumb the principal down to individual route
 *   handlers (today's routes are all read-only and don't need caller
 *   identity). The principal is only observable on the middleware
 *   result; a future slice that adds per-route scope overrides or
 *   audit-chain annotation can thread it through via a new
 *   `ControlPlaneRoute.fetch(req, ctx)` overload.
 *
 * @since 0.7.0-slice.2
 */

// ── Public types ───────────────────────────────────────────────────────────

/**
 * Resolved identity attached to a successful auth result. Shape is kept
 * close to the RPC-side `RpcAuthPrincipal` so audit rows produced by
 * either surface can share a schema downstream.
 */
export interface ControlPlanePrincipal {
  /** JWT `sub` claim. Empty string when the token omitted `sub`. */
  readonly subject: string;
  /** JWT `iss` claim. */
  readonly issuer: string;
  /** JWT `aud` claim — may be a single string or an array. */
  readonly audience: string | readonly string[];
  /** Scopes observed in `scope` / `scp`. */
  readonly scopes: readonly string[];
  /** Raw decoded claim set for provider-specific downstream use. */
  readonly claims: Readonly<Record<string, unknown>>;
  /** Provider that verified this token (e.g. `'oidc'`, `'oauth2-client'`). */
  readonly provider: string;
}

/**
 * Typed rejection reasons emitted when auth fails. Mirrors the RPC-side
 * {@link RpcAuthRejectReason} vocabulary so SIEM / audit filters can
 * reuse the same labels. Additive — unknown reasons are coerced into
 * `'bad-signature'` by the middleware.
 *
 * `'untrusted-proxy'` fires when `allowLoopback` is configured with a
 * `trustedProxies` allow-list and the immediate peer is not on it — the
 * request can't be attributed to a real loopback client and is refused
 * before the verifier even runs. See `POST_ENTERPRISE_BACKLOG.md #7`.
 */
export type ControlPlaneAuthRejectReason =
  | 'missing-token'
  | 'malformed-token'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'insufficient-scope'
  | 'idp-unreachable'
  | 'config-error'
  | 'provider-failed'
  | 'untrusted-proxy';

/**
 * Return shape of the verifier callable supplied to the middleware.
 * The verifier is responsible for JWT/JWKS validation; the middleware
 * handles HTTP concerns (header parsing, loopback bypass, 401 body).
 */
export type ControlPlaneTokenVerifyResult =
  | { ok: true; principal: ControlPlanePrincipal }
  | { ok: false; reason: ControlPlaneAuthRejectReason; message: string };

/**
 * Single callable that verifies a raw Bearer token. Passed through to
 * the middleware via {@link ControlPlaneAuth.verifyToken}.
 */
export type ControlPlaneTokenVerifier = (token: string) => Promise<ControlPlaneTokenVerifyResult>;

/**
 * Loopback bypass policy.
 *
 *   - `true`  (the default) — same-host curls + `declaragent ps` bypass
 *     the verifier whenever the `Host` header resolves to localhost.
 *     Matches today's 0.7.0 Slice-2 behaviour.
 *   - `false` — zero-trust localhost. Every request (loopback or not)
 *     MUST carry a token.
 *   - `{ trustedProxies }` — proxy-aware. When the request arrives from
 *     a peer whose IP is in `trustedProxies`, inspect the leftmost
 *     `X-Forwarded-For` hop and treat THAT as the real client IP. If
 *     the XFF-derived IP is loopback, bypass the verifier; otherwise
 *     require a token. Requests from peers NOT in `trustedProxies` are
 *     refused with `untrusted-proxy` regardless of headers — this
 *     closes the "behind nginx, every request looks like 127.0.0.1"
 *     bypass vulnerability.
 *
 * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #7
 */
export type ControlPlaneAllowLoopback =
  | boolean
  | {
      /**
       * IPs permitted to act as a reverse proxy. When the immediate
       * peer matches, the leftmost `X-Forwarded-For` entry is promoted
       * to the "real" peer for loopback evaluation.
       *
       * Values are matched by exact string equality against the
       * peer-IP string the middleware receives (see
       * {@link ControlPlaneAuthContext.peerIp}). IPv4-mapped IPv6 peers
       * (`::ffff:127.0.0.1`) are normalised to their IPv4 form before
       * comparison so `'127.0.0.1'` is sufficient for both transports.
       */
      readonly trustedProxies: readonly string[];
    };

export interface ControlPlaneAuth {
  /** Bearer-token verifier. Fires on every non-loopback request. */
  readonly verifyToken: ControlPlaneTokenVerifier;
  /**
   * Loopback bypass policy. See {@link ControlPlaneAllowLoopback}.
   * Defaults to `true` (back-compat).
   */
  readonly allowLoopback?: ControlPlaneAllowLoopback;
  /**
   * Per-route required-scope overrides. Map of exact request pathname
   * (e.g. `/audit`) to the scope list the principal MUST satisfy to
   * reach that route. Principals missing any required scope get a 401
   * `insufficient-scope` with a detail string naming the mismatched
   * route.
   *
   * When a route is absent from this map, the verifier's own scope
   * enforcement (from the OIDC / OAuth2 peer config) is the only gate
   * — matches today's behaviour (no breaking change).
   *
   * Note: route scopes are checked AFTER the verifier runs. They're an
   * AND on top of whatever scopes the verifier itself required, not a
   * replacement. That keeps the per-route knob additive — an operator
   * can tighten `/audit` to `read:audit` without having to weaken the
   * global `control:read` floor.
   *
   * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #6
   */
  readonly routeScopes?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Middleware result. `ok: true` means route dispatch should proceed;
 * the caller pulls `principal` + `bypassed` off this object for auditing.
 * `ok: false` carries a ready-to-serve {@link Response} — the caller
 * returns it to the client without further wrapping.
 */
export type ControlPlaneAuthResult =
  | {
      ok: true;
      /** `true` when the verifier was skipped via loopback bypass. */
      bypassed: boolean;
      /** Undefined when bypassed, otherwise the resolved identity. */
      principal: ControlPlanePrincipal | undefined;
    }
  | {
      ok: false;
      response: Response;
      reason: ControlPlaneAuthRejectReason;
    };

// ── Middleware runner ──────────────────────────────────────────────────────

/**
 * Per-request context threaded through from the HTTP substrate. Optional
 * so legacy call sites (and unit tests that invoke
 * {@link applyControlPlaneAuth} directly without a live Bun server)
 * still compile. All fields are read-only observations of the transport
 * layer — the middleware never mutates them.
 *
 * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #6 + #7
 */
export interface ControlPlaneAuthContext {
  /**
   * Immediate TCP peer IP, as reported by Bun's `server.requestIP(req)`.
   * `undefined` when the listener can't resolve it (older Bun, unit
   * tests, stub listeners). In that case proxy-aware loopback checks
   * fall back to the legacy Host-header sniff.
   */
  readonly peerIp?: string;
  /**
   * Matched route's exact pathname. Supplied by the server loop after
   * it picks the route but before it invokes the route's `fetch`. Used
   * to look up `routeScopes[routePath]`. Omit for "no route matched
   * yet" (middleware is being invoked before dispatch, e.g. unit tests
   * that just want to check a token).
   */
  readonly routePath?: string;
}

/**
 * Evaluate the middleware against a single request. Returns either a
 * pass (route dispatch should run) or a pre-baked 401 {@link Response}.
 *
 * Contract:
 *   1. Resolve the "effective peer" for loopback evaluation. When
 *      `allowLoopback` is `{ trustedProxies }` and the immediate peer
 *      is on the list, the leftmost X-Forwarded-For IP replaces it;
 *      non-trusted peers presenting XFF headers are refused with
 *      `untrusted-proxy`.
 *   2. If `allowLoopback !== false` AND the effective peer is loopback,
 *      bypass verification unconditionally.
 *   3. Otherwise require `Authorization: Bearer <token>`. Missing /
 *      malformed headers → 401 `missing-token`.
 *   4. Invoke `verifyToken(token)`. Verifier `ok: true` → proceed to
 *      route-scope enforcement. Verifier `ok: false` → 401 with the
 *      verifier's reason code.
 *   5. If a `routeScopes` entry matches the context's `routePath`,
 *      check the principal's scopes against it. Missing any required
 *      scope → 401 `insufficient-scope`.
 *   6. If the verifier throws, surface as `provider-failed` → 401 (never
 *      500). Throwing providers are a config bug; returning 401 matches
 *      the fail-closed RPC-side posture and keeps the server from
 *      leaking stack traces in error bodies.
 *
 * Kept as a free function (not a class) so `startControlPlaneServer`
 * can slot it in with a single `await` before the route loop.
 */
export async function applyControlPlaneAuth(
  auth: ControlPlaneAuth,
  request: Request,
  context: ControlPlaneAuthContext = {},
): Promise<ControlPlaneAuthResult> {
  const allowLoopback = auth.allowLoopback ?? true;

  // Step 1: proxy-aware peer resolution.
  const peerResolution = resolveEffectivePeer(allowLoopback, request, context);
  if (peerResolution.kind === 'reject-untrusted-proxy') {
    return {
      ok: false,
      reason: 'untrusted-proxy',
      response: authError(
        'untrusted-proxy',
        `untrusted proxy "${peerResolution.peerIp}" supplied X-Forwarded-For; refuse to trust`,
      ),
    };
  }

  // Step 2: loopback bypass.
  if (allowLoopback !== false && peerResolution.isLoopback) {
    return { ok: true, bypassed: true, principal: undefined };
  }

  // Step 3: token extraction.
  const token = extractBearerToken(request);
  if (token === undefined) {
    return {
      ok: false,
      reason: 'missing-token',
      response: authError('missing-token', 'Authorization: Bearer <token> required'),
    };
  }

  // Step 4: verify.
  let result: ControlPlaneTokenVerifyResult;
  try {
    result = await auth.verifyToken(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'provider-failed',
      response: authError('provider-failed', `token verifier threw: ${message}`),
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      response: authError(result.reason, result.message),
    };
  }

  // Step 5: per-route scope enforcement.
  const routeScopeCheck = enforceRouteScopes(auth.routeScopes, context.routePath, result.principal);
  if (routeScopeCheck !== undefined) {
    return {
      ok: false,
      reason: 'insufficient-scope',
      response: authError('insufficient-scope', routeScopeCheck),
    };
  }

  return { ok: true, bypassed: false, principal: result.principal };
}

// ── Proxy-aware peer resolution ────────────────────────────────────────────

/**
 * Result of figuring out which IP the middleware should treat as the
 * "real" caller for loopback evaluation. See contract step 1 above.
 */
type PeerResolution =
  | { kind: 'ok'; peerIp: string | undefined; isLoopback: boolean }
  | { kind: 'reject-untrusted-proxy'; peerIp: string };

function resolveEffectivePeer(
  allowLoopback: ControlPlaneAllowLoopback,
  request: Request,
  context: ControlPlaneAuthContext,
): PeerResolution {
  const rawPeer = context.peerIp;
  const normalizedPeer = rawPeer !== undefined ? normaliseIp(rawPeer) : undefined;

  // Proxy-aware path: honour X-Forwarded-For only when the immediate
  // peer is explicitly trusted.
  if (typeof allowLoopback === 'object') {
    const xff = request.headers.get('x-forwarded-for');
    const trusted = allowLoopback.trustedProxies.map(normaliseIp);

    if (xff && xff.trim().length > 0) {
      // Either the peer IP is known + trusted, or the peer is unknown
      // (stub listener). Unknown is strictly safer to reject — we can't
      // vouch for the XFF in that case.
      if (normalizedPeer === undefined || !trusted.includes(normalizedPeer)) {
        return {
          kind: 'reject-untrusted-proxy',
          peerIp: normalizedPeer ?? '<unknown>',
        };
      }
      const leftmost = extractLeftmostXff(xff);
      if (leftmost === undefined) {
        // Malformed XFF from a trusted proxy — fall back to the peer
        // itself. Don't reject; a trusted proxy with a bad header is a
        // proxy-config bug we surface via the normal auth flow.
        return {
          kind: 'ok',
          peerIp: normalizedPeer,
          isLoopback: isLoopbackIp(normalizedPeer) || isLoopbackRequest(request),
        };
      }
      return {
        kind: 'ok',
        peerIp: leftmost,
        isLoopback: isLoopbackIp(leftmost),
      };
    }

    // No XFF → treat the peer as the caller. Reject loopback bypass for
    // an untrusted peer so `{ trustedProxies: [...] }` is strictly
    // tighter than `true` — the operator opted into zero-trust semantics.
    return {
      kind: 'ok',
      peerIp: normalizedPeer,
      isLoopback: normalizedPeer !== undefined ? isLoopbackIp(normalizedPeer) : false,
    };
  }

  // Scalar policy (`true` / `false`). WS2/WS3 security fix: when the real
  // connection peer IP is known, the loopback decision is based on IT — NOT on
  // the `Host` header, which a remote attacker can forge (`Host: 127.0.0.1`) to
  // bypass bearer auth. The Host-header sniff is only the fallback for a stub
  // listener that doesn't plumb `peerIp`. A same-host caller (peerIp =
  // 127.0.0.1) still bypasses as before; a remote caller no longer can.
  return {
    kind: 'ok',
    peerIp: normalizedPeer,
    isLoopback:
      normalizedPeer !== undefined ? isLoopbackIp(normalizedPeer) : isLoopbackRequest(request),
  };
}

/**
 * Strip the leftmost entry out of an `X-Forwarded-For` header value.
 * Returns `undefined` when the header is empty / malformed. Also
 * strips a bracketed IPv6 form.
 */
function extractLeftmostXff(xff: string): string | undefined {
  const first = xff.split(',')[0]?.trim();
  if (!first) return undefined;
  // Strip surrounding brackets for IPv6 (`[::1]` → `::1`).
  const stripped = first.startsWith('[') && first.endsWith(']') ? first.slice(1, -1) : first;
  const normalized = normaliseIp(stripped);
  return normalized.length > 0 ? normalized : undefined;
}

function isLoopbackIp(ip: string): boolean {
  const n = normaliseIp(ip);
  if (n === '127.0.0.1' || n === '::1') return true;
  // 127.0.0.0/8 — any address in this block is loopback.
  return n.startsWith('127.');
}

/**
 * Normalise an IP string for comparison. Strips IPv4-mapped IPv6
 * prefixes (`::ffff:127.0.0.1` → `127.0.0.1`) so operators don't need
 * to enumerate both forms in `trustedProxies`. Trims whitespace.
 */
function normaliseIp(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length);
  }
  return trimmed;
}

// ── Route-scope enforcement ────────────────────────────────────────────────

/**
 * Returns a human-readable detail string when the principal is missing
 * a scope required for `routePath`. Returns `undefined` when the check
 * passes (or doesn't apply).
 */
function enforceRouteScopes(
  routeScopes: ControlPlaneAuth['routeScopes'],
  routePath: string | undefined,
  principal: ControlPlanePrincipal,
): string | undefined {
  if (!routeScopes || routePath === undefined) return undefined;
  const required = routeScopes[routePath];
  if (!required || required.length === 0) return undefined;
  const have = new Set(principal.scopes);
  const missing: string[] = [];
  for (const s of required) {
    if (!have.has(s)) missing.push(s);
  }
  if (missing.length === 0) return undefined;
  return `route "${routePath}" requires scope(s) ${missing.map((s) => `"${s}"`).join(', ')}; principal has [${[...have].join(', ') || '—'}]`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pulls the bearer token out of `Authorization`. Trims but does not
 * lowercase the scheme — matches RFC 6750's "Bearer" case-insensitive
 * check via a regex.
 */
export function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization');
  if (!header) return undefined;
  const match = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
  if (!match) return undefined;
  const token = match[1];
  return token && token.length > 0 ? token : undefined;
}

/**
 * Mirrors the host-sniff used by `control-plane-server.ts` — a Host
 * header is considered loopback when it parses to `localhost`, `127.*`,
 * or `::1`. Absent Host defaults to loopback (matches the server-side
 * default, where Bun.serve on `127.0.0.1` only accepts local peers).
 */
export function isLoopbackRequest(request: Request): boolean {
  const host = request.headers.get('host');
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
 * Produce the 401 body. Shape mirrors `control-plane-routes.ts` 4xx/5xx
 * responses (`{ error: string, reason: string }`) so a remote CLI can
 * switch on `reason` without parsing free-form `error` text.
 */
function authError(reason: ControlPlaneAuthRejectReason, message: string): Response {
  const body = JSON.stringify({ error: message, reason });
  return new Response(body, {
    status: 401,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'www-authenticate': 'Bearer',
    },
  });
}

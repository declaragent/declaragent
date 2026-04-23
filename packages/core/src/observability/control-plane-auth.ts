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
  | 'provider-failed';

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

export interface ControlPlaneAuth {
  /** Bearer-token verifier. Fires on every non-loopback request. */
  readonly verifyToken: ControlPlaneTokenVerifier;
  /**
   * When `true` (the default), requests whose `Host` header resolves to
   * localhost bypass the verifier. Same posture as
   * `startControlPlaneServer`'s `allowRemote: false` default — same-host
   * curls + `declaragent ps` keep working.
   *
   * Operators with a zero-trust localhost policy set `false` and then
   * every request — loopback or not — MUST carry a token.
   */
  readonly allowLoopback?: boolean;
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
 * Evaluate the middleware against a single request. Returns either a
 * pass (route dispatch should run) or a pre-baked 401 {@link Response}.
 *
 * Contract:
 *   1. If `allowLoopback !== false` AND the request's Host header points
 *      at a loopback address, bypass verification unconditionally.
 *   2. Otherwise require `Authorization: Bearer <token>`. Missing /
 *      malformed headers → 401 `missing-token`.
 *   3. Invoke `verifyToken(token)`. Verifier `ok: true` → pass through.
 *      Verifier `ok: false` → 401 with the verifier's reason code.
 *   4. If the verifier throws, surface as `provider-failed` → 401 (never
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
): Promise<ControlPlaneAuthResult> {
  const allowLoopback = auth.allowLoopback ?? true;
  if (allowLoopback && isLoopbackRequest(request)) {
    return { ok: true, bypassed: true, principal: undefined };
  }
  const token = extractBearerToken(request);
  if (token === undefined) {
    return {
      ok: false,
      reason: 'missing-token',
      response: authError('missing-token', 'Authorization: Bearer <token> required'),
    };
  }
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
  return { ok: true, bypassed: false, principal: result.principal };
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

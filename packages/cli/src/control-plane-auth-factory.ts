/**
 * Factory that materialises a {@link ControlPlaneAuth} middleware from
 * a parsed `agent.yaml#controlPlane.auth` block.
 *
 * Sits alongside the Slice 1 RPC-side `buildAuthVerifyRegistry` factory
 * in `@declaragent/plugin-agent-rpc`: both consume the OIDC /
 * OAuth2-Client providers shipped in that package, so the JWT / JWKS
 * verification code is never duplicated. The difference is the
 * transport:
 *
 *   - RPC side verifies a token that arrives on an
 *     {@link AgentRpcEnvelope.auth} block.
 *   - Control-plane side verifies a token that arrives on an HTTP
 *     `Authorization: Bearer <token>` header.
 *
 * To bridge the two we stamp a synthetic envelope whose only populated
 * field is `auth.{kind, token}` and call the provider's `verify`. The
 * provider doesn't inspect envelope content beyond `auth` — see the
 * comment at the top of `packages/plugin-agent-rpc/src/auth/types.ts`
 * ("Providers operate ONLY on RpcAuth").
 *
 * @since 0.7.x — Enterprise Production Plan §3 Item #5 Slice 2
 */

import type { AgentRpcEnvelope, LoadedControlPlaneAuth } from '@declaragent/core';
import type {
  ControlPlaneAuth,
  ControlPlaneAuthRejectReason,
  ControlPlanePrincipal,
  ControlPlaneTokenVerifyResult,
} from '@declaragent/core';
import {
  createOAuth2ClientAuthProvider,
  createOidcAuthProvider,
} from '@declaragent/plugin-agent-rpc';
import type {
  OAuth2ClientPeerConfig,
  OidcPeerConfig,
  RpcAuthRejectReason,
} from '@declaragent/plugin-agent-rpc';

export interface BuildControlPlaneAuthOptions {
  /** Parsed `controlPlane.auth` block. */
  readonly config: LoadedControlPlaneAuth;
  /**
   * Secret resolver — invoked once for `oauth2-client` to pull the
   * client secret out of `clientSecretRef`. Kept as an async callable
   * so callers can plumb the same
   * `createDefaultSecretResolver().resolve` they use for RPC-side auth.
   */
  readonly secrets?: (ref: string) => Promise<string> | string;
  /** Injected clock (ms-epoch). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injected fetch — tests override to simulate IdP behavior. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Build the middleware. Eagerly resolves the OAuth2 client secret
 * (when applicable) so the hot path never touches the secret store.
 *
 * Throws when the config is `oauth2-client` but no `secrets` resolver
 * was supplied, or when the resolver throws.
 */
export async function buildControlPlaneAuth(
  opts: BuildControlPlaneAuthOptions,
): Promise<ControlPlaneAuth> {
  const cfg = opts.config;
  const verifyToken = await buildVerifier(opts);
  return {
    verifyToken,
    ...(cfg.allowLoopback !== undefined && { allowLoopback: cfg.allowLoopback }),
  };
}

async function buildVerifier(
  opts: BuildControlPlaneAuthOptions,
): Promise<ControlPlaneAuth['verifyToken']> {
  const cfg = opts.config;
  if (cfg.provider === 'oidc') {
    const providerOpts: Parameters<typeof createOidcAuthProvider>[0] = {
      token: '',
      ...(opts.fetch !== undefined && { fetch: opts.fetch }),
      ...(opts.now !== undefined && { now: opts.now }),
    };
    const provider = createOidcAuthProvider(providerOpts);
    const peerConfig: OidcPeerConfig = {
      provider: 'oidc',
      issuer: cfg.issuer,
      audience: cfg.audience,
      ...(cfg.jwksUri !== undefined && { jwksUri: cfg.jwksUri }),
      ...(cfg.scopes !== undefined && { scopes: cfg.scopes }),
    };
    return async (token) => {
      const envelope = synthEnvelope('oidc', token);
      const result = await provider.verify(envelope, peerConfig);
      return translate(result, 'oidc');
    };
  }
  // oauth2-client
  if (!opts.secrets) {
    throw new Error(
      'buildControlPlaneAuth: `secrets` resolver is required for oauth2-client — refusing to leave clientSecretRef unresolved.',
    );
  }
  const clientSecret = await opts.secrets(cfg.clientSecretRef);
  const providerOpts: Parameters<typeof createOAuth2ClientAuthProvider>[0] = {
    tokenEndpoint: cfg.tokenEndpoint,
    clientId: cfg.clientId,
    clientSecret,
    ...(cfg.scopes !== undefined && { scopes: cfg.scopes }),
    ...(cfg.audience !== undefined && { audience: cfg.audience }),
    ...(cfg.issuer !== undefined && { expectedIssuer: cfg.issuer }),
    ...(cfg.audience !== undefined && { expectedAudience: cfg.audience }),
    ...(cfg.jwksUri !== undefined && { jwksUri: cfg.jwksUri }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.now !== undefined && { now: opts.now }),
  };
  const provider = createOAuth2ClientAuthProvider(providerOpts);
  // The receive-path verify() consults fields on the peer config —
  // scopes/audience/issuer/jwksUri — not clientSecret. We still pass
  // `clientSecretRef` (opaque string) for symmetry with the RPC-side
  // registry shape; the verifier ignores it.
  const peerConfig: OAuth2ClientPeerConfig = {
    provider: 'oauth2-client',
    tokenEndpoint: cfg.tokenEndpoint,
    clientId: cfg.clientId,
    clientSecretRef: cfg.clientSecretRef,
    ...(cfg.scopes !== undefined && { scopes: cfg.scopes }),
    ...(cfg.audience !== undefined && { audience: cfg.audience }),
    ...(cfg.issuer !== undefined && { issuer: cfg.issuer }),
    ...(cfg.jwksUri !== undefined && { jwksUri: cfg.jwksUri }),
  };
  return async (token) => {
    const envelope = synthEnvelope('oauth2-client', token);
    const result = await provider.verify(envelope, peerConfig);
    return translate(result, 'oauth2-client');
  };
}

/**
 * Build a synthetic envelope that carries only the fields the RPC
 * providers consume on `verify` — `auth.{kind, token}`. Other fields
 * are stubbed with syntactically-valid placeholders (`version: 1`,
 * empty `agent://` URLs) so the envelope passes structural typing
 * without misrepresenting provenance.
 */
function synthEnvelope(kind: 'oidc' | 'oauth2-client', token: string): AgentRpcEnvelope {
  return {
    version: 1,
    kind: 'event',
    messageId: 'control-plane-auth',
    correlationId: 'control-plane-auth',
    from: 'agent://control-plane-client',
    to: 'agent://control-plane-server',
    capability: 'http.authorize',
    payload: null,
    auth: { kind, token },
  };
}

/**
 * Translate the RPC provider's result into the control-plane shape.
 * The two reason vocabularies overlap by design; a couple of RPC-only
 * reasons (`missing-auth`, `wrong-kind`) can never be produced here
 * because we build the envelope ourselves — still mapped defensively.
 */
function translate(
  result: Awaited<ReturnType<ReturnType<typeof createOidcAuthProvider>['verify']>>,
  provider: 'oidc' | 'oauth2-client',
): ControlPlaneTokenVerifyResult {
  if (result.ok) {
    const principal: ControlPlanePrincipal = {
      subject: result.principal.subject,
      issuer: result.principal.issuer,
      audience: result.principal.audience,
      scopes: result.principal.scopes,
      claims: result.principal.claims,
      provider,
    };
    return { ok: true, principal };
  }
  return {
    ok: false,
    reason: translateReason(result.reason),
    message: result.message,
  };
}

function translateReason(reason: RpcAuthRejectReason): ControlPlaneAuthRejectReason {
  switch (reason) {
    case 'missing-auth':
    case 'wrong-kind':
      // Can only happen on malformed synthetic envelope construction.
      return 'config-error';
    case 'missing-claim':
    case 'alg-none':
      return 'malformed-token';
    case 'malformed-token':
    case 'bad-signature':
    case 'expired':
    case 'not-yet-valid':
    case 'wrong-issuer':
    case 'wrong-audience':
    case 'insufficient-scope':
    case 'idp-unreachable':
    case 'config-error':
      return reason;
    default: {
      // Exhaustive fall-through — if a new reason lands, the compiler
      // forces us to decide. Keep the fallback defensive.
      const _exhaustive: never = reason;
      void _exhaustive;
      return 'bad-signature';
    }
  }
}

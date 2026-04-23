/**
 * OAuth2 Client-Credentials {@link RpcAuthProvider}.
 *
 * Fetches a bearer access token via `grant_type=client_credentials` against
 * a configured token endpoint. Signs outbound envelopes with the cached
 * token and refreshes ~30s before `expires_in` expires.
 *
 * Verification shares JWT-over-JWKS semantics with {@link createOidcAuthProvider}
 * — Client-Credentials tokens issued by every modern IdP are JWTs with
 * the same claim set. Configuring the peer with an `oauth2-client` block
 * rather than `oidc` carries one operator-facing difference: the provider
 * knows how to mint its own token, so no external token loader is needed.
 *
 * Token caching: refreshed at `expires_at - refreshSkewSec`. A concurrent
 * `sign()` during refresh awaits the in-flight fetch instead of issuing a
 * second request.
 *
 * @since 1.2.0
 */

import type { AgentRpcEnvelope, RpcAuth } from '@declaragent/core';
import {
  type DecodedJwt,
  type JwkKey,
  JwtError,
  SUPPORTED_ALGS,
  audienceMatches,
  checkTimeClaims,
  decodeJwt,
  extractScopes,
  importJwk,
  verifyJwtSignature,
} from './jwt.js';
import type {
  RpcAuthPeerConfigBase,
  RpcAuthPrincipal,
  RpcAuthProvider,
  RpcAuthVerifyResult,
} from './types.js';

export interface OAuth2ClientPeerConfig extends RpcAuthPeerConfigBase {
  readonly provider: 'oauth2-client';
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** `secret://` reference consumed by an external resolver — raw value at verify time isn't needed receiver-side. */
  readonly clientSecretRef?: string;
  /** JWKS URI used for receive-path JWT verification. */
  readonly jwksUri?: string;
  /** Expected issuer claim. */
  readonly issuer?: string;
  /** Expected audience claim. */
  readonly audience?: string;
  readonly scopes?: readonly string[];
}

export interface CreateOAuth2ClientAuthProviderOptions {
  /** Token endpoint the provider posts to. */
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** Resolved secret value — the config loader passes the already-resolved value. */
  readonly clientSecret: string;
  /** Space-separated or array scopes included in the token request. */
  readonly scopes?: readonly string[];
  /** Audience to request — some IdPs require it (Auth0). */
  readonly audience?: string;
  /** Refresh this many seconds before expiry. Defaults to 30. */
  readonly refreshSkewSec?: number;
  /** Clock-skew window for receive-path JWT verification. Defaults to 60s. */
  readonly clockSkewSec?: number;
  /** Injected clock. */
  readonly now?: () => number;
  /** Injected fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Receive-path only: expected issuer for verify(). */
  readonly expectedIssuer?: string;
  /** Receive-path only: expected audience for verify(). */
  readonly expectedAudience?: string;
  /** Receive-path only: JWKS URI. */
  readonly jwksUri?: string;
  /** Receive-path JWKS cache TTL. Defaults to 5m. */
  readonly jwksCacheTtlMs?: number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

interface JwksCacheEntry {
  readonly fetchedAt: number;
  readonly keys: readonly JwkKey[];
}

const DEFAULT_REFRESH_SKEW_SEC = 30;
const DEFAULT_CLOCK_SKEW_SEC = 60;
const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000;

export function createOAuth2ClientAuthProvider(
  options: CreateOAuth2ClientAuthProviderOptions,
): RpcAuthProvider<OAuth2ClientPeerConfig> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const refreshSkewMs = (options.refreshSkewSec ?? DEFAULT_REFRESH_SKEW_SEC) * 1000;
  const clockSkewSec = options.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;
  const jwksTtlMs = options.jwksCacheTtlMs ?? DEFAULT_JWKS_TTL_MS;

  let cached: CachedToken | undefined;
  let inflight: Promise<CachedToken> | undefined;
  const jwksCache = new Map<string, JwksCacheEntry>();

  async function fetchToken(): Promise<CachedToken> {
    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', options.clientId);
    body.set('client_secret', options.clientSecret);
    if (options.scopes && options.scopes.length > 0) {
      body.set('scope', options.scopes.join(' '));
    }
    if (options.audience) {
      body.set('audience', options.audience);
    }
    let res: Response;
    try {
      res = await fetchImpl(options.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new JwtError(
        'idp-unreachable',
        `token endpoint fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new JwtError(
        'idp-unreachable',
        `token endpoint returned HTTP ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const doc = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    if (!doc || typeof doc.access_token !== 'string') {
      throw new JwtError('malformed-token', 'token endpoint response missing access_token');
    }
    const expiresInSec = typeof doc.expires_in === 'number' ? doc.expires_in : 300;
    const expiresAtMs = now() + expiresInSec * 1000;
    return { token: doc.access_token, expiresAtMs };
  }

  async function currentToken(): Promise<CachedToken> {
    if (cached && cached.expiresAtMs - now() > refreshSkewMs) {
      return cached;
    }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const next = await fetchToken();
        cached = next;
        return next;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  async function fetchJwks(uri: string): Promise<readonly JwkKey[]> {
    const entry = jwksCache.get(uri);
    if (entry && now() - entry.fetchedAt < jwksTtlMs) return entry.keys;
    try {
      const res = await fetchImpl(uri);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = (await res.json()) as { keys?: JwkKey[] };
      const keys = Array.isArray(doc?.keys) ? doc.keys : [];
      jwksCache.set(uri, { fetchedAt: now(), keys });
      return keys;
    } catch (err) {
      throw new JwtError(
        'idp-unreachable',
        `JWKS fetch failed for ${uri}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  function selectKey(keys: readonly JwkKey[], decoded: DecodedJwt): JwkKey | undefined {
    const kid = decoded.header.kid;
    if (typeof kid === 'string' && kid.length > 0) {
      return keys.find((k) => k.kid === kid);
    }
    return keys.length === 1 ? keys[0] : undefined;
  }

  return {
    name: 'oauth2-client',
    async sign(_envelope: AgentRpcEnvelope): Promise<RpcAuth> {
      const tok = await currentToken();
      const auth: RpcAuth =
        options.scopes && options.scopes.length > 0
          ? { kind: 'oauth2-client', token: tok.token, scope: options.scopes.join(' ') }
          : { kind: 'oauth2-client', token: tok.token };
      return auth;
    },
    async verify(
      envelope: AgentRpcEnvelope,
      peerConfig: OAuth2ClientPeerConfig,
    ): Promise<RpcAuthVerifyResult> {
      const auth = envelope.auth;
      if (!auth) {
        return { ok: false, reason: 'missing-auth', message: 'envelope missing auth block' };
      }
      if (auth.kind !== 'oauth2-client') {
        return {
          ok: false,
          reason: 'wrong-kind',
          message: `expected auth.kind "oauth2-client", got "${auth.kind}"`,
        };
      }
      const jwksUri = peerConfig.jwksUri ?? options.jwksUri;
      if (!jwksUri) {
        return {
          ok: false,
          reason: 'config-error',
          message: 'oauth2-client verify requires jwksUri on peerConfig or provider options',
        };
      }
      const expectedIssuer = peerConfig.issuer ?? options.expectedIssuer;
      const expectedAudience = peerConfig.audience ?? options.expectedAudience;
      if (!expectedIssuer || !expectedAudience) {
        return {
          ok: false,
          reason: 'config-error',
          message:
            'oauth2-client verify requires issuer + audience on peerConfig or provider options',
        };
      }

      let decoded: DecodedJwt;
      try {
        decoded = decodeJwt(auth.token);
      } catch (err) {
        return {
          ok: false,
          reason: 'malformed-token',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (decoded.header.alg === 'none' || decoded.header.alg === 'None') {
        return { ok: false, reason: 'alg-none', message: 'alg: none is not accepted' };
      }
      if (!SUPPORTED_ALGS.has(decoded.header.alg)) {
        return {
          ok: false,
          reason: 'malformed-token',
          message: `unsupported alg "${decoded.header.alg}"`,
        };
      }

      if (typeof decoded.claims.iss !== 'string') {
        return { ok: false, reason: 'missing-claim', message: 'claim `iss` is required' };
      }
      if (decoded.claims.aud === undefined) {
        return { ok: false, reason: 'missing-claim', message: 'claim `aud` is required' };
      }
      if (decoded.claims.iss !== expectedIssuer) {
        return {
          ok: false,
          reason: 'wrong-issuer',
          message: `issuer "${decoded.claims.iss}" does not match expected "${expectedIssuer}"`,
        };
      }
      if (!audienceMatches(decoded.claims, expectedAudience)) {
        return {
          ok: false,
          reason: 'wrong-audience',
          message: `audience does not include "${expectedAudience}"`,
        };
      }

      let keys: readonly JwkKey[];
      try {
        keys = await fetchJwks(jwksUri);
      } catch (err) {
        return {
          ok: false,
          reason: 'idp-unreachable',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      let key = selectKey(keys, decoded);
      if (!key) {
        jwksCache.delete(jwksUri);
        try {
          keys = await fetchJwks(jwksUri);
        } catch (err) {
          return {
            ok: false,
            reason: 'idp-unreachable',
            message: err instanceof Error ? err.message : String(err),
          };
        }
        key = selectKey(keys, decoded);
      }
      if (!key) {
        return {
          ok: false,
          reason: 'bad-signature',
          message: `no JWKS key matches kid "${decoded.header.kid ?? '<none>'}"`,
        };
      }

      let sigOk = false;
      try {
        const cryptoKey = await importJwk(key, decoded.header.alg);
        sigOk = await verifyJwtSignature(decoded, cryptoKey);
      } catch (err) {
        return {
          ok: false,
          reason: 'bad-signature',
          message: `signature verify threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!sigOk) {
        return { ok: false, reason: 'bad-signature', message: 'JWT signature did not verify' };
      }

      const timeCheck = checkTimeClaims(decoded.claims, Math.floor(now() / 1000), clockSkewSec);
      if (!timeCheck.ok) {
        const reason =
          timeCheck.code === 'expired'
            ? 'expired'
            : timeCheck.code === 'not-yet-valid'
              ? 'not-yet-valid'
              : 'missing-claim';
        return {
          ok: false,
          reason,
          message: `time-claim check failed: ${timeCheck.code} on ${timeCheck.field}`,
        };
      }

      const scopes = extractScopes(decoded.claims);
      const required = peerConfig.scopes ?? [];
      for (const s of required) {
        if (!scopes.includes(s)) {
          return {
            ok: false,
            reason: 'insufficient-scope',
            message: `missing required scope "${s}"`,
          };
        }
      }

      const sub = typeof decoded.claims.sub === 'string' ? decoded.claims.sub : options.clientId;
      const principal: RpcAuthPrincipal = {
        subject: sub,
        issuer: decoded.claims.iss as string,
        audience: decoded.claims.aud as string | readonly string[],
        scopes,
        claims: decoded.claims as Readonly<Record<string, unknown>>,
      };
      return { ok: true, principal };
    },
  };
}

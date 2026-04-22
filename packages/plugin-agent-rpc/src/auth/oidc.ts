/**
 * OIDC {@link RpcAuthProvider}.
 *
 * On `sign()`, stamps the envelope with an `{ kind: 'oidc', token, keyId? }`
 * block. The token is supplied by the caller — typically a short-lived
 * projected Kubernetes token, a workload-identity-minted JWT, or an
 * operator-provided bearer. This provider deliberately does NOT perform
 * token acquisition; OAuth2 Client-Credentials has its own flow in
 * `./oauth2-client.ts`.
 *
 * On `verify()`, validates the token against a cached JWKS:
 *
 *   1. Decode, reject `alg: none` or any alg outside {@link SUPPORTED_ALGS}.
 *   2. Select the key by `kid` (falls back to the first key when the JWT
 *      header omits `kid` AND the JWKS has exactly one key).
 *   3. WebCrypto signature verify.
 *   4. Issuer claim equals the configured `issuer`.
 *   5. Audience claim contains the configured `audience`.
 *   6. `exp` / `iat` present, within 60s clock-skew.
 *   7. Strict scope check — every scope in `peerConfig.scopes` must be
 *      present in the token's `scope` / `scp` claim.
 *
 * JWKS is fetched on demand with a 5-minute TTL. Fetch failure after the
 * cache has expired is fail-closed (`idp-unreachable`). A fresh cache is
 * reused without retry during the TTL window so a transient IdP blip
 * doesn't take inter-agent traffic down.
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

export interface OidcPeerConfig extends RpcAuthPeerConfigBase {
  readonly provider: 'oidc';
  readonly issuer: string;
  readonly audience: string;
  /** Override JWKS URI. When absent we derive via `/.well-known/openid-configuration`. */
  readonly jwksUri?: string;
  /** Scopes required on incoming tokens. Strict AND semantics. */
  readonly scopes?: readonly string[];
}

export interface CreateOidcAuthProviderOptions {
  /** Bearer token to stamp on outbound envelopes. */
  readonly token: string;
  /** Optional `kid` hint for the receiver when the token header lacks it. */
  readonly keyId?: string;
  /** JWKS cache TTL. Defaults to 5 minutes. */
  readonly jwksCacheTtlMs?: number;
  /** Clock-skew tolerance in seconds. Defaults to 60. */
  readonly clockSkewSec?: number;
  /** Injected clock (ms-epoch). */
  readonly now?: () => number;
  /** Injected fetch — tests override to simulate IdP behavior. */
  readonly fetch?: typeof globalThis.fetch;
}

interface JwksCacheEntry {
  readonly fetchedAt: number;
  readonly keys: readonly JwkKey[];
}

const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_SEC = 60;

export function createOidcAuthProvider(
  options: CreateOidcAuthProviderOptions,
): RpcAuthProvider<OidcPeerConfig> {
  const jwksCache = new Map<string, JwksCacheEntry>();
  const discoveryCache = new Map<string, string>();
  const ttlMs = options.jwksCacheTtlMs ?? DEFAULT_JWKS_TTL_MS;
  const clockSkewSec = options.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function discoverJwksUri(issuer: string): Promise<string> {
    const cached = discoveryCache.get(issuer);
    if (cached) return cached;
    const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetchImpl(url);
    if (!res.ok) {
      throw new JwtError('idp-unreachable', `OIDC discovery ${url} returned HTTP ${res.status}`);
    }
    const doc = (await res.json()) as { jwks_uri?: string; issuer?: string };
    if (!doc || typeof doc.jwks_uri !== 'string') {
      throw new JwtError('idp-unreachable', `OIDC discovery missing jwks_uri: ${url}`);
    }
    if (doc.issuer && doc.issuer !== issuer) {
      throw new JwtError(
        'wrong-issuer',
        `OIDC discovery issuer "${doc.issuer}" does not match configured "${issuer}"`,
      );
    }
    discoveryCache.set(issuer, doc.jwks_uri);
    return doc.jwks_uri;
  }

  async function fetchJwks(uri: string): Promise<readonly JwkKey[]> {
    const cached = jwksCache.get(uri);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      return cached.keys;
    }
    try {
      const res = await fetchImpl(uri);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
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
    // No kid — accept only when JWKS has exactly one key.
    return keys.length === 1 ? keys[0] : undefined;
  }

  function invalidateJwks(uri: string): void {
    jwksCache.delete(uri);
  }

  return {
    name: 'oidc',
    async sign(_envelope: AgentRpcEnvelope): Promise<RpcAuth> {
      const auth: RpcAuth =
        options.keyId !== undefined
          ? { kind: 'oidc', token: options.token, keyId: options.keyId }
          : { kind: 'oidc', token: options.token };
      return auth;
    },
    async verify(
      envelope: AgentRpcEnvelope,
      peerConfig: OidcPeerConfig,
    ): Promise<RpcAuthVerifyResult> {
      const auth = envelope.auth;
      if (!auth) {
        return { ok: false, reason: 'missing-auth', message: 'envelope missing auth block' };
      }
      if (auth.kind !== 'oidc') {
        return {
          ok: false,
          reason: 'wrong-kind',
          message: `expected auth.kind "oidc", got "${auth.kind}"`,
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

      // Required claims: iss + aud (exp/iat validated in checkTimeClaims).
      if (typeof decoded.claims.iss !== 'string') {
        return { ok: false, reason: 'missing-claim', message: 'claim `iss` is required' };
      }
      if (decoded.claims.aud === undefined) {
        return { ok: false, reason: 'missing-claim', message: 'claim `aud` is required' };
      }
      if (decoded.claims.iss !== peerConfig.issuer) {
        return {
          ok: false,
          reason: 'wrong-issuer',
          message: `issuer "${decoded.claims.iss}" does not match peer config "${peerConfig.issuer}"`,
        };
      }
      if (!audienceMatches(decoded.claims, peerConfig.audience)) {
        return {
          ok: false,
          reason: 'wrong-audience',
          message: `audience "${JSON.stringify(decoded.claims.aud)}" does not include "${peerConfig.audience}"`,
        };
      }

      // Resolve JWKS — discovery → JWKS fetch.
      let jwksUri: string;
      try {
        jwksUri = peerConfig.jwksUri ?? (await discoverJwksUri(peerConfig.issuer));
      } catch (err) {
        const code = err instanceof JwtError ? err.code : 'idp-unreachable';
        return {
          ok: false,
          reason: code === 'wrong-issuer' ? 'wrong-issuer' : 'idp-unreachable',
          message: err instanceof Error ? err.message : String(err),
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
        // Rotation-race handling: invalidate + refetch once.
        invalidateJwks(jwksUri);
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

      // Strict scope check — every required scope must be present.
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

      const sub = typeof decoded.claims.sub === 'string' ? decoded.claims.sub : '';
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

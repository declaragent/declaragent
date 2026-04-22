/**
 * RPC authentication provider contracts.
 *
 * Two providers ship with this package:
 *
 *   - `oidc` — validates a bearer JWT against an OIDC issuer's JWKS.
 *     Signs outbound envelopes with a pre-acquired token handed in via
 *     the factory (typical usage: Kubernetes projected token, Workload
 *     Identity, an Okta session token etc.).
 *
 *   - `oauth2-client` — Client-Credentials flow. Fetches + caches an
 *     access token from a token endpoint, auto-refreshes on expiry, and
 *     signs outbound envelopes with it. Receive-path verification is
 *     opaque introspection-free: we accept any well-formed JWT whose
 *     signature validates against the issuer's JWKS and that carries
 *     the required scopes.
 *
 * Providers operate ONLY on {@link RpcAuth} — they don't mutate the
 * envelope body. The canonical sign payload for HMAC (`canonicalizeForSigning`)
 * deliberately excludes `auth`, and the same rule applies here: tokens
 * are bound to the peer + scope, not to envelope content. That keeps the
 * verify path simple and lets an operator rotate tokens without rewriting
 * every in-flight envelope.
 *
 * @since 1.2.0
 */

import type { AgentRpcEnvelope, RpcAuth } from '@declaragent/core';

/**
 * Typed rejection reasons emitted by {@link RpcAuthProvider.verify}. Plumbed
 * through to the `rejected_events` table as the DLQ reason code so
 * operators can filter on a stable vocabulary.
 */
export type RpcAuthRejectReason =
  | 'missing-auth'
  | 'wrong-kind'
  | 'malformed-token'
  | 'bad-signature'
  | 'alg-none'
  | 'missing-claim'
  | 'expired'
  | 'not-yet-valid'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'insufficient-scope'
  | 'idp-unreachable'
  | 'config-error';

export interface RpcAuthPrincipal {
  /** The resolved subject claim (`sub`). */
  readonly subject: string;
  /** The issuer claim (`iss`). */
  readonly issuer: string;
  /** The audience claim (`aud`) — may be a single string or an array. */
  readonly audience: string | readonly string[];
  /** Scopes observed in the token. Whitespace-split `scope` or `scp`. */
  readonly scopes: readonly string[];
  /** Raw decoded claim set for provider-specific downstream use. */
  readonly claims: Readonly<Record<string, unknown>>;
}

export type RpcAuthVerifyResult =
  | { ok: true; principal: RpcAuthPrincipal }
  | { ok: false; reason: RpcAuthRejectReason; message: string };

/**
 * Per-peer verify config. Providers cast this to their own internal shape.
 * Shared shape — carries the `provider` discriminator + scopes both
 * variants honor.
 */
export interface RpcAuthPeerConfigBase {
  readonly provider: 'oidc' | 'oauth2-client';
  readonly scopes?: readonly string[];
}

export interface RpcAuthProvider<Config extends RpcAuthPeerConfigBase = RpcAuthPeerConfigBase> {
  readonly name: Config['provider'];
  /**
   * Produce the {@link RpcAuth} block to stamp onto an outbound envelope.
   * The envelope is passed so providers that bind the token to a specific
   * resource (e.g. DPoP) can read headers / payload; the OIDC/OAuth2
   * providers shipped here don't use it.
   */
  sign(envelope: AgentRpcEnvelope): Promise<RpcAuth>;
  /**
   * Verify an inbound envelope's {@link RpcAuth} block against the peer
   * config. MUST fail closed when the IdP is unreachable — see
   * {@link RpcAuthRejectReason#idp-unreachable}.
   */
  verify(envelope: AgentRpcEnvelope, peerConfig: Config): Promise<RpcAuthVerifyResult>;
  /** Optional teardown hook — close http clients, cancel refresh timers. */
  close?(): Promise<void>;
}

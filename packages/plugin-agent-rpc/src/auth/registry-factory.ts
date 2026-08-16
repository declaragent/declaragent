/**
 * {@link buildAuthVerifyRegistry} — factory that materialises an
 * {@link AuthVerifyRegistry} from a git-tracked `rpc-peers.yaml`.
 *
 * The primitives that ship in this package (`createOidcAuthProvider`,
 * `createOAuth2ClientAuthProvider`) each expect a ready-to-use options
 * object with secrets already resolved. The factory walks each
 * `PeerEntry.auth` block, resolves `clientSecretRef` through the
 * caller's {@link ResolveSecret} hook (typically
 * `createDefaultSecretResolver().resolveRef`), instantiates the
 * matching provider, and indexes them by peer id so the agent-inbox
 * adapter can look up verification providers at decode time.
 *
 * Default-off wiring: `declaragent up` only calls this factory when
 * `agent.yaml#rpc.auth.enabled: true`. Peers without an `auth:` block
 * are skipped (registry returns `undefined` for them), matching the
 * legacy `internal`/`hmac` envelope path.
 *
 * @since 0.7.x — Enterprise Production Plan §3 Item #4
 */

import type { AgentRpcEnvelope, LoadedPeers, PeerAuthConfig, RpcAuth } from '@declaragent/core';
import type { AuthVerifyRegistry } from '../agent-inbox.js';
import { createHmacAuthProvider } from './hmac.js';
import { createOAuth2ClientAuthProvider } from './oauth2-client.js';
import { createOidcAuthProvider } from './oidc.js';
import type { RpcAuthProvider } from './types.js';

/**
 * Callback that resolves a secret reference (e.g. `secret://platform/foo`
 * or `env:FOO`) into a raw string. Matches the `resolveRef` method on
 * `createDefaultSecretResolver` — pass that directly.
 */
export type ResolveSecret = (ref: string) => Promise<string>;

export interface BuildAuthVerifyRegistryOptions {
  /** Loaded `rpc-peers.yaml` (from `loadPeersConfig`). */
  peers: LoadedPeers;
  /**
   * Secret resolver. Invoked for every peer that declares
   * `auth.provider === 'oauth2-client'` to pull the client secret out
   * of `clientSecretRef`. OIDC peers don't carry a secret (tokens are
   * acquired out-of-band) and never hit this callback.
   */
  secrets: ResolveSecret;
  /**
   * Inbound-side token producer for OIDC peers. The OIDC provider
   * still needs a `token` to stamp on outbound envelopes if this
   * registry is also used signer-side — for pure verify-only wiring
   * you can pass `async () => ''` (the token is never consumed by
   * `verify()`).
   *
   * Defaults to a stub that returns an empty string. That's safe for
   * up-daemon boot because the up-loop uses the registry only for
   * inbound verification; the `RequestAgent` outbound tool builds its
   * own signer against `sign()`.
   */
  oidcTokenFor?: (peerId: string) => Promise<string> | string;
  /** Optional injected fetch propagated into every provider. */
  fetch?: typeof globalThis.fetch;
  /** Optional injected clock propagated into every provider. */
  now?: () => number;
}

interface RegistryEntry {
  config: PeerAuthConfig;
  provider: RpcAuthProvider;
}

/**
 * Build the registry. Resolves every `clientSecretRef` eagerly so the
 * hot path in `agent-inbox` never touches the secret provider. When
 * the factory throws, callers should either fail `up` (explicit config
 * error) or fall back to the legacy path.
 */
export async function buildAuthVerifyRegistry(
  opts: BuildAuthVerifyRegistryOptions,
): Promise<AuthVerifyRegistry> {
  const byPeer = new Map<string, RegistryEntry>();
  for (const peer of opts.peers.config.peers) {
    if (!peer.auth) continue;
    const provider = await buildProviderForPeer(peer.agent, peer.auth, opts);
    byPeer.set(peer.agent, { config: peer.auth, provider });
  }
  return {
    resolve(peerId: string) {
      return byPeer.get(peerId);
    },
  };
}

/**
 * WS2 — the sign-side counterpart of {@link buildAuthVerifyRegistry}.
 *
 * Builds one provider per peer that declares an `auth:` block and returns a
 * `signOutbound`-compatible hook that dispatches on the envelope's
 * **destination** (`envelope.to`): the outbound leg to peer B is signed with
 * the credentials this agent shares with B (for HMAC, the pair's shared
 * secret + keyId — the same values B's `rpc-peers.yaml` entry for this agent
 * verifies against). Destinations without an `auth:` block keep the legacy
 * `{kind:'internal'}` stamp, so mixed fleets (some peers strict, some legacy)
 * sign exactly where a verifier expects a signature and nowhere else.
 *
 * Both request and response legs use the same hook — a response to B is just
 * an envelope whose `to` is B.
 *
 * Secrets are resolved eagerly (same policy as the verify factory): a broken
 * `secretRef` fails the build here, at boot, not on the first delegation.
 *
 * @since 0.7.8 — production-readiness WS2 (RELEASE_0_8_0_PLAN.md §B1)
 */
export interface OutboundSigner {
  /** `signOutbound` hook for `createRequestAgentTool` / `createRespondHook`. */
  readonly hook: (envelope: AgentRpcEnvelope) => Promise<RpcAuth>;
  /** How many peers have signable `auth:` blocks (0 → hook is pure legacy). */
  readonly signablePeers: number;
}

export async function buildOutboundSigner(
  opts: BuildAuthVerifyRegistryOptions,
): Promise<OutboundSigner> {
  const byDestination = new Map<string, RpcAuthProvider>();
  for (const peer of opts.peers.config.peers) {
    if (!peer.auth) continue;
    byDestination.set(peer.agent, await buildProviderForPeer(peer.agent, peer.auth, opts));
  }
  return {
    signablePeers: byDestination.size,
    hook: async (envelope: AgentRpcEnvelope): Promise<RpcAuth> => {
      const provider = byDestination.get(envelope.to);
      if (provider === undefined) return { kind: 'internal' };
      return provider.sign(envelope);
    },
  };
}

async function buildProviderForPeer(
  peerId: string,
  auth: PeerAuthConfig,
  opts: BuildAuthVerifyRegistryOptions,
): Promise<RpcAuthProvider> {
  if (auth.provider === 'hmac') {
    // WS2 — resolve the shared secret eagerly so the hot verify path never
    // touches the secret resolver. `secret` never leaves this closure.
    const secret = await opts.secrets(auth.secretRef);
    return createHmacAuthProvider({ secret, keyId: auth.keyId });
  }
  if (auth.provider === 'oidc') {
    const token = opts.oidcTokenFor !== undefined ? await opts.oidcTokenFor(peerId) : '';
    const providerOpts: Parameters<typeof createOidcAuthProvider>[0] = {
      token,
      ...(opts.fetch !== undefined && { fetch: opts.fetch }),
      ...(opts.now !== undefined && { now: opts.now }),
    };
    return createOidcAuthProvider(providerOpts);
  }
  // oauth2-client — resolve the client secret eagerly.
  const clientSecret = await opts.secrets(auth.clientSecretRef);
  const providerOpts: Parameters<typeof createOAuth2ClientAuthProvider>[0] = {
    tokenEndpoint: auth.tokenEndpoint,
    clientId: auth.clientId,
    clientSecret,
    ...(auth.scopes !== undefined && { scopes: auth.scopes }),
    ...(auth.audience !== undefined && { audience: auth.audience }),
    ...(auth.issuer !== undefined && { expectedIssuer: auth.issuer }),
    ...(auth.audience !== undefined && { expectedAudience: auth.audience }),
    ...(auth.jwksUri !== undefined && { jwksUri: auth.jwksUri }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.now !== undefined && { now: opts.now }),
  };
  return createOAuth2ClientAuthProvider(providerOpts);
}

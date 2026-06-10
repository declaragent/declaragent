/**
 * HMAC RPC auth provider (WS2).
 *
 * The zero-infrastructure default for inter-agent envelope auth: a shared
 * secret per peer pair, no IdP/JWKS. The caller signs the canonical envelope
 * (`canonicalizeForSigning`, which deliberately excludes the `auth` block) with
 * HMAC-SHA256; the receiver recomputes and compares in constant time.
 *
 * Before this, the only configurable providers were `oidc` / `oauth2-client`,
 * both requiring external infra, and `RequestAgent` hard-coded
 * `auth:{kind:'internal'}` with no signer — so enabling `rpc.auth` rejected
 * every built-in delegation with `wrong-kind`. This provider closes that gap:
 * with HMAC configured on both sides, signed delegation verifies end-to-end.
 *
 * Key storage: the secret arrives already resolved (via the secrets resolver,
 * e.g. `secret://`/`env:`), never inlined in `rpc-peers.yaml`. `keyId` is a
 * non-secret label for rotation: a receiver can be built with the current key
 * while the doc still advertises the prior keyId during a rollover window.
 */

import { canonicalizeForSigning, hmacSha256Hex, timingSafeEqual } from '@declaragent/core';
import type { AgentRpcEnvelope, RpcAuth } from '@declaragent/core';
import type { RpcAuthPeerConfigBase, RpcAuthProvider, RpcAuthVerifyResult } from './types.js';

/** Per-peer HMAC verify config (the `auth:` block shape in `rpc-peers.yaml`). */
export interface HmacAuthPeerConfig extends RpcAuthPeerConfigBase {
  readonly provider: 'hmac';
  /** Expected key id; an envelope stamped with a different keyId is rejected. */
  readonly keyId: string;
}

export interface CreateHmacAuthProviderOptions {
  /** Shared secret, already resolved from its `secret://`/`env:` ref. */
  readonly secret: string;
  /** Non-secret key id stamped on outbound envelopes + matched on inbound. */
  readonly keyId: string;
}

export function createHmacAuthProvider(
  opts: CreateHmacAuthProviderOptions,
): RpcAuthProvider<HmacAuthPeerConfig> {
  return {
    name: 'hmac',

    async sign(envelope: AgentRpcEnvelope): Promise<RpcAuth> {
      const signature = await hmacSha256Hex(opts.secret, canonicalizeForSigning(envelope));
      return { kind: 'hmac', keyId: opts.keyId, signature };
    },

    async verify(
      envelope: AgentRpcEnvelope,
      peerConfig: HmacAuthPeerConfig,
    ): Promise<RpcAuthVerifyResult> {
      const auth = envelope.auth;
      if (auth === undefined || auth.kind !== 'hmac') {
        return {
          ok: false,
          reason: 'wrong-kind',
          message: `expected hmac auth, got "${auth?.kind ?? 'none'}"`,
        };
      }
      // Reject an envelope signed under a different key id before doing the
      // (more expensive) HMAC — and so a rotated-out key can't be replayed.
      const expectedKeyId = peerConfig.keyId || opts.keyId;
      if (auth.keyId !== expectedKeyId) {
        return {
          ok: false,
          reason: 'bad-signature',
          message: `unexpected keyId "${auth.keyId}" (expected "${expectedKeyId}")`,
        };
      }
      const expected = await hmacSha256Hex(opts.secret, canonicalizeForSigning(envelope));
      if (!timingSafeEqual(expected, auth.signature)) {
        return { ok: false, reason: 'bad-signature', message: 'HMAC signature did not verify' };
      }
      return {
        ok: true,
        principal: {
          subject: auth.keyId,
          issuer: 'hmac',
          audience: [],
          scopes: peerConfig.scopes ?? [],
          claims: {},
        },
      };
    },
  };
}

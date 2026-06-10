import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import { type HmacAuthPeerConfig, createHmacAuthProvider } from './hmac.js';

function baseEnvelope(overrides: Partial<AgentRpcEnvelope> = {}): AgentRpcEnvelope {
  return {
    version: 1,
    kind: 'request',
    messageId: 'm1',
    correlationId: 'c1',
    from: 'agent://concierge',
    to: 'agent://pr-reviewer',
    capability: 'review-pr',
    payload: { pr: 'x' },
    auth: { kind: 'internal' },
    ...overrides,
  } as AgentRpcEnvelope;
}

const PEER_CFG: HmacAuthPeerConfig = { provider: 'hmac', keyId: 'k1' };

describe('createHmacAuthProvider', () => {
  test('sign → verify round-trip succeeds', async () => {
    const p = createHmacAuthProvider({ secret: 's3cret', keyId: 'k1' });
    const env = baseEnvelope();
    const auth = await p.sign(env);
    expect(auth.kind).toBe('hmac');
    if (auth.kind === 'hmac') {
      expect(auth.keyId).toBe('k1');
      expect(auth.signature).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    }
    const signed = { ...env, auth };
    const result = await p.verify(signed, PEER_CFG);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.subject).toBe('k1');
  });

  test('tampering with the payload fails verification', async () => {
    const p = createHmacAuthProvider({ secret: 's3cret', keyId: 'k1' });
    const env = baseEnvelope();
    const auth = await p.sign(env);
    // Mutate the payload AFTER signing.
    const tampered = { ...env, auth, payload: { pr: 'evil' } };
    const result = await p.verify(tampered, PEER_CFG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  test('a different secret (wrong key) fails verification', async () => {
    const signer = createHmacAuthProvider({ secret: 'right', keyId: 'k1' });
    const verifier = createHmacAuthProvider({ secret: 'wrong', keyId: 'k1' });
    const env = baseEnvelope();
    const signed = { ...env, auth: await signer.sign(env) };
    const result = await verifier.verify(signed, PEER_CFG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  test('a mismatched keyId is rejected before HMAC compare', async () => {
    const signer = createHmacAuthProvider({ secret: 's', keyId: 'old-key' });
    const verifier = createHmacAuthProvider({ secret: 's', keyId: 'new-key' });
    const env = baseEnvelope();
    const signed = { ...env, auth: await signer.sign(env) };
    const result = await verifier.verify(signed, { provider: 'hmac', keyId: 'new-key' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('bad-signature');
      expect(result.message).toMatch(/keyId/);
    }
  });

  test('a non-hmac auth block is rejected as wrong-kind', async () => {
    const p = createHmacAuthProvider({ secret: 's', keyId: 'k1' });
    const env = baseEnvelope({ auth: { kind: 'internal' } });
    const result = await p.verify(env, PEER_CFG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong-kind');
  });

  test('signature excludes the auth block (canonical form is stable)', async () => {
    // Signing is over canonicalizeForSigning which omits `auth`, so re-signing
    // an already-signed envelope yields the same signature.
    const p = createHmacAuthProvider({ secret: 's', keyId: 'k1' });
    const env = baseEnvelope();
    const a1 = await p.sign(env);
    const a2 = await p.sign({ ...env, auth: a1 });
    if (a1.kind === 'hmac' && a2.kind === 'hmac') {
      expect(a2.signature).toBe(a1.signature);
    }
  });
});

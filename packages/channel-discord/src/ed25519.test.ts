import { describe, expect, it } from 'bun:test';
import { verifyDiscordSignature } from './ed25519.js';

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += HEX[b >> 4];
    out += HEX[b & 0xf];
  }
  return out;
}

async function generateKeyPair(): Promise<{
  publicKeyHex: string;
  privateKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { publicKeyHex: toHex(new Uint8Array(raw)), privateKey: pair.privateKey };
}

async function sign(privateKey: CryptoKey, timestamp: string, body: Uint8Array): Promise<string> {
  const tsBytes = new TextEncoder().encode(timestamp);
  const messageBuf = new ArrayBuffer(tsBytes.length + body.length);
  const message = new Uint8Array(messageBuf);
  message.set(tsBytes, 0);
  message.set(body, tsBytes.length);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, messageBuf);
  return toHex(new Uint8Array(sig));
}

describe('verifyDiscordSignature', () => {
  it('returns true for a valid signature', async () => {
    const { publicKeyHex, privateKey } = await generateKeyPair();
    const timestamp = '1700000000';
    const body = new TextEncoder().encode('{"type":1}');
    const signatureHex = await sign(privateKey, timestamp, body);
    expect(await verifyDiscordSignature({ publicKeyHex, signatureHex, timestamp, body })).toBe(
      true,
    );
  });

  it('returns false when the body is tampered', async () => {
    const { publicKeyHex, privateKey } = await generateKeyPair();
    const timestamp = '1700000000';
    const signatureHex = await sign(privateKey, timestamp, new TextEncoder().encode('{"type":1}'));
    // Swap one byte.
    const tampered = new TextEncoder().encode('{"type":2}');
    expect(
      await verifyDiscordSignature({
        publicKeyHex,
        signatureHex,
        timestamp,
        body: tampered,
      }),
    ).toBe(false);
  });

  it('returns false when the timestamp is tampered', async () => {
    const { publicKeyHex, privateKey } = await generateKeyPair();
    const body = new TextEncoder().encode('{"type":1}');
    const signatureHex = await sign(privateKey, '1700000000', body);
    expect(
      await verifyDiscordSignature({
        publicKeyHex,
        signatureHex,
        timestamp: '1700000001',
        body,
      }),
    ).toBe(false);
  });

  it('returns false for a signature signed by a different key', async () => {
    const victim = await generateKeyPair();
    const attacker = await generateKeyPair();
    const timestamp = '1700000000';
    const body = new TextEncoder().encode('{"type":1}');
    const sigByAttacker = await sign(attacker.privateKey, timestamp, body);
    expect(
      await verifyDiscordSignature({
        publicKeyHex: victim.publicKeyHex,
        signatureHex: sigByAttacker,
        timestamp,
        body,
      }),
    ).toBe(false);
  });

  it('returns false for malformed hex inputs', async () => {
    const body = new TextEncoder().encode('{}');
    const tests = [
      { publicKeyHex: 'not-hex', signatureHex: 'a'.repeat(128) },
      { publicKeyHex: 'ab', signatureHex: 'a'.repeat(128) }, // too short
      { publicKeyHex: 'a'.repeat(64), signatureHex: 'ZZ' }, // invalid hex
      { publicKeyHex: 'a'.repeat(64), signatureHex: 'a'.repeat(64) }, // sig wrong size
    ];
    for (const args of tests) {
      expect(
        await verifyDiscordSignature({
          publicKeyHex: args.publicKeyHex,
          signatureHex: args.signatureHex,
          timestamp: '1700000000',
          body,
        }),
      ).toBe(false);
    }
  });

  it('accepts uppercase hex', async () => {
    const { publicKeyHex, privateKey } = await generateKeyPair();
    const timestamp = '1700000000';
    const body = new TextEncoder().encode('{}');
    const signatureHex = await sign(privateKey, timestamp, body);
    expect(
      await verifyDiscordSignature({
        publicKeyHex: publicKeyHex.toUpperCase(),
        signatureHex: signatureHex.toUpperCase(),
        timestamp,
        body,
      }),
    ).toBe(true);
  });
});

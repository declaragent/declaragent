/**
 * Ed25519 signature verification for Discord interaction webhooks.
 *
 * Discord signs `timestamp + body` with the application's Ed25519
 * private key; verifiers reconstruct that preimage and run it through
 * the public key. We use Web Crypto's `subtle.verify('Ed25519', ...)`
 * which is available in Node ≥ 18.19 + Bun.
 *
 * The public key is a 32-byte raw Ed25519 key provided by Discord in
 * hex. The signature is 64 bytes, also hex.
 */

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const high = charToNibble(hex.charCodeAt(i * 2));
    const low = charToNibble(hex.charCodeAt(i * 2 + 1));
    if (high < 0 || low < 0) return null;
    out[i] = (high << 4) | low;
  }
  return out;
}

function charToNibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}

export interface VerifyDiscordSignatureArgs {
  /** 64-hex app public key from the Developer Portal. */
  publicKeyHex: string;
  /** 128-hex signature from `X-Signature-Ed25519`. */
  signatureHex: string;
  /** String from `X-Signature-Timestamp`. */
  timestamp: string;
  /** Raw request body bytes. Signing payload is `timestamp + body`. */
  body: Uint8Array;
}

/**
 * Return `true` when `signatureHex` is a valid Ed25519 signature over
 * `timestamp + body` under `publicKeyHex`. Returns `false` for:
 * - malformed hex
 * - wrong-sized key / signature
 * - signature that does not match
 *
 * Never throws on bad input so callers can treat the result as a pure
 * accept/reject signal.
 */
export async function verifyDiscordSignature(args: VerifyDiscordSignatureArgs): Promise<boolean> {
  const pubKey = hexToBytes(args.publicKeyHex);
  if (!pubKey || pubKey.length !== 32) return false;
  const sig = hexToBytes(args.signatureHex);
  if (!sig || sig.length !== 64) return false;
  const tsBytes = new TextEncoder().encode(args.timestamp);
  // Construct the signing preimage (`timestamp + body`) on a dedicated
  // ArrayBuffer. Using an explicit ArrayBuffer satisfies
  // Web Crypto's BufferSource type without a SharedArrayBuffer fallback.
  const messageBuf = new ArrayBuffer(tsBytes.length + args.body.length);
  const message = new Uint8Array(messageBuf);
  message.set(tsBytes, 0);
  message.set(args.body, tsBytes.length);
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      pubKey.buffer as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('Ed25519', key, sig.buffer as ArrayBuffer, messageBuf);
  } catch {
    // Runtimes that don't support Ed25519 in Web Crypto fail here. The
    // adapter never handles a request before verification, so returning
    // false is the right failure mode — the caller responds 401.
    return false;
  }
}

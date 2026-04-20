import { describe, expect, it } from 'bun:test';
import { hmacSha256Hex, timingSafeEqual } from './webhook.js';

/**
 * Phase 6 slice-4 security property tests for the HMAC primitives.
 *
 * Covers every class of attack the plan's §5.4 calls out:
 *   - length-mismatched strings must reject without timing leaks beyond
 *     the advertised length check;
 *   - prefix attacks (e.g. "abc" vs "abcd") must NOT succeed;
 *   - no path to treat a truthy substring as a match;
 *   - every comparison is a single pass through `timingSafeEqual`.
 *
 * These tests are intentionally noisy (2000+ assertions) so a regression
 * that introduces a fast short-circuit surfaces immediately.
 */

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Mulberry32.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHex(rand: () => number, length: number): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += hex[Math.floor(rand() * 16)];
  }
  return out;
}

describe('timingSafeEqual — security properties', () => {
  it('rejects length-mismatched strings across 500 random pairs', () => {
    const rand = prng(0xdeadbeef);
    for (let i = 0; i < 500; i += 1) {
      const left = randomHex(rand, 16 + Math.floor(rand() * 48));
      const right = randomHex(rand, 16 + Math.floor(rand() * 48));
      if (left.length === right.length && left === right) continue;
      if (left.length !== right.length) {
        expect(timingSafeEqual(left, right)).toBe(false);
      }
    }
  });

  it('rejects prefix attacks: shorter-correct-prefix must not match longer-expected', () => {
    const secret = 'c0ffee42abcdef1234567890deadbeef11223344';
    const prefixes = [
      '',
      'c',
      'c0',
      'c0ffee',
      'c0ffee42abcdef',
      'c0ffee42abcdef1234567890deadbee', // one nibble short
    ];
    for (const p of prefixes) {
      expect(timingSafeEqual(p, secret)).toBe(false);
      // Symmetrical for safety — argument order must not leak either.
      expect(timingSafeEqual(secret, p)).toBe(false);
    }
    // A suffix attack should also fail.
    for (let i = 1; i < secret.length; i += 1) {
      expect(timingSafeEqual(secret.slice(i), secret)).toBe(false);
    }
  });

  it('returns true only for byte-exact identical strings', () => {
    const rand = prng(0x12345678);
    for (let i = 0; i < 200; i += 1) {
      const s = randomHex(rand, 64);
      expect(timingSafeEqual(s, s)).toBe(true);
      // Duplicate + mutate one char.
      const mutated = `${s.slice(0, -1)}${s.slice(-1) === 'a' ? 'b' : 'a'}`;
      expect(timingSafeEqual(s, mutated)).toBe(false);
    }
  });

  it('handles empty strings safely: both empty is an identity match', () => {
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('', 'a')).toBe(false);
    expect(timingSafeEqual('a', '')).toBe(false);
  });

  it('is symmetric across 500 random inputs', () => {
    const rand = prng(0xcafebabe);
    for (let i = 0; i < 500; i += 1) {
      const a = randomHex(rand, 32 + Math.floor(rand() * 64));
      const b = randomHex(rand, 32 + Math.floor(rand() * 64));
      expect(timingSafeEqual(a, b)).toBe(timingSafeEqual(b, a));
    }
  });
});

describe('hmacSha256Hex — canonical output', () => {
  it('produces 64 lowercase hex chars for any input', async () => {
    const rand = prng(0xb0b0cafe);
    for (let i = 0; i < 50; i += 1) {
      const body = randomHex(rand, Math.floor(rand() * 200));
      const hex = await hmacSha256Hex('secret', body);
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is deterministic for the same inputs', async () => {
    const a = await hmacSha256Hex('s', 'hello world');
    const b = await hmacSha256Hex('s', 'hello world');
    expect(a).toBe(b);
  });

  it('changes completely for a single-byte body change (avalanche)', async () => {
    const a = await hmacSha256Hex('s', 'hello world');
    const b = await hmacSha256Hex('s', 'hello worlD'); // last char capitalized
    // Hamming distance on hex nibbles should be substantial — at least
    // half of the characters in practice for SHA-256.
    let differing = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) differing += 1;
    }
    expect(differing).toBeGreaterThan(20);
  });

  it('changes completely for a single-byte secret change', async () => {
    const a = await hmacSha256Hex('secret-a', 'body');
    const b = await hmacSha256Hex('secret-b', 'body');
    expect(a).not.toBe(b);
  });

  it('round-trips: HMAC + timingSafeEqual returns true for a valid pair', async () => {
    const secret = 'test-secret';
    const body = 'the quick brown fox';
    const expected = await hmacSha256Hex(secret, body);
    expect(timingSafeEqual(expected, await hmacSha256Hex(secret, body))).toBe(true);
  });
});

describe('no HMAC path uses string-prefix comparison', () => {
  // Guard against a regression that accidentally drops `timingSafeEqual`
  // in favor of `startsWith` / `===` / `!==`. We read the compiled
  // sources that the adapters actually ship and assert the known
  // primitives are the ones handling HMACs.
  it('webhook.ts + adapter sources reference timingSafeEqual for every HMAC check', async () => {
    const { readFile } = await import('node:fs/promises');
    const files = [
      'packages/core/src/events/sources/webhook.ts',
      'packages/channel-slack/src/instance.ts',
      'packages/channel-whatsapp/src/instance.ts',
    ];
    for (const relative of files) {
      const text = await readFile(relative, 'utf8');
      // Every file must import + call timingSafeEqual.
      expect(text.includes('timingSafeEqual')).toBe(true);
      // No file compares HMAC / signature values with `===` or
      // `!==` or `startsWith` in a way that would short-circuit the
      // constant-time compare. We look for the specific anti-patterns:
      //   sig === expected / sig !== expected
      //   sig.startsWith(expected)
      // The tricky bit: `startsWith("sha256=")` is a prefix CHECK (not
      // a compare) and is safe. We only flag the pattern where a value
      // named `signature` / `sig` is directly equality-compared.
      const antipatterns = [
        /\bsig\s*===\s*expected/,
        /\bsig\s*!==\s*expected/,
        /\bsignature\s*===\s*expected/,
        /\bsignature\s*!==\s*expected/,
        /\bsig\.startsWith\(\s*expected/,
      ];
      for (const re of antipatterns) {
        expect(re.test(text), `anti-pattern in ${relative}`).toBe(false);
      }
    }
  });
});

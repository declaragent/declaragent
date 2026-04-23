import { describe, expect, test } from 'bun:test';

import { RPC_ERROR_CODES } from './errors.js';

describe('RPC_ERROR_CODES', () => {
  test('exposes AUTH_REJECTED as a stable wire constant (POST_ENTERPRISE_BACKLOG.md #8)', () => {
    // Historical wire literal — must remain unprefixed for back-compat
    // with 3.0.0 receivers that pattern-match the string. See the JSDoc
    // on `RPC_ERROR_CODES.AUTH_REJECTED` for the rationale.
    expect(RPC_ERROR_CODES.AUTH_REJECTED).toBe('AUTH_REJECTED');
  });

  test('every documented code is a non-empty string', () => {
    for (const [key, value] of Object.entries(RPC_ERROR_CODES)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
      // key should be UPPER_SNAKE_CASE
      expect(key).toBe(key.toUpperCase());
    }
  });

  test('codes are unique', () => {
    const values = Object.values(RPC_ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});

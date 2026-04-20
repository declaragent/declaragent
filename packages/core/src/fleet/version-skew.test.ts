import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '../rpc/envelope.js';
import {
  FLEET_VERSION_ENV,
  FLEET_VERSION_HEADER,
  checkFleetVersionSkew,
  compareFleetVersions,
  injectFleetVersionEnv,
  parseFleetVersion,
  readFleetVersionFromEnv,
  readFleetVersionHeader,
  stampFleetVersionHeader,
} from './version-skew.js';

function mkEnvelope(overrides: Partial<AgentRpcEnvelope> = {}): AgentRpcEnvelope {
  return {
    version: 1,
    kind: 'request',
    messageId: 'm1',
    correlationId: 'c1',
    from: 'agent://concierge',
    to: 'agent://pr-reviewer',
    capability: 'review-pr',
    payload: { prUrl: 'x' },
    ...overrides,
  };
}

describe('parseFleetVersion', () => {
  test('parses the canonical shape', () => {
    const p = parseFleetVersion('v1.2.3-abcdef1');
    expect(p).toEqual({ raw: 'v1.2.3-abcdef1', major: 1, minor: 2, patch: 3, sha: 'abcdef1' });
  });

  test('accepts nosha fallback', () => {
    const p = parseFleetVersion('v0.0.0-nosha');
    expect(p?.sha).toBe('nosha');
  });

  test('returns undefined on a missing leading v', () => {
    expect(parseFleetVersion('1.2.3-abc')).toBeUndefined();
  });

  test('returns undefined on empty sha', () => {
    expect(parseFleetVersion('v1.2.3-')).toBeUndefined();
  });

  test('returns undefined on non-numeric parts', () => {
    expect(parseFleetVersion('vX.2.3-abc')).toBeUndefined();
  });
});

describe('compareFleetVersions', () => {
  test('orders by major → minor → patch, ignoring sha', () => {
    const a = parseFleetVersion('v1.2.0-aaa');
    const b = parseFleetVersion('v1.2.0-bbb');
    const c = parseFleetVersion('v1.2.1-aaa');
    const d = parseFleetVersion('v2.0.0-aaa');
    if (!a || !b || !c || !d) throw new Error('fixture parse failed');
    expect(compareFleetVersions(a, b)).toBe(0);
    expect(compareFleetVersions(a, c)).toBeLessThan(0);
    expect(compareFleetVersions(c, d)).toBeLessThan(0);
    expect(compareFleetVersions(d, c)).toBeGreaterThan(0);
  });
});

describe('stampFleetVersionHeader / readFleetVersionHeader', () => {
  test('adds the header to an envelope without mutating the input', () => {
    const input = mkEnvelope();
    const stamped = stampFleetVersionHeader(input, 'v1.2.0-abc1234');
    expect(stamped.headers?.[FLEET_VERSION_HEADER]).toBe('v1.2.0-abc1234');
    expect(input.headers).toBeUndefined();
  });

  test('preserves existing headers', () => {
    const input = mkEnvelope({ headers: { 'x-trace-id': 't-1' } });
    const stamped = stampFleetVersionHeader(input, 'v1.2.0-abc1234');
    expect(stamped.headers?.['x-trace-id']).toBe('t-1');
    expect(stamped.headers?.[FLEET_VERSION_HEADER]).toBe('v1.2.0-abc1234');
  });

  test('returns the envelope unchanged when version is undefined', () => {
    const input = mkEnvelope();
    expect(stampFleetVersionHeader(input, undefined)).toBe(input);
  });

  test('readFleetVersionHeader extracts the value', () => {
    const envelope = stampFleetVersionHeader(mkEnvelope(), 'v1.2.0-abc1234');
    expect(readFleetVersionHeader(envelope)).toBe('v1.2.0-abc1234');
  });

  test('readFleetVersionHeader returns undefined when absent', () => {
    expect(readFleetVersionHeader(mkEnvelope())).toBeUndefined();
  });
});

describe('checkFleetVersionSkew', () => {
  test('returns `match` when caller == self', () => {
    const r = checkFleetVersionSkew({
      callerVersion: 'v1.2.0-abc',
      selfVersion: 'v1.2.0-def',
    });
    expect(r.status).toBe('match');
  });

  test('returns `older-caller` when caller < self (no min)', () => {
    const r = checkFleetVersionSkew({
      callerVersion: 'v1.1.0-abc',
      selfVersion: 'v1.2.0-abc',
    });
    expect(r.status).toBe('older-caller');
  });

  test('returns `newer-caller` when caller > self', () => {
    const r = checkFleetVersionSkew({
      callerVersion: 'v1.3.0-abc',
      selfVersion: 'v1.2.0-abc',
    });
    expect(r.status).toBe('newer-caller');
  });

  test('returns `rejected` with message when caller < minFleetVersion', () => {
    const r = checkFleetVersionSkew({
      callerVersion: 'v1.0.0-old',
      selfVersion: 'v1.2.0-abc',
      minFleetVersion: 'v1.1.0-cut',
    });
    expect(r.status).toBe('rejected');
    expect(r.message).toContain('v1.0.0');
    expect(r.message).toContain('v1.1.0');
  });

  test('minFleetVersion floor applies even when self is undefined', () => {
    const r = checkFleetVersionSkew({
      callerVersion: 'v1.0.0-old',
      selfVersion: undefined,
      minFleetVersion: 'v1.1.0-cut',
    });
    expect(r.status).toBe('rejected');
  });

  test('caller == minFleetVersion is accepted (>= floor)', () => {
    const r = checkFleetVersionSkew({
      callerVersion: 'v1.1.0-any',
      selfVersion: 'v1.2.0-abc',
      minFleetVersion: 'v1.1.0-cut',
    });
    expect(r.status).toBe('older-caller');
  });

  test('returns `unknown` when header missing', () => {
    const r = checkFleetVersionSkew({
      callerVersion: undefined,
      selfVersion: 'v1.2.0-abc',
    });
    expect(r.status).toBe('unknown');
  });

  test('returns `unknown` when self missing (and no min gate)', () => {
    const r = checkFleetVersionSkew({
      callerVersion: 'v1.2.0-abc',
      selfVersion: undefined,
    });
    expect(r.status).toBe('unknown');
  });

  test('malformed caller header → unknown', () => {
    const r = checkFleetVersionSkew({
      callerVersion: 'not-a-version',
      selfVersion: 'v1.2.0-abc',
    });
    expect(r.status).toBe('unknown');
  });
});

describe('env var helpers', () => {
  test('readFleetVersionFromEnv reads DECLARAGENT_FLEET_VERSION', () => {
    expect(readFleetVersionFromEnv({ [FLEET_VERSION_ENV]: 'v1.2.0-abc' })).toBe('v1.2.0-abc');
  });

  test('readFleetVersionFromEnv returns undefined for empty + missing', () => {
    expect(readFleetVersionFromEnv({})).toBeUndefined();
    expect(readFleetVersionFromEnv({ [FLEET_VERSION_ENV]: '' })).toBeUndefined();
  });

  test('injectFleetVersionEnv returns a new map with the var set', () => {
    const out = injectFleetVersionEnv({ FOO: 'bar' }, 'v1.2.3-abc');
    expect(out).toEqual({ FOO: 'bar', [FLEET_VERSION_ENV]: 'v1.2.3-abc' });
  });
});

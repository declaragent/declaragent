import { describe, expect, test } from 'bun:test';
import { PerTargetRateLimiter, TokenBucket, targetIdentity } from './rate-limiter.js';
import type { EventTarget } from './types.js';

describe('TokenBucket', () => {
  test('starts full at burst, drains tryTake', () => {
    const b = new TokenBucket({ ratePerSec: 10, burst: 5, now: () => 0 });
    expect(b.available()).toBe(5);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });

  test('refills at ratePerSec', () => {
    let t = 0;
    const b = new TokenBucket({ ratePerSec: 10, burst: 5, now: () => t });
    for (let i = 0; i < 5; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    t = 500; // 5 tokens accrue in 500ms at 10/sec
    expect(b.available()).toBeCloseTo(5, 5);
    for (let i = 0; i < 5; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });

  test('refill is capped at burst', () => {
    let t = 0;
    const b = new TokenBucket({ ratePerSec: 10, burst: 3, now: () => t });
    t = 1_000_000; // huge wait — would have refilled to thousands of tokens
    expect(b.available()).toBe(3);
  });

  test('rejects invalid ratePerSec and burst', () => {
    expect(() => new TokenBucket({ ratePerSec: 0 })).toThrow(/ratePerSec/);
    expect(() => new TokenBucket({ ratePerSec: 1, burst: 0 })).toThrow(/burst/);
  });

  test('fractional rate (e.g. 0.5 tokens/sec)', () => {
    let t = 0;
    const b = new TokenBucket({ ratePerSec: 0.5, burst: 1, now: () => t });
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    t = 1000;
    expect(b.tryTake()).toBe(false); // still half a token short
    t = 2000;
    expect(b.tryTake()).toBe(true);
  });
});

describe('targetIdentity', () => {
  test('pulls the right field per target type', () => {
    expect(targetIdentity({ type: 'session', sessionId: 'sX', mode: 'inject' })).toBe('sX');
    expect(targetIdentity({ type: 'skill', name: 'greet', inputs: {} })).toBe('greet');
    expect(targetIdentity({ type: 'sub-agent', parentSessionId: 'p', spec: {} })).toBe('p');
    expect(targetIdentity({ type: 'broadcast' })).toBeUndefined();
    expect(targetIdentity({ type: 'new-session', initialPrompt: 'go' })).toBeUndefined();
  });
});

describe('PerTargetRateLimiter', () => {
  test('allows targets that have no matching rule', () => {
    const l = new PerTargetRateLimiter({
      spec: { byTarget: [{ target: 'skill', id: 'greet', ratePerSec: 1 }] },
    });
    const t: EventTarget = { type: 'broadcast' };
    expect(l.allow(t).allowed).toBe(true);
  });

  test('denies when the rule is exhausted, and allows again after refill', () => {
    let t = 0;
    const l = new PerTargetRateLimiter({
      spec: { byTarget: [{ target: 'skill', ratePerSec: 2, burst: 2 }] },
      now: () => t,
    });
    const tgt: EventTarget = { type: 'skill', name: 'greet', inputs: {} };
    expect(l.allow(tgt).allowed).toBe(true);
    expect(l.allow(tgt).allowed).toBe(true);
    const denied = l.allow(tgt);
    expect(denied.allowed).toBe(false);
    expect(denied.deniedByRule?.target).toBe('skill');
    // Wait 1 second → 2 tokens accrue → 1 more call allowed.
    t = 1000;
    expect(l.allow(tgt).allowed).toBe(true);
    expect(l.allow(tgt).allowed).toBe(true);
    expect(l.allow(tgt).allowed).toBe(false);
  });

  test('id narrowing: a per-session rule only applies to that session', () => {
    const l = new PerTargetRateLimiter({
      spec: {
        byTarget: [{ target: 'session', id: 'hot', ratePerSec: 1, burst: 1 }],
      },
    });
    const hot: EventTarget = { type: 'session', sessionId: 'hot', mode: 'inject' };
    const cool: EventTarget = { type: 'session', sessionId: 'cool', mode: 'inject' };
    expect(l.allow(hot).allowed).toBe(true);
    expect(l.allow(hot).allowed).toBe(false);
    // 'cool' is unaffected because its id doesn't match the rule.
    expect(l.allow(cool).allowed).toBe(true);
    expect(l.allow(cool).allowed).toBe(true);
  });

  test('wildcard target: applies to all targets regardless of type', () => {
    const l = new PerTargetRateLimiter({
      spec: { byTarget: [{ target: '*', ratePerSec: 2, burst: 2 }] },
    });
    expect(l.allow({ type: 'broadcast' }).allowed).toBe(true);
    expect(l.allow({ type: 'session', sessionId: 'a', mode: 'inject' }).allowed).toBe(true);
    expect(l.allow({ type: 'skill', name: 'x', inputs: {} }).allowed).toBe(false);
  });

  test('multiple matching rules: denial on the tightest rule spares the looser buckets', () => {
    const t = 0;
    const l = new PerTargetRateLimiter({
      spec: {
        byTarget: [
          // Tight per-skill rule: 1/sec
          { target: 'skill', id: 'greet', ratePerSec: 1, burst: 1 },
          // Loose wildcard: 100/sec
          { target: '*', ratePerSec: 100, burst: 100 },
        ],
      },
      now: () => t,
    });
    const tgt: EventTarget = { type: 'skill', name: 'greet', inputs: {} };
    expect(l.allow(tgt).allowed).toBe(true);
    // Second hit denied by the tight rule; the wildcard bucket should
    // NOT have been decremented on the denial.
    const denied = l.allow(tgt);
    expect(denied.allowed).toBe(false);
    expect(denied.deniedByRule?.id).toBe('greet');
    const snap = l.snapshot();
    expect(snap['*']).toBeCloseTo(99, 5); // only the first (allowed) call spent a token
  });

  test('snapshot exposes per-bucket available counts', () => {
    const l = new PerTargetRateLimiter({
      spec: {
        byTarget: [
          { target: 'skill', ratePerSec: 5, burst: 5 },
          { target: 'broadcast', ratePerSec: 3, burst: 3 },
        ],
      },
    });
    l.allow({ type: 'skill', name: 'x', inputs: {} });
    l.allow({ type: 'broadcast' });
    const snap = l.snapshot();
    expect(snap.skill).toBeCloseTo(4, 5);
    expect(snap.broadcast).toBeCloseTo(2, 5);
  });
});

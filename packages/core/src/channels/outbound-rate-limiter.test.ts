import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_OUTBOUND_MAX_WAIT_MS,
  OutboundRateLimitTimeoutError,
  OutboundRateLimiter,
} from './outbound-rate-limiter.js';

function makeControllableClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/**
 * Test helper that treats `sleep(ms)` as "advance the clock and resolve"
 * — the real sleep would lock tests to wall time.
 */
function controllableSleep(clock: { advance: (ms: number) => void }) {
  return async (ms: number) => {
    clock.advance(ms);
  };
}

describe('OutboundRateLimiter', () => {
  it('allows unlimited acquire when no rates are configured', async () => {
    const limiter = new OutboundRateLimiter();
    for (let i = 0; i < 100; i++) await limiter.acquire('conv-1');
  });

  it('respects the global rate', async () => {
    const clock = makeControllableClock();
    const limiter = new OutboundRateLimiter({
      globalPerSec: 2,
      globalBurst: 2,
      now: clock.now,
      sleep: controllableSleep(clock),
    });
    await limiter.acquire('c1');
    await limiter.acquire('c1');
    // Bucket is exhausted; next acquire must wait until it refills.
    const start = clock.now();
    await limiter.acquire('c1');
    expect(clock.now()).toBeGreaterThan(start);
    expect(limiter.snapshot().global).toBeLessThan(1);
  });

  it('respects the per-conversation rate independent of the global rate', async () => {
    const clock = makeControllableClock();
    const limiter = new OutboundRateLimiter({
      globalPerSec: 100,
      perConversationPerSec: 1,
      perConversationBurst: 1,
      now: clock.now,
      sleep: controllableSleep(clock),
    });
    await limiter.acquire('conv-a');
    const before = clock.now();
    await limiter.acquire('conv-a');
    expect(clock.now()).toBeGreaterThan(before);
  });

  it('isolates per-conversation buckets', async () => {
    const clock = makeControllableClock();
    const limiter = new OutboundRateLimiter({
      perConversationPerSec: 1,
      perConversationBurst: 1,
      now: clock.now,
      sleep: controllableSleep(clock),
    });
    await limiter.acquire('conv-a');
    const t0 = clock.now();
    // Different conversation — its bucket is full and does not wait.
    await limiter.acquire('conv-b');
    expect(clock.now()).toBe(t0);
  });

  it('throws OutboundRateLimitTimeoutError when wait exceeds maxWaitMs', async () => {
    const clock = makeControllableClock();
    const limiter = new OutboundRateLimiter({
      globalPerSec: 1,
      globalBurst: 1,
      now: clock.now,
      sleep: controllableSleep(clock),
      maxWaitMs: 50,
    });
    await limiter.acquire('conv-x');
    await expect(limiter.acquire('conv-x')).rejects.toBeInstanceOf(OutboundRateLimitTimeoutError);
  });

  it('tags timeout error with the scope that caused it', async () => {
    const clock = makeControllableClock();
    const limiter = new OutboundRateLimiter({
      perConversationPerSec: 1,
      perConversationBurst: 1,
      now: clock.now,
      sleep: controllableSleep(clock),
      maxWaitMs: 20,
    });
    await limiter.acquire('conv-slow');
    try {
      await limiter.acquire('conv-slow');
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(OutboundRateLimitTimeoutError);
      const typed = err as OutboundRateLimitTimeoutError;
      expect(typed.scope).toBe('per-conversation');
      expect(typed.conversationId).toBe('conv-slow');
    }
  });

  it('evicts oldest per-conversation buckets past maxConversationBuckets', async () => {
    const clock = makeControllableClock();
    const limiter = new OutboundRateLimiter({
      perConversationPerSec: 1,
      perConversationBurst: 1,
      maxConversationBuckets: 2,
      now: clock.now,
      sleep: controllableSleep(clock),
    });
    await limiter.acquire('c1');
    await limiter.acquire('c2');
    await limiter.acquire('c3');
    const snap = limiter.snapshot().perConversation;
    expect(Object.keys(snap)).toHaveLength(2);
    expect(snap).not.toHaveProperty('c1');
  });

  it('DEFAULT_OUTBOUND_MAX_WAIT_MS is a reasonable ceiling', () => {
    expect(DEFAULT_OUTBOUND_MAX_WAIT_MS).toBeGreaterThanOrEqual(1000);
  });
});

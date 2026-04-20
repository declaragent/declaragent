import { describe, expect, test } from 'bun:test';
import { ConcurrencyLimiter } from './concurrency.js';

describe('ConcurrencyLimiter', () => {
  test('rejects non-positive max', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow('positive integer');
    expect(() => new ConcurrencyLimiter(-1)).toThrow('positive integer');
    expect(() => new ConcurrencyLimiter(1.5)).toThrow('positive integer');
  });

  test('acquire returns immediately when under max', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const r1 = await limiter.acquire();
    const r2 = await limiter.acquire();
    expect(limiter.currentInflight).toBe(2);
    r1();
    r2();
    expect(limiter.currentInflight).toBe(0);
  });

  test('acquire blocks once max is reached; release wakes the first waiter (FIFO)', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const r1 = await limiter.acquire();

    // r2 and r3 queue behind r1.
    const order: string[] = [];
    const p2 = limiter.acquire().then((release) => {
      order.push('r2');
      return release;
    });
    const p3 = limiter.acquire().then((release) => {
      order.push('r3');
      return release;
    });

    // Let microtasks run; neither promise should resolve yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(limiter.queueDepth).toBe(2);
    expect(limiter.currentInflight).toBe(1);

    r1();
    const r2 = await p2;
    expect(order).toEqual(['r2']);
    expect(limiter.queueDepth).toBe(1);

    r2();
    const r3 = await p3;
    expect(order).toEqual(['r2', 'r3']);
    expect(limiter.queueDepth).toBe(0);
    r3();
    expect(limiter.currentInflight).toBe(0);
  });

  test('release is idempotent (double-call is a no-op)', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const r = await limiter.acquire();
    r();
    r();
    expect(limiter.currentInflight).toBe(0);
  });

  test('holds exactly max slots under contention', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const releases: Array<() => void> = [];
    const peak = { value: 0 };

    const workers = Array.from({ length: 10 }, async () => {
      const release = await limiter.acquire();
      peak.value = Math.max(peak.value, limiter.currentInflight);
      await new Promise((r) => setTimeout(r, 5));
      releases.push(release);
      release();
    });

    await Promise.all(workers);
    expect(peak.value).toBeLessThanOrEqual(3);
  });
});

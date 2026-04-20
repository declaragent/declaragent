import { describe, expect, test } from 'bun:test';
import { runAtRate } from './pacer.js';

describe('runAtRate', () => {
  test('produces the requested total', async () => {
    let ticks = 0;
    const result = await runAtRate({
      ratePerSec: 1000,
      totalMessages: 50,
      onTick: async () => {
        ticks += 1;
      },
    });
    expect(result.produced).toBe(50);
    expect(ticks).toBe(50);
  });

  test('respects the abort signal', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30);
    const result = await runAtRate({
      ratePerSec: 100,
      // No total → runs until aborted.
      totalMessages: -1,
      signal: ctrl.signal,
      onTick: async () => {},
    });
    expect(result.aborted).toBe(true);
    expect(result.produced).toBeGreaterThan(0);
  });

  test('target rate is approximately met over a short run', async () => {
    const target = 200;
    const total = 100;
    const start = Date.now();
    await runAtRate({
      ratePerSec: target,
      totalMessages: total,
      batchSize: 1,
      onTick: async () => {},
    });
    const elapsed = Date.now() - start;
    const expectedMs = (total / target) * 1000;
    // Allow generous slack — CI runners have jittery timing. We just
    // need to confirm we're not running 10x faster (no pacing) or 10x
    // slower (blocked).
    expect(elapsed).toBeGreaterThan(expectedMs * 0.5);
    expect(elapsed).toBeLessThan(expectedMs * 3);
  });
});

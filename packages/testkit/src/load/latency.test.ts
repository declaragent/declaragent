import { describe, expect, test } from 'bun:test';
import { LatencyRecorder } from './latency.js';

describe('LatencyRecorder', () => {
  test('computes avg/min/max/p50/p95/p99 over a deterministic sample', () => {
    const r = new LatencyRecorder();
    for (let i = 1; i <= 100; i++) r.record(i); // 1..100ms
    const s = r.summary();
    expect(r.count).toBe(100);
    expect(s.avg).toBeCloseTo(50.5, 1);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.p50).toBe(51); // nearest-rank: floor(0.5 * 100) = 50 → index 50 in sorted (value 51)
    expect(s.p95).toBe(96);
    expect(s.p99).toBe(100);
  });

  test('empty recorder returns zeros', () => {
    const r = new LatencyRecorder();
    expect(r.summary()).toEqual({ avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 });
  });

  test('reservoir sampling bounds memory while keeping count', () => {
    const r = new LatencyRecorder({ maxSamples: 100 });
    for (let i = 0; i < 10_000; i++) r.record(i);
    expect(r.count).toBe(10_000);
    // The reservoir holds exactly 100 samples — can't assert exact
    // percentiles on a random subset, but min/max must still lie inside
    // the original stream.
    const s = r.summary();
    expect(s.min).toBeGreaterThanOrEqual(0);
    expect(s.max).toBeLessThanOrEqual(9999);
  });
});

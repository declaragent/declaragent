import { describe, expect, test } from 'bun:test';
import { DAEMON_HEARTBEAT_METRIC, startHeartbeat } from './heartbeat.js';
import { createPrometheusRegistry } from './prometheus.js';

function sampleValue(scrape: string, prefix: string): number | undefined {
  for (const line of scrape.split('\n')) {
    if (line.startsWith('#')) continue;
    if (!line.startsWith(prefix)) continue;
    const n = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const METRIC = DAEMON_HEARTBEAT_METRIC.replace(/\./g, '_');

describe('startHeartbeat', () => {
  test('sets the gauge to now-seconds immediately on start', () => {
    const metrics = createPrometheusRegistry();
    const hb = startHeartbeat({
      metrics,
      now: () => 1_700_000_000_000,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    expect(sampleValue(metrics.scrape(), METRIC)).toBe(1_700_000_000);
    hb.stop();
  });

  test('refreshes the gauge on each interval tick', () => {
    const metrics = createPrometheusRegistry();
    let cb: (() => void) | undefined;
    let t = 1_000_000;
    const hb = startHeartbeat({
      metrics,
      now: () => t,
      setIntervalFn: (fn) => {
        cb = fn;
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });
    expect(sampleValue(metrics.scrape(), METRIC)).toBe(1000);
    t = 2_000_000;
    cb?.();
    expect(sampleValue(metrics.scrape(), METRIC)).toBe(2000);
    hb.stop();
  });

  test('stop() clears the timer (idempotent)', () => {
    const metrics = createPrometheusRegistry();
    let cleared = 0;
    const hb = startHeartbeat({
      metrics,
      setIntervalFn: () => 42 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {
        cleared += 1;
      },
    });
    hb.stop();
    hb.stop();
    expect(cleared).toBe(1);
  });
});

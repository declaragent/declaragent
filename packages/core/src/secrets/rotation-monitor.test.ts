import { describe, expect, it } from 'bun:test';
import { type RotationStaleEvent, startRotationMonitor } from './rotation-monitor.js';
import type { SecretMetadata, SecretProvider } from './types.js';

function makeProvider(
  type: SecretProvider['type'],
  metadataMap: Record<string, SecretMetadata>,
): SecretProvider {
  return {
    type,
    name: `${type}-test`,
    async resolve() {
      throw new Error('rotation monitor must never resolve values');
    },
    async metadata(path) {
      const meta = metadataMap[path];
      if (!meta) throw new Error(`unknown path ${path}`);
      return meta;
    },
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const fakeInterval: { fn?: () => void; intervalMs?: number; cleared?: boolean } = {};

describe('startRotationMonitor', () => {
  it('fires warn events for secrets past warnAfterDays', async () => {
    const now = Date.parse('2026-04-18T00:00:00Z');
    const lastRotatedAt = now - 100 * MS_PER_DAY; // 100 days stale
    const stale: RotationStaleEvent[] = [];
    const monitor = startRotationMonitor({
      providers: [makeProvider('vault', { 'kv/data/x': { lastRotatedAt } })],
      watchList: { vault: ['kv/data/x'] },
      warnAfterDays: 90,
      errorAfterDays: 180,
      now: () => now,
      onStale: (e) => stale.push(e),
      setInterval: ((fn: () => void, ms: number) => {
        fakeInterval.fn = fn;
        fakeInterval.intervalMs = ms;
        return { unref: () => {} };
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        fakeInterval.cleared = true;
      }) as unknown as typeof clearInterval,
    });
    await monitor.check();
    expect(stale).toHaveLength(1);
    expect(stale[0]?.severity).toBe('warn');
    expect(stale[0]?.ref).toBe('vault:kv/data/x');
    expect(stale[0]?.ageDays).toBe(100);
    monitor.close();
    expect(fakeInterval.cleared).toBe(true);
  });

  it('escalates to error severity past errorAfterDays', async () => {
    const now = Date.parse('2026-04-18T00:00:00Z');
    const lastRotatedAt = now - 200 * MS_PER_DAY;
    const stale: RotationStaleEvent[] = [];
    const monitor = startRotationMonitor({
      providers: [makeProvider('aws-sm', { 'us-east-1/rotated': { lastRotatedAt } })],
      watchList: { 'aws-sm': ['us-east-1/rotated'] },
      warnAfterDays: 90,
      errorAfterDays: 180,
      now: () => now,
      onStale: (e) => stale.push(e),
      setInterval: ((fn: () => void, ms: number) => {
        fakeInterval.fn = fn;
        fakeInterval.intervalMs = ms;
        return { unref: () => {} };
      }) as unknown as typeof setInterval,
    });
    await monitor.check();
    monitor.close();
    expect(stale).toHaveLength(1);
    expect(stale[0]?.severity).toBe('error');
  });

  it('does not fire when metadata is fresh', async () => {
    const now = Date.parse('2026-04-18T00:00:00Z');
    const stale: RotationStaleEvent[] = [];
    const monitor = startRotationMonitor({
      providers: [
        makeProvider('k8s', {
          'acme/kafka/password': { lastRotatedAt: now - 30 * MS_PER_DAY },
        }),
      ],
      watchList: { k8s: ['acme/kafka/password'] },
      warnAfterDays: 90,
      errorAfterDays: 180,
      now: () => now,
      onStale: (e) => stale.push(e),
      setInterval: ((fn: () => void, ms: number) => {
        fakeInterval.fn = fn;
        fakeInterval.intervalMs = ms;
        return { unref: () => {} };
      }) as unknown as typeof setInterval,
    });
    await monitor.check();
    monitor.close();
    expect(stale).toEqual([]);
  });

  it('fires onError when metadata() throws', async () => {
    const errors: { ref: string; error: Error }[] = [];
    const failing: SecretProvider = {
      type: 'vault',
      name: 'vault-broken',
      async resolve() {
        throw new Error('resolve should not be called');
      },
      async metadata() {
        throw new Error('503 Service Unavailable');
      },
    };
    const monitor = startRotationMonitor({
      providers: [failing],
      watchList: { vault: ['kv/data/x'] },
      onError: (e) => errors.push({ ref: e.ref, error: e.error }),
      setInterval: ((fn: () => void, ms: number) => {
        fakeInterval.fn = fn;
        fakeInterval.intervalMs = ms;
        return { unref: () => {} };
      }) as unknown as typeof setInterval,
    });
    await monitor.check();
    monitor.close();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.ref).toBe('vault:kv/data/x');
    expect(errors[0]?.error.message).toBe('503 Service Unavailable');
  });
});

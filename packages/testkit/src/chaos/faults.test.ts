import { describe, expect, it } from 'bun:test';
import { createEventBus } from '@declaragent/core';
import { createBusHighWatermarkFault } from './faults/bus-high-watermark.js';
import { createClockSkewFault, createMutableClock } from './faults/clock-skew.js';
import { createExpireIdempotencyCacheFault } from './faults/expire-idempotency-cache.js';
import { InMemoryReplicaKiller, createKillReplicaFault } from './faults/kill-replica.js';
import { createNetworkLatencyFault } from './faults/network-latency.js';
import {
  InMemoryBrokerPartitioner,
  createPartitionBrokerFault,
} from './faults/partition-broker.js';
import {
  InMemoryChannelPartitioner,
  createPartitionChannelFault,
} from './faults/partition-channel.js';

describe('createBusHighWatermarkFault', () => {
  it('publishes enough events to cross the high-watermark then drains', async () => {
    const bus = createEventBus();
    let peakInflight = 0;
    bus.subscribe('*', async () => {
      peakInflight = Math.max(peakInflight, bus.inflightCount());
      await new Promise((r) => setTimeout(r, 10));
    });
    const fault = createBusHighWatermarkFault({
      bus,
      highWatermark: 3,
      spacingMs: 1,
    });
    await fault.pressureBus(1.5, 50);
    expect(peakInflight).toBeGreaterThanOrEqual(3);
    // After pressureBus() resolves, the bus is drained.
    expect(bus.inflightCount()).toBe(0);
  });
});

describe('createExpireIdempotencyCacheFault', () => {
  it('clears every registered cache', async () => {
    const calls: string[] = [];
    const fault = createExpireIdempotencyCacheFault({
      caches: [
        {
          clear: () => {
            calls.push('a');
          },
        },
        {
          clear: async () => {
            calls.push('b');
          },
        },
      ],
    });
    await fault.expireIdempotencyCache();
    expect(calls.sort()).toEqual(['a', 'b']);
  });
});

describe('createClockSkewFault + createMutableClock', () => {
  it('shifts the clock during the window and restores afterwards', async () => {
    const clock = createMutableClock(1_000);
    const before = clock.now();
    const fault = createClockSkewFault({ clock });
    const task = fault.clockSkew(500, 20);
    // Allow the setOffset to apply before reading.
    await new Promise((r) => setTimeout(r, 5));
    expect(clock.now()).toBeGreaterThanOrEqual(before + 500);
    await task;
    expect(clock.now()).toBeLessThan(before + 500);
  });
});

describe('createNetworkLatencyFault', () => {
  it('adds latency only while active + only for matching urls', async () => {
    let fetchCalls = 0;
    const baseFetch = (async () => {
      fetchCalls += 1;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const { wrappedFetch, runtime } = createNetworkLatencyFault({ fetch: baseFetch });
    // Fire the fault with a 10ms delay for 50ms on target "slow.example".
    const task = runtime.networkLatency?.('slow.example', 10, 50);
    const before = Date.now();
    await wrappedFetch('https://slow.example/path');
    const elapsed = Date.now() - before;
    expect(elapsed).toBeGreaterThanOrEqual(8);
    expect(fetchCalls).toBe(1);
    // Non-matching url: no delay.
    const unaffectedStart = Date.now();
    await wrappedFetch('https://other.example/path');
    expect(Date.now() - unaffectedStart).toBeLessThan(10);
    await task;
    // After the window, matching urls are no longer delayed.
    const postStart = Date.now();
    await wrappedFetch('https://slow.example/path');
    expect(Date.now() - postStart).toBeLessThan(10);
  });
});

describe('InMemoryReplicaKiller + kill-replica fault', () => {
  it('invokes the replica shutdown hook then forgets the id', async () => {
    const killer = new InMemoryReplicaKiller();
    let shutdownCalls = 0;
    killer.register('replica-1', async () => {
      shutdownCalls += 1;
    });
    const fault = createKillReplicaFault({ killer });
    await fault.killReplica?.('replica-1');
    expect(shutdownCalls).toBe(1);
    await expect(fault.killReplica?.('replica-1')).rejects.toThrow(/unknown replica/);
  });
});

describe('InMemoryBrokerPartitioner + partition-broker fault', () => {
  it('flips the partition flag for the duration then clears', async () => {
    const partitioner = new InMemoryBrokerPartitioner();
    const fault = createPartitionBrokerFault({ partitioner });
    const task = fault.partitionBroker?.('broker-1', 30);
    await new Promise((r) => setTimeout(r, 5));
    expect(partitioner.isPartitioned('broker-1')).toBe(true);
    await task;
    expect(partitioner.isPartitioned('broker-1')).toBe(false);
  });
});

describe('InMemoryChannelPartitioner + partition-channel fault', () => {
  it('behaves the same way for a channel id', async () => {
    const partitioner = new InMemoryChannelPartitioner();
    const fault = createPartitionChannelFault({ partitioner });
    const task = fault.partitionChannel?.('slack-prod', 20);
    await new Promise((r) => setTimeout(r, 2));
    expect(partitioner.isPartitioned('slack-prod')).toBe(true);
    await task;
    expect(partitioner.isPartitioned('slack-prod')).toBe(false);
  });
});

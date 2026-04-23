import { describe, expect, test } from 'bun:test';
import type { ChannelMessageContent } from '@declaragent/core';
import { createMockChannelInstance } from '../channels/mock-channel.js';
import { createChannelLoadHarness, stripSentAtStamp } from './channel.js';

function textPayload(seq: number): ChannelMessageContent {
  return { kind: 'text', text: `hello #${seq}` };
}

describe('createChannelLoadHarness', () => {
  test('drives inbound traffic against every channel and records outbound sends', async () => {
    const telegram = createMockChannelInstance({ id: 'telegram-mock' });
    const slack = createMockChannelInstance({ id: 'slack-mock' });
    const discord = createMockChannelInstance({ id: 'discord-mock' });
    const whatsapp = createMockChannelInstance({ id: 'whatsapp-mock' });

    let clock = 1_000_000;
    const harness = createChannelLoadHarness({
      channels: [telegram, slack, discord, whatsapp],
      conversationsPerChannel: 2,
      eventsPerSec: 10_000,
      totalEvents: 16,
      payload: textPayload,
      now: () => clock++,
    });
    const report = await harness.run();

    expect(report.inboundCount).toBe(16);
    expect(report.outboundCount).toBe(16);
    expect(report.failureCount).toBe(0);
    // Four distinct conversations per channel pair × 4 channels → 2 per channel × 4 = 8 total.
    expect(report.conversations).toBe(8);
    expect(report.p99).toBeGreaterThanOrEqual(0);
    expect(report.avgMs).toBeGreaterThanOrEqual(0);

    // Each channel should have received exactly four outbound sends
    // (16 total / 4 channels round-robin).
    for (const ch of [telegram, slack, discord, whatsapp]) {
      expect(ch.calls.send).toHaveLength(4);
      const firstCall = ch.calls.send[0];
      if (!firstCall) throw new Error('expected a send call');
      expect(firstCall.idempotencyKey.startsWith(`load:${ch.id}:`)).toBe(true);
      if (firstCall.content.kind === 'text') {
        // Stamp prefix is present but strips back to the harness payload.
        expect(stripSentAtStamp(firstCall.content.text).startsWith('hello #')).toBe(true);
      }
    }
  });

  test('latency bucketing uses the injected clock', async () => {
    const mock = createMockChannelInstance({ id: 'latency-mock' });
    let clock = 0;
    const harness = createChannelLoadHarness({
      channels: [mock],
      conversationsPerChannel: 1,
      eventsPerSec: 100_000,
      totalEvents: 4,
      payload: textPayload,
      now: () => {
        // Each call advances the clock by 5ms so inbound→send delta = 5ms
        // (two clock reads bracket the outbound instrumentation).
        clock += 5;
        return clock;
      },
    });

    const report = await harness.run();
    expect(report.inboundCount).toBe(4);
    expect(report.outboundCount).toBe(4);
    expect(report.avgMs).toBeGreaterThan(0);
    expect(report.p99).toBeGreaterThan(0);
  });

  test('records failures without crashing the pacer', async () => {
    const good = createMockChannelInstance({ id: 'good-mock' });
    const bad = createMockChannelInstance({ id: 'bad-mock' });
    // Queue a persistent error on bad so every send throws.
    for (let i = 0; i < 4; i += 1) {
      bad.queueSendOutcome({ kind: 'error', message: 'synthetic' });
    }

    const harness = createChannelLoadHarness({
      channels: [good, bad],
      conversationsPerChannel: 1,
      eventsPerSec: 100_000,
      totalEvents: 4,
      payload: textPayload,
    });

    const report = await harness.run();
    expect(report.inboundCount).toBe(4);
    // Good channel should record 2 outbound sends; bad throws twice.
    expect(good.calls.send.length).toBeGreaterThan(0);
    expect(report.failureCount).toBeGreaterThan(0);
    expect(report.outboundCount + report.failureCount).toBe(4);
  });

  test('rejects invalid config', () => {
    const mock = createMockChannelInstance({ id: 'reject-mock' });
    expect(() =>
      createChannelLoadHarness({
        channels: [],
        conversationsPerChannel: 1,
        eventsPerSec: 10,
        totalEvents: 1,
        payload: textPayload,
      }),
    ).toThrow(/at least one channel/);
    expect(() =>
      createChannelLoadHarness({
        channels: [mock],
        conversationsPerChannel: 0,
        eventsPerSec: 10,
        totalEvents: 1,
        payload: textPayload,
      }),
    ).toThrow(/conversationsPerChannel/);
    expect(() =>
      createChannelLoadHarness({
        channels: [mock],
        conversationsPerChannel: 1,
        eventsPerSec: 0,
        totalEvents: 1,
        payload: textPayload,
      }),
    ).toThrow(/eventsPerSec/);
    expect(() =>
      createChannelLoadHarness({
        channels: [mock],
        conversationsPerChannel: 1,
        eventsPerSec: 10,
        payload: textPayload,
      }),
    ).toThrow(/durationMs or totalEvents/);
  });

  test('stop() aborts a running harness', async () => {
    const mock = createMockChannelInstance({ id: 'abortable' });
    const harness = createChannelLoadHarness({
      channels: [mock],
      conversationsPerChannel: 1,
      eventsPerSec: 1, // slow — we will abort before it completes
      totalEvents: 1000,
      durationMs: 5000,
      payload: textPayload,
    });

    const runPromise = harness.run();
    // Let the pacer produce at least one event, then abort.
    await new Promise((r) => setTimeout(r, 5));
    await harness.stop();
    const report = await runPromise;
    expect(report.inboundCount).toBeLessThan(1000);
  });

  test('double-run throws', async () => {
    const mock = createMockChannelInstance({ id: 'double' });
    const harness = createChannelLoadHarness({
      channels: [mock],
      conversationsPerChannel: 1,
      eventsPerSec: 100_000,
      totalEvents: 1,
      payload: textPayload,
    });
    const p = harness.run();
    await expect(harness.run()).rejects.toThrow(/already in progress/);
    await p;
  });
});

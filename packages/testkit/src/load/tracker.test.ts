import { describe, expect, test } from 'bun:test';
import { type AgentEvent, createEventBus } from '@declaragent/core';
import { LOAD_SENT_HEADER, LOAD_SEQ_HEADER } from './kafka-producer.js';
import { LoadTracker } from './tracker.js';

function loadEvent(seq: number, sent: number, now: number): AgentEvent {
  return {
    id: `evt-${seq}-${now}`,
    kind: 'trigger.fire',
    source: { type: 'self', reason: 'wakeup' },
    target: { type: 'broadcast' },
    timestamp: now,
    payload: {
      headers: {
        [LOAD_SEQ_HEADER]: String(seq),
        [LOAD_SENT_HEADER]: String(sent),
      },
      value: '{}',
    },
    auth: { kind: 'internal' },
  };
}

describe('LoadTracker', () => {
  test('counts processed + unique + records latency', async () => {
    const bus = createEventBus();
    let fakeNow = 100;
    const tracker = new LoadTracker({ bus, expected: 3, now: () => fakeNow });
    tracker.start();

    fakeNow = 150;
    await bus.publish(loadEvent(0, 100, fakeNow));
    fakeNow = 180;
    await bus.publish(loadEvent(1, 120, fakeNow));
    fakeNow = 200;
    await bus.publish(loadEvent(2, 150, fakeNow));

    tracker.stop();
    const r = tracker.report();
    expect(r.processed).toBe(3);
    expect(r.unique).toBe(3);
    expect(r.duplicates).toBe(0);
    expect(r.missing).toBe(0);
    expect(r.latency.max).toBe(60); // (180-120)=60 is the largest
    expect(r.latency.min).toBe(50); // (150-100)=50
  });

  test('detects duplicates without inflating unique', async () => {
    const bus = createEventBus();
    const tracker = new LoadTracker({ bus, expected: 2 });
    tracker.start();
    await bus.publish(loadEvent(0, 100, 150));
    await bus.publish(loadEvent(0, 100, 160)); // duplicate
    await bus.publish(loadEvent(1, 100, 170));
    tracker.stop();
    const r = tracker.report();
    expect(r.processed).toBe(3);
    expect(r.unique).toBe(2);
    expect(r.duplicates).toBe(1);
    expect(r.duplicateExamples).toContain(0);
  });

  test('reports missing sequences', async () => {
    const bus = createEventBus();
    const tracker = new LoadTracker({ bus, expected: 5 });
    tracker.start();
    await bus.publish(loadEvent(0, 100, 110));
    await bus.publish(loadEvent(1, 100, 120));
    await bus.publish(loadEvent(4, 100, 130));
    tracker.stop();
    const r = tracker.report();
    expect(r.unique).toBe(3);
    expect(r.missing).toBe(2);
    expect(r.missingExamples).toEqual([2, 3]);
  });

  test('ignores events without the load-seq header', async () => {
    const bus = createEventBus();
    const tracker = new LoadTracker({ bus, expected: 2 });
    tracker.start();
    await bus.publish({
      id: 'noise',
      kind: 'trigger.fire',
      source: { type: 'self', reason: 'wakeup' },
      target: { type: 'broadcast' },
      timestamp: 0,
      payload: { headers: {}, value: 'noise' },
      auth: { kind: 'internal' },
    });
    await bus.publish(loadEvent(0, 100, 120));
    tracker.stop();
    const r = tracker.report();
    expect(r.processed).toBe(1);
    expect(r.unique).toBe(1);
  });
});

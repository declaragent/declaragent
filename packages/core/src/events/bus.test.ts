import { describe, expect, test } from 'bun:test';
import type { Logger } from '../types/logger.js';
import { createEventBus } from './bus.js';
import type { AgentEvent } from './types.js';

function makeEvent<P>(
  kind: AgentEvent['kind'],
  id: string,
  payload: P,
  extra: Partial<AgentEvent<P>> = {},
): AgentEvent<P> {
  return {
    id,
    kind,
    source: { type: 'self', reason: 'wakeup' },
    target: { type: 'broadcast' },
    timestamp: 0,
    payload,
    auth: { kind: 'internal' },
    ...extra,
  };
}

describe('createEventBus', () => {
  test('delivers a published event to a matching kind subscriber', async () => {
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('user.input', (e) => {
      received.push(e);
    });

    const e = makeEvent('user.input', 'evt-1', { text: 'hi' });
    await bus.publish(e);

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('evt-1');
  });

  test('does not deliver to subscribers of a different kind', async () => {
    const bus = createEventBus();
    let count = 0;
    bus.subscribe('webhook.received', () => {
      count++;
    });
    await bus.publish(makeEvent('file.changed', 'evt-1', {}));
    expect(count).toBe(0);
  });

  test('wildcard subscribers receive every kind', async () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe('*', (e) => {
      seen.push(e.kind);
    });
    await bus.publish(makeEvent('user.input', 'evt-1', {}));
    await bus.publish(makeEvent('trigger.fire', 'evt-2', {}));
    expect(seen).toEqual(['user.input', 'trigger.fire']);
  });

  test('wildcard and kind subscribers both fire for the same event', async () => {
    const bus = createEventBus();
    const hits: string[] = [];
    bus.subscribe('file.changed', () => {
      hits.push('kind');
    });
    bus.subscribe('*', () => {
      hits.push('wild');
    });
    await bus.publish(makeEvent('file.changed', 'evt-1', {}));
    expect(hits.sort()).toEqual(['kind', 'wild']);
  });

  test('unsubscribe stops future delivery without affecting peers', async () => {
    const bus = createEventBus();
    let a = 0;
    let b = 0;
    const offA = bus.subscribe('user.input', () => {
      a++;
    });
    bus.subscribe('user.input', () => {
      b++;
    });
    await bus.publish(makeEvent('user.input', 'evt-1', {}));
    offA();
    await bus.publish(makeEvent('user.input', 'evt-2', {}));
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  test('unsubscribe on a wildcard subscriber detaches only that one', async () => {
    const bus = createEventBus();
    let x = 0;
    let y = 0;
    const offX = bus.subscribe('*', () => {
      x++;
    });
    bus.subscribe('*', () => {
      y++;
    });
    await bus.publish(makeEvent('user.input', 'evt-1', {}));
    offX();
    await bus.publish(makeEvent('user.input', 'evt-2', {}));
    expect(x).toBe(1);
    expect(y).toBe(2);
  });

  test('a throwing subscriber does not prevent others from running', async () => {
    const logs: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn(event) {
        logs.push(event);
      },
      error() {},
      child() {
        return logger;
      },
    };
    const bus = createEventBus({ logger });
    let downstream = 0;
    bus.subscribe('user.input', () => {
      throw new Error('boom');
    });
    bus.subscribe('user.input', () => {
      downstream++;
    });
    await bus.publish(makeEvent('user.input', 'evt-1', {}));
    expect(downstream).toBe(1);
    expect(logs).toContain('event.subscriber.error');
  });

  test('a slow subscriber does not block faster peers from completing', async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.subscribe('user.input', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    bus.subscribe('user.input', () => {
      order.push('fast');
    });
    await bus.publish(makeEvent('user.input', 'evt-1', {}));
    // `fast` was pushed first because the slow handler awaited before pushing.
    expect(order).toEqual(['fast', 'slow']);
  });

  test('recent() returns events in publish order', async () => {
    const bus = createEventBus();
    await bus.publish(makeEvent('user.input', 'a', {}));
    await bus.publish(makeEvent('user.input', 'b', {}));
    await bus.publish(makeEvent('user.input', 'c', {}));
    expect(bus.recent().map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('recent() applies the filter predicate', async () => {
    const bus = createEventBus();
    await bus.publish(makeEvent('user.input', 'a', {}));
    await bus.publish(makeEvent('trigger.fire', 'b', {}));
    await bus.publish(makeEvent('user.input', 'c', {}));
    const users = bus.recent((e) => e.kind === 'user.input');
    expect(users.map((e) => e.id)).toEqual(['a', 'c']);
  });

  test('recent() evicts oldest when buffer is full', async () => {
    const bus = createEventBus({ recentBufferSize: 3 });
    await bus.publish(makeEvent('user.input', 'a', {}));
    await bus.publish(makeEvent('user.input', 'b', {}));
    await bus.publish(makeEvent('user.input', 'c', {}));
    await bus.publish(makeEvent('user.input', 'd', {}));
    expect(bus.recent().map((e) => e.id)).toEqual(['b', 'c', 'd']);
  });

  test('recent() returns a snapshot that does not reflect future publishes', async () => {
    const bus = createEventBus();
    await bus.publish(makeEvent('user.input', 'a', {}));
    const snap = bus.recent();
    await bus.publish(makeEvent('user.input', 'b', {}));
    expect(snap.map((e) => e.id)).toEqual(['a']);
  });

  test('drained() resolves immediately when bus is idle', async () => {
    const bus = createEventBus();
    await bus.drained();
    // If we got here, it resolved. Sanity-check with a timeout race.
    const done = Promise.race([
      bus.drained().then(() => 'drained' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 50)),
    ]);
    expect(await done).toBe('drained');
  });

  test('drained() waits for in-flight publishes to settle', async () => {
    const bus = createEventBus();
    let resolved = false;
    bus.subscribe('user.input', async () => {
      await new Promise((r) => setTimeout(r, 25));
      resolved = true;
    });
    // Intentionally do not await; start the publish and race drained().
    const pub = bus.publish(makeEvent('user.input', 'evt-1', {}));
    await bus.drained();
    expect(resolved).toBe(true);
    await pub; // belt and suspenders
  });

  test('publish resolves even with zero subscribers', async () => {
    const bus = createEventBus();
    await bus.publish(makeEvent('self.wakeup', 'evt-1', {}));
    expect(bus.recent()).toHaveLength(1);
  });

  test('subscribing during publish does not affect the current fan-out', async () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe('user.input', () => {
      // Attempt to hijack: subscribe a second time mid-flight.
      bus.subscribe('user.input', () => {
        seen.push('late');
      });
      seen.push('first');
    });
    await bus.publish(makeEvent('user.input', 'evt-1', {}));
    expect(seen).toEqual(['first']);
    // On the next publish, the late subscriber is active.
    await bus.publish(makeEvent('user.input', 'evt-2', {}));
    expect(seen).toEqual(['first', 'first', 'late']);
  });
});

describe('EventBus pressure listeners', () => {
  test('fires onHigh / onLow edge-triggered across a load spike', async () => {
    const bus = createEventBus();
    const events: string[] = [];
    // Slow subscriber — lets us accumulate in-flight publishes.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    bus.subscribe('*', async () => {
      await gate;
    });
    bus.registerPressureListener({
      highWatermark: 2,
      lowWatermark: 1,
      onHigh: (n) => events.push(`high:${n}`),
      onLow: (n) => events.push(`low:${n}`),
    });

    // Kick off 3 publishes concurrently — inflight reaches 3 > high=2.
    const p1 = bus.publish(makeEvent('user.input', 'a', {}));
    const p2 = bus.publish(makeEvent('user.input', 'b', {}));
    const p3 = bus.publish(makeEvent('user.input', 'c', {}));
    // Give the synchronous publish portion a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(['high:2']); // fires once on the second publish; third doesn't re-fire

    release();
    await Promise.all([p1, p2, p3]);
    // inflight drops back to <= low=1 — fires once on that crossing.
    expect(events).toEqual(['high:2', 'low:1']);
  });

  test('rejects invalid watermark combinations', () => {
    const bus = createEventBus();
    expect(() =>
      bus.registerPressureListener({
        highWatermark: 1,
        lowWatermark: 2,
        onHigh() {},
        onLow() {},
      }),
    ).toThrow(/lowWatermark/);
    expect(() =>
      bus.registerPressureListener({
        highWatermark: 0,
        lowWatermark: 0,
        onHigh() {},
        onLow() {},
      }),
    ).toThrow(/highWatermark/);
  });

  test('unsubscribe stops further notifications', async () => {
    const bus = createEventBus();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    bus.subscribe('*', async () => {
      await gate;
    });
    const events: string[] = [];
    const off = bus.registerPressureListener({
      highWatermark: 1,
      lowWatermark: 0,
      onHigh: () => events.push('high'),
      onLow: () => events.push('low'),
    });
    off(); // unregister before any pressure builds

    const p = bus.publish(makeEvent('user.input', 'a', {}));
    await new Promise((r) => setTimeout(r, 0));
    release();
    await p;
    expect(events).toEqual([]);
  });

  test('inflightCount reflects the live count', async () => {
    const bus = createEventBus();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    bus.subscribe('*', async () => {
      await gate;
    });
    expect(bus.inflightCount()).toBe(0);
    const p1 = bus.publish(makeEvent('user.input', 'a', {}));
    const p2 = bus.publish(makeEvent('user.input', 'b', {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(bus.inflightCount()).toBe(2);
    release();
    await Promise.all([p1, p2]);
    expect(bus.inflightCount()).toBe(0);
  });
});

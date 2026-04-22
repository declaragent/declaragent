import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createEventBus } from './bus.js';
import { requeue } from './dlq.js';
import { createEventStore } from './store.js';
import type { AgentEvent } from './types.js';

function makeEvent(id: string): AgentEvent {
  return {
    id,
    kind: 'trigger.fire',
    source: { type: 'self', reason: 'retry' },
    target: { type: 'skill', name: 'do-thing', inputs: {} },
    timestamp: Date.now(),
    payload: { hello: 'world' },
    auth: { kind: 'internal' },
  };
}

function memDb(): Database {
  return new Database(':memory:', { create: true });
}

describe('requeue', () => {
  test('publishes the event and deletes the DLQ row on success', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    const bus = createEventBus();

    const event = makeEvent('evt-1');
    await store.record(event);
    await store.upsertRejection('evt-1', 'circuit-open', 'breaker tripped');

    const seen: AgentEvent[] = [];
    bus.subscribe('*', async (e) => {
      seen.push(e);
    });

    const result = await requeue({ store, bus, eventId: 'evt-1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventId).toBe('evt-1');
      expect(result.attemptsBeforeRequeue).toBe(1);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe('evt-1');
    expect(await store.getRejection('evt-1')).toBeUndefined();

    db.close();
  });

  test('returns dlq-miss when the event is not in the rejections table', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    const bus = createEventBus();

    const result = await requeue({ store, bus, eventId: 'never-rejected' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('dlq-miss');
    }

    db.close();
  });

  test('returns event-miss when rejection exists but the event body is vacuumed', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    const bus = createEventBus();

    await store.upsertRejection('ghost-event', 'rate-limit', undefined);

    const result = await requeue({ store, bus, eventId: 'ghost-event' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('event-miss');
    }

    db.close();
  });

  test('second call for the same id returns dlq-miss (idempotent, no duplicate publish)', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    const bus = createEventBus();

    const event = makeEvent('evt-2');
    await store.record(event);
    await store.upsertRejection('evt-2', 'no-handler', undefined);

    const seen: AgentEvent[] = [];
    bus.subscribe('*', async (e) => {
      seen.push(e);
    });

    const first = await requeue({ store, bus, eventId: 'evt-2' });
    const second = await requeue({ store, bus, eventId: 'evt-2' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('dlq-miss');
    }
    // Critical: the second call MUST NOT have republished.
    expect(seen).toHaveLength(1);

    db.close();
  });

  test('carries the attempt count from the rejection row', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    const bus = createEventBus();

    const event = makeEvent('evt-3');
    await store.record(event);
    // Three rejections before requeue.
    await store.upsertRejection('evt-3', 'circuit-open', undefined);
    await store.upsertRejection('evt-3', 'circuit-open', undefined);
    await store.upsertRejection('evt-3', 'circuit-open', 'still tripping');

    const result = await requeue({ store, bus, eventId: 'evt-3' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attemptsBeforeRequeue).toBe(3);
    }

    db.close();
  });
});

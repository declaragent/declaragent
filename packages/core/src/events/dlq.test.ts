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
      // Re-dispatched under a FRESH id (the old same-id behavior was deduped
      // away → a no-op). The new id carries lineage back to the original.
      expect(result.newEventId).not.toBe('evt-1');
      expect(seen[0]?.id).toBe(result.newEventId);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).not.toBe('evt-1');
    expect(seen[0]?.meta?.causedBy).toBe('evt-1');
    expect(await store.getRejection('evt-1')).toBeUndefined();

    db.close();
  });

  test('requeued event actually routes through a deduping dispatcher (not a no-op)', async () => {
    // Regression for the reproduced blocker: re-publishing the same id made the
    // dispatcher reject it as a duplicate before routing. With a fresh id +
    // dropped idempotency key, the re-dispatch executes.
    const db = memDb();
    const store = createEventStore({ db });
    const bus = createEventBus();

    // Original event was already recorded + seen, with an app idempotency key.
    const event: AgentEvent = {
      ...makeEvent('evt-dup'),
      meta: { idempotencyKey: 'delivery-123' },
    };
    await store.record(event);
    await store.upsertRejection('evt-dup', 'circuit-open', 'tripped');

    // Simulate the dispatcher's dedup: anything whose id OR idempotency key was
    // already seen is dropped. The requeued clone must dodge BOTH.
    const seenIds = new Set<string>(['evt-dup']);
    const seenKeys = new Set<string>(['delivery-123']);
    const executed: string[] = [];
    const dispatch = async (e: AgentEvent) => {
      if (seenIds.has(e.id) || (e.meta?.idempotencyKey && seenKeys.has(e.meta.idempotencyKey))) {
        return { kind: 'duplicate', eventId: e.id, firstSeenAt: 0 } as const;
      }
      executed.push(e.id);
      return { kind: 'dispatched', sessionId: 's-1' } as const;
    };

    const result = await requeue({ store, bus, eventId: 'evt-dup', dispatch });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The real outcome is returned and it actually ran (not 'duplicate').
      expect(result.outcome?.kind).toBe('dispatched');
      expect(executed).toEqual([result.newEventId]);
    }
    db.close();
  });

  test('newId / now seams are honored', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    const bus = createEventBus();
    await store.record(makeEvent('evt-seam'));
    await store.upsertRejection('evt-seam', 'no-handler', undefined);

    const seen: AgentEvent[] = [];
    bus.subscribe('*', async (e) => {
      seen.push(e);
    });

    const result = await requeue({
      store,
      bus,
      eventId: 'evt-seam',
      newId: () => 'fixed-new-id',
      now: () => 4242,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newEventId).toBe('fixed-new-id');
    expect(seen[0]?.id).toBe('fixed-new-id');
    expect(seen[0]?.timestamp).toBe(4242);
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
    // Critical: the second call MUST NOT have re-dispatched (DLQ row was
    // already acknowledged by the first), so only one publish happened.
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

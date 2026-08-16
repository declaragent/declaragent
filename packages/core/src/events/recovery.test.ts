import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { recoverPendingEvents } from './recovery.js';
import { createEventStore } from './store.js';
import type { AgentEvent } from './types.js';

function makeEvent(id: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id,
    kind: 'trigger.fire',
    source: { type: 'self', reason: 'retry' },
    target: { type: 'skill', name: 'do-thing', inputs: {} },
    timestamp: 1000,
    payload: { hello: 'world' },
    auth: { kind: 'internal' },
    ...overrides,
  };
}

function memStore() {
  return createEventStore({ db: new Database(':memory:', { create: true }) });
}

describe('recoverPendingEvents', () => {
  test('no pending events → recovered: 0, nothing published', async () => {
    const store = memStore();
    await store.record(makeEvent('done'));
    await store.markOutcome('done', { kind: 'dispatched', sessionId: 's' });
    const published: AgentEvent[] = [];
    const res = await recoverPendingEvents({ store, publish: (e) => void published.push(e) });
    expect(res.recovered).toBe(0);
    expect(published).toHaveLength(0);
  });

  test('re-dispatches a pending event under a fresh id with lineage', async () => {
    const store = memStore();
    // Interrupted: recorded, never got an outcome.
    await store.record(makeEvent('interrupted-1', { meta: { idempotencyKey: 'X-Delivery-1' } }));
    const published: AgentEvent[] = [];

    const res = await recoverPendingEvents({
      store,
      publish: (e) => void published.push(e),
      newId: () => 'fresh-1',
      now: () => 5000,
    });

    expect(res.recovered).toBe(1);
    expect(res.entries[0]).toEqual({ originalId: 'interrupted-1', newEventId: 'fresh-1' });
    // Clone published with fresh id + lineage, idempotency key dropped.
    expect(published).toHaveLength(1);
    expect(published[0]?.id).toBe('fresh-1');
    expect(published[0]?.timestamp).toBe(5000);
    expect(published[0]?.meta?.causedBy).toBe('interrupted-1');
    expect(published[0]?.meta?.idempotencyKey).toBeUndefined();
    // Original is now terminal (rejected/interrupted), so it's no longer pending.
    const original = await store.get('interrupted-1');
    expect(original?.outcome?.kind).toBe('rejected');
    if (original?.outcome?.kind === 'rejected') {
      expect(original.outcome.reason).toBe('interrupted');
    }
  });

  test('a second recovery pass does NOT re-dispatch the same original (idempotent across restarts)', async () => {
    const store = memStore();
    await store.record(makeEvent('interrupted-2'));
    const published: AgentEvent[] = [];
    const publish = (e: AgentEvent) => void published.push(e);

    const first = await recoverPendingEvents({ store, publish, newId: () => 'fresh-a' });
    expect(first.recovered).toBe(1);

    // Simulate a second boot: the original is terminal now, so nothing to recover.
    // (The published clone was never recorded by this stub, so it isn't pending.)
    const second = await recoverPendingEvents({ store, publish, newId: () => 'fresh-b' });
    expect(second.recovered).toBe(0);
    expect(published).toHaveLength(1); // only the first pass published
  });

  test('recovers multiple pending events', async () => {
    const store = memStore();
    await store.record(makeEvent('p1'));
    await store.record(makeEvent('p2'));
    await store.record(makeEvent('p3'));
    await store.markOutcome('p2', { kind: 'dispatched', sessionId: 's' }); // not pending
    const published: AgentEvent[] = [];
    let n = 0;
    const res = await recoverPendingEvents({
      store,
      publish: (e) => void published.push(e),
      newId: () => `fresh-${++n}`,
    });
    // Only p1 + p3 were pending.
    expect(res.recovered).toBe(2);
    expect(published.map((e) => e.meta?.causedBy).sort()).toEqual(['p1', 'p3']);
  });

  test('a publish error on one event is logged and does not block the rest', async () => {
    const store = memStore();
    await store.record(makeEvent('bad'));
    await store.record(makeEvent('good'));
    const warnings: string[] = [];
    const published: AgentEvent[] = [];
    let n = 0;
    const res = await recoverPendingEvents({
      store,
      newId: () => `fresh-${++n}`,
      publish: (e) => {
        if (e.meta?.causedBy === 'bad') throw new Error('publish boom');
        published.push(e);
      },
      logger: { warn: (ev) => warnings.push(ev) },
    });
    // 'good' still recovered despite 'bad' throwing.
    expect(published.some((e) => e.meta?.causedBy === 'good')).toBe(true);
    expect(res.recovered).toBe(1);
    expect(warnings).toContain('event.recovery.error');
  });
});

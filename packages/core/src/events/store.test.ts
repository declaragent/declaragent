import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventStore } from './store.js';
import type { AgentEvent, DispatchOutcome } from './types.js';

function memDb(): Database {
  const db = new Database(':memory:', { create: true });
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'declaragent-event-store-'));
  return {
    path: join(dir, 'events.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeEvent(overrides: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    kind: 'trigger.fire',
    source: { type: 'self', reason: 'wakeup' },
    target: { type: 'broadcast' },
    timestamp: Date.now(),
    payload: {},
    auth: { kind: 'internal' },
    ...overrides,
  };
}

describe('createEventStore', () => {
  test('record + get preserves every event field', async () => {
    const db = memDb();
    const store = createEventStore({ db });

    const event: AgentEvent = {
      id: 'evt-1',
      kind: 'webhook.received',
      source: { type: 'webhook', triggerId: 'gh-pr', remoteAddr: '10.0.0.1' },
      target: { type: 'session', sessionId: 'sess-x', mode: 'inject' },
      timestamp: 1700000000000,
      payload: { action: 'opened', n: 42 },
      auth: { kind: 'hmac', signatureHash: 'deadbeef' },
      meta: {
        correlationId: 'corr-1',
        causedBy: 'parent-evt',
        idempotencyKey: 'delivery-123',
        priority: 5,
      },
    };
    await store.record(event);

    const record = await store.get('evt-1');
    expect(record).toBeDefined();
    expect(record?.event).toEqual(event);
    expect(record?.outcome).toBeUndefined();
  });

  test('markOutcome populates outcome + outcomeAt', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(makeEvent({ id: 'e1' }));

    const outcome: DispatchOutcome = { kind: 'dispatched', sessionId: 'sess-1' };
    await store.markOutcome('e1', outcome);

    const record = await store.get('e1');
    expect(record?.outcome).toEqual(outcome);
    expect(record?.outcomeAt).toBeGreaterThan(0);
  });

  test('findDuplicate matches by primary key', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(makeEvent({ id: 'e1', source: { type: 'webhook', triggerId: 'gh-pr' } }));
    const dup = await store.findDuplicate(makeEvent({ id: 'e1' }), 60_000);
    expect(dup?.event.id).toBe('e1');
  });

  test('findDuplicate matches by (idempotency_key, source_type) within window', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(
      makeEvent({
        id: 'e1',
        source: { type: 'webhook', triggerId: 'gh-pr' },
        meta: { idempotencyKey: 'abc' },
      }),
    );

    const dup = await store.findDuplicate(
      makeEvent({
        id: 'e2',
        source: { type: 'webhook', triggerId: 'gh-pr' },
        meta: { idempotencyKey: 'abc' },
      }),
      60_000,
    );
    expect(dup?.event.id).toBe('e1');
  });

  test('findDuplicate respects source_type scoping', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(
      makeEvent({
        id: 'e1',
        source: { type: 'webhook', triggerId: 'gh-pr' },
        meta: { idempotencyKey: 'abc' },
      }),
    );
    // Same idempotency key but different source type → not a dup.
    const noDup = await store.findDuplicate(
      makeEvent({
        id: 'e2',
        source: { type: 'cron', triggerId: 'daily', schedule: '0 9 * * *' },
        meta: { idempotencyKey: 'abc' },
      }),
      60_000,
    );
    expect(noDup).toBeUndefined();
  });

  test('findDuplicate ignores rows outside the window', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(
      makeEvent({
        id: 'old',
        timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
        source: { type: 'webhook', triggerId: 'gh' },
        meta: { idempotencyKey: 'abc' },
      }),
    );
    const dup = await store.findDuplicate(
      makeEvent({
        id: 'new',
        source: { type: 'webhook', triggerId: 'gh' },
        meta: { idempotencyKey: 'abc' },
      }),
      60 * 60 * 1000, // 1h window → stale row excluded
    );
    expect(dup).toBeUndefined();
  });

  test('list filters by kind', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(makeEvent({ id: 'a', kind: 'webhook.received' }));
    await store.record(makeEvent({ id: 'b', kind: 'trigger.fire' }));
    await store.record(makeEvent({ id: 'c', kind: 'webhook.received' }));

    const webhooks = await store.list({ kind: 'webhook.received' });
    expect(webhooks.map((r) => r.event.id).sort()).toEqual(['a', 'c']);
  });

  test('list filters by correlation id', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(makeEvent({ id: 'a', meta: { correlationId: 'run-1' } }));
    await store.record(makeEvent({ id: 'b', meta: { correlationId: 'run-2' } }));
    await store.record(makeEvent({ id: 'c', meta: { correlationId: 'run-1' } }));

    const run1 = await store.list({ correlationId: 'run-1' });
    expect(run1.map((r) => r.event.id).sort()).toEqual(['a', 'c']);
  });

  test('list filters by outcome (pending / dispatched / rejected)', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(makeEvent({ id: 'p' }));
    await store.record(makeEvent({ id: 'd' }));
    await store.record(makeEvent({ id: 'r' }));
    await store.markOutcome('d', { kind: 'dispatched', sessionId: 's' });
    await store.markOutcome('r', { kind: 'rejected', reason: 'no-handler' });

    const pending = await store.list({ outcomeKind: 'pending' });
    expect(pending.map((r) => r.event.id)).toEqual(['p']);

    const dispatched = await store.list({ outcomeKind: 'dispatched' });
    expect(dispatched.map((r) => r.event.id)).toEqual(['d']);

    const rejected = await store.list({ outcomeKind: 'rejected' });
    expect(rejected.map((r) => r.event.id)).toEqual(['r']);
  });

  test('list respects limit and returns newest-first', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    for (let i = 0; i < 5; i += 1) {
      await store.record(makeEvent({ id: `e${i}`, timestamp: 1000 + i * 100 }));
    }
    const rows = await store.list({ limit: 3 });
    expect(rows.map((r) => r.event.id)).toEqual(['e4', 'e3', 'e2']);
  });

  test('vacuum deletes rows older than cutoff', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    const now = Date.now();
    await store.record(makeEvent({ id: 'old', timestamp: now - 31 * 24 * 60 * 60 * 1000 }));
    await store.record(makeEvent({ id: 'new', timestamp: now }));

    const removed = await store.vacuum();
    expect(removed).toBe(1);

    const remaining = await store.list({});
    expect(remaining.map((r) => r.event.id)).toEqual(['new']);
  });

  test('persistence survives close/reopen', async () => {
    const { path, cleanup } = tmpDbPath();
    try {
      const a = new Database(path, { create: true });
      const storeA = createEventStore({ db: a });
      await storeA.record(makeEvent({ id: 'e1', meta: { idempotencyKey: 'k1' } }));
      a.close();

      const b = new Database(path, { create: true });
      const storeB = createEventStore({ db: b });
      const fetched = await storeB.get('e1');
      expect(fetched?.event.meta?.idempotencyKey).toBe('k1');
      b.close();
    } finally {
      cleanup();
    }
  });

  test('record is safe for events without meta / payload', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record({
      id: 'minimal',
      kind: 'self.wakeup',
      source: { type: 'self', reason: 'wakeup' },
      target: { type: 'broadcast' },
      timestamp: 100,
      payload: undefined,
      auth: { kind: 'internal' },
    } as AgentEvent);
    const record = await store.get('minimal');
    expect(record?.event.id).toBe('minimal');
    expect(record?.event.meta).toBeUndefined();
    expect(record?.event.payload).toBeNull();
  });
});

// ── Slice 5 / PR 5.1 — dispatch DLQ ─────────────────────────────────────

describe('createEventStore: rejected_events (dispatch DLQ)', () => {
  test('upsertRejection inserts a new row with attempt=1 on first call', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(makeEvent({ id: 'e1' }));
    await store.upsertRejection('e1', 'invalid', 'skill threw', 1_700_000_000_000);

    const rec = await store.getRejection('e1');
    expect(rec).toBeDefined();
    expect(rec?.eventId).toBe('e1');
    expect(rec?.rejectionReason).toBe('invalid');
    expect(rec?.details).toBe('skill threw');
    expect(rec?.attemptCount).toBe(1);
    expect(rec?.firstSeenMs).toBe(1_700_000_000_000);
    expect(rec?.lastSeenMs).toBe(1_700_000_000_000);
  });

  test('upsertRejection bumps attempt_count + last_seen on repeat calls without changing first_seen', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(makeEvent({ id: 'e1' }));
    await store.upsertRejection('e1', 'circuit-open', 'breaker open', 1_000);
    await store.upsertRejection('e1', 'circuit-open', 'breaker still open', 2_000);
    await store.upsertRejection('e1', 'invalid', 'different reason now', 3_000);

    const rec = await store.getRejection('e1');
    expect(rec?.attemptCount).toBe(3);
    expect(rec?.firstSeenMs).toBe(1_000);
    expect(rec?.lastSeenMs).toBe(3_000);
    // Latest-write-wins on reason + details
    expect(rec?.rejectionReason).toBe('invalid');
    expect(rec?.details).toBe('different reason now');
  });

  test('listRejections filters by reason, sinceMs, minAttempts', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    for (const id of ['a', 'b', 'c']) await store.record(makeEvent({ id }));
    await store.upsertRejection('a', 'circuit-open', undefined, 1_000);
    await store.upsertRejection('b', 'rate-limit', undefined, 2_000);
    await store.upsertRejection('b', 'rate-limit', undefined, 3_000);
    await store.upsertRejection('c', 'circuit-open', undefined, 4_000);
    await store.upsertRejection('c', 'circuit-open', undefined, 5_000);
    await store.upsertRejection('c', 'circuit-open', undefined, 6_000);

    const all = await store.listRejections();
    expect(all).toHaveLength(3);
    // Newest-first order
    expect(all[0]?.eventId).toBe('c');

    const circuits = await store.listRejections({ reason: 'circuit-open' });
    expect(circuits.map((r) => r.eventId).sort()).toEqual(['a', 'c']);

    const recent = await store.listRejections({ sinceMs: 4_000 });
    expect(recent.map((r) => r.eventId).sort()).toEqual(['c']);

    const poison = await store.listRejections({ minAttempts: 3 });
    expect(poison.map((r) => r.eventId)).toEqual(['c']);
  });

  test('deleteRejection returns true on success and false when no row existed', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    await store.record(makeEvent({ id: 'e1' }));
    await store.upsertRejection('e1', 'invalid', undefined);
    expect(await store.deleteRejection('e1')).toBe(true);
    expect(await store.getRejection('e1')).toBeUndefined();
    expect(await store.deleteRejection('e1')).toBe(false);
  });

  test('listRejections respects limit', async () => {
    const db = memDb();
    const store = createEventStore({ db });
    for (let i = 0; i < 10; i += 1) {
      const id = `e${i}`;
      await store.record(makeEvent({ id }));
      await store.upsertRejection(id, 'invalid', undefined, 1_000 + i);
    }
    const rows = await store.listRejections({ limit: 3 });
    expect(rows).toHaveLength(3);
  });
});

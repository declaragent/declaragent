import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { TenantAuditSink } from '../audit/types.js';
import { createEventStore } from '../events/store.js';
import type { AgentEvent } from '../events/types.js';
import { eraseSubject } from './erase-subject.js';

function memDb(): Database {
  return new Database(':memory:', { create: true });
}

function event(id: string, platformUserId?: string): AgentEvent {
  return {
    id,
    kind: 'webhook.received',
    source: { type: 'webhook', triggerId: 't' },
    target: { type: 'broadcast' },
    timestamp: Date.now(),
    payload: {},
    auth: { kind: 'internal' },
    ...(platformUserId !== undefined && { meta: { principal: { platformUserId } } }),
  };
}

describe('eraseSubject (WS8 GDPR)', () => {
  test('erases the subject from event stores + reports counts', async () => {
    const storeA = createEventStore({ db: memDb() });
    const storeB = createEventStore({ db: memDb() });
    await storeA.record(event('a1', 'alice'));
    await storeA.record(event('a2', 'alice'));
    await storeA.record(event('b1', 'bob'));
    await storeB.record(event('a3', 'alice'));

    const result = await eraseSubject('alice', { eventStores: [storeA, storeB] });
    expect(result.events).toBe(3); // a1, a2 (storeA) + a3 (storeB)
    expect(await storeA.get('a1')).toBeUndefined();
    expect(await storeB.get('a3')).toBeUndefined();
    expect(await storeA.get('b1')).toBeDefined(); // bob untouched
  });

  test('composes audit erase + event deletion, summing counts', async () => {
    const store = createEventStore({ db: memDb() });
    await store.record(event('e1', 'carol'));
    let auditEraseReason = '';
    // Fake sink: the real audit-record matching is tested in audit/erase.test.ts;
    // here we verify the composer invokes erase + sums both stores' counts.
    const fakeSink = {
      async erase(opts: { reason: string }) {
        auditEraseReason = opts.reason;
        return 2;
      },
      async record() {},
      async query() {
        return [];
      },
      async verify() {
        return { ok: true, totalEntries: 0, verifiedEntries: 0, violations: [] };
      },
      async prune() {
        return 0;
      },
      close() {},
    } as unknown as TenantAuditSink;

    const result = await eraseSubject(
      'carol',
      { auditSink: fakeSink, eventStores: [store] },
      {
        reason: 'gdpr-dsr-42',
      },
    );
    expect(result.auditRecords).toBe(2);
    expect(result.events).toBe(1);
    expect(auditEraseReason).toBe('gdpr-dsr-42');
    expect(await store.get('e1')).toBeUndefined();
  });

  test('no stores → zero counts (safe no-op)', async () => {
    const result = await eraseSubject('nobody', {});
    expect(result).toEqual({ auditRecords: 0, events: 0 });
  });
});

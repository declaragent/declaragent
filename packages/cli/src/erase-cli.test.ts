import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { AgentEvent, TenantAuditSink } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { eraseUser } from './erase-cli.js';

function collectIO(): {
  io: { out: (s: string) => void; err: (s: string) => void };
  out: () => string;
  err: () => string;
} {
  let out = '';
  let err = '';
  return {
    io: {
      out(s: string) {
        out += s;
      },
      err(s: string) {
        err += s;
      },
    },
    out: () => out,
    err: () => err,
  };
}

function event(id: string, platformUserId: string): AgentEvent {
  return {
    id,
    kind: 'webhook.received',
    source: { type: 'webhook', triggerId: 't' },
    target: { type: 'broadcast' },
    timestamp: Date.now(),
    payload: {},
    auth: { kind: 'internal' },
    meta: { principal: { platformUserId } },
  };
}

function fakeSink(eraseReturns: number): TenantAuditSink {
  return {
    async erase() {
      return eraseReturns;
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
}

describe('eraseUser CLI (WS8)', () => {
  test('errors without --user', async () => {
    const cap = collectIO();
    const code = await eraseUser({}, { io: cap.io });
    expect(code).toBe(1);
    expect(cap.err()).toMatch(/--user/);
  });

  test('composes audit + event erasure and reports counts (json)', async () => {
    const store = createEventStore({ db: new Database(':memory:', { create: true }) });
    await store.record(event('e1', 'dave'));
    await store.record(event('e2', 'dave'));
    const cap = collectIO();
    const code = await eraseUser(
      { user: 'dave', json: true },
      { io: cap.io, auditSink: fakeSink(3), eventStores: [store] },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out());
    expect(parsed).toEqual({ platformUserId: 'dave', auditRecords: 3, events: 2 });
    expect(await store.get('e1')).toBeUndefined();
  });

  test('exits 0 with zero counts when nothing matches (idempotent DSR)', async () => {
    const store = createEventStore({ db: new Database(':memory:', { create: true }) });
    const cap = collectIO();
    const code = await eraseUser(
      { user: 'ghost' },
      { io: cap.io, auditSink: fakeSink(0), eventStores: [store] },
    );
    expect(code).toBe(0);
    expect(cap.out()).toMatch(/0 audit records \+ 0 events/);
  });
});

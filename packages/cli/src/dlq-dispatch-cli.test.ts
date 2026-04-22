import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { AgentEvent, EventStore } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { dlqDispatchDrop, dlqDispatchList, dlqDispatchShow } from './dlq-dispatch-cli.js';

function captureIO(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
  };
}

function memStore(): EventStore {
  return createEventStore({ db: new Database(':memory:') });
}

async function seedRejected(
  store: EventStore,
  id: string,
  reason: string,
  attempts: number,
  whenMs: number,
): Promise<void> {
  const event: AgentEvent = {
    id,
    kind: 'webhook.received',
    source: { type: 'webhook', triggerId: 'gh' },
    target: { type: 'skill', name: 'boom', inputs: {} },
    timestamp: whenMs,
    payload: null,
    auth: { kind: 'hmac', signatureHash: 'x' },
  };
  await store.record(event);
  await store.markOutcome(id, {
    kind: 'rejected',
    reason: reason as 'invalid',
    details: 'skill exploded',
  });
  for (let i = 0; i < attempts; i += 1) {
    await store.upsertRejection(id, reason, 'skill exploded', whenMs + i);
  }
}

describe('dlqDispatchList', () => {
  test('prints "empty" for a clean DLQ', async () => {
    const store = memStore();
    const { io, out } = captureIO();
    const code = await dlqDispatchList({}, { store, io });
    expect(code).toBe(0);
    expect(out.join('')).toContain('empty');
  });

  test('surfaces rejected events sorted newest-first', async () => {
    const store = memStore();
    await seedRejected(store, 'old', 'invalid', 1, 1_000);
    await seedRejected(store, 'new', 'circuit-open', 2, 2_000);

    const { io, out } = captureIO();
    const code = await dlqDispatchList({}, { store, io });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('dispatch DLQ (2)');
    // Newer row appears before older in the listing.
    expect(text.indexOf('new')).toBeLessThan(text.indexOf('old'));
    expect(text).toContain('×2');
    expect(text).toContain('circuit-open');
  });

  test('applies reason + minAttempts filters', async () => {
    const store = memStore();
    await seedRejected(store, 'a', 'invalid', 1, 1_000);
    await seedRejected(store, 'b', 'circuit-open', 4, 2_000);
    await seedRejected(store, 'c', 'circuit-open', 1, 3_000);

    const { io, out } = captureIO();
    await dlqDispatchList({ reason: 'circuit-open', minAttempts: 3 }, { store, io });
    const text = out.join('');
    expect(text).toContain(' b\n');
    expect(text).not.toContain(' a\n');
    expect(text).not.toContain(' c\n');
  });
});

describe('dlqDispatchShow', () => {
  test('returns 1 + error when the id is not in the DLQ', async () => {
    const store = memStore();
    const { io, err } = captureIO();
    const code = await dlqDispatchShow('nope', { store, io });
    expect(code).toBe(1);
    expect(err.join('')).toContain('no dispatch DLQ entry');
  });

  test('emits rejection + original event payload as JSON', async () => {
    const store = memStore();
    await seedRejected(store, 'shown', 'invalid', 1, 1_000);
    const { io, out } = captureIO();
    const code = await dlqDispatchShow('shown', { store, io });
    expect(code).toBe(0);
    const body = JSON.parse(out.join(''));
    expect(body.rejection.eventId).toBe('shown');
    expect(body.rejection.rejectionReason).toBe('invalid');
    expect(body.event.id).toBe('shown');
    expect(body.lastOutcome.kind).toBe('rejected');
  });
});

describe('dlqDispatchDrop', () => {
  test('removes the DLQ row and returns 0', async () => {
    const store = memStore();
    await seedRejected(store, 'x', 'invalid', 1, 1_000);
    const { io, out } = captureIO();
    const code = await dlqDispatchDrop('x', { store, io });
    expect(code).toBe(0);
    expect(out.join('')).toContain('dropped');
    expect(await store.getRejection('x')).toBeUndefined();
  });

  test('returns 1 when the id is not in the DLQ', async () => {
    const store = memStore();
    const { io, err } = captureIO();
    const code = await dlqDispatchDrop('nope', { store, io });
    expect(code).toBe(1);
    expect(err.join('')).toContain('nothing to drop');
  });

  test('does NOT remove the event from the events table — only the DLQ ledger', async () => {
    const store = memStore();
    await seedRejected(store, 'x', 'invalid', 1, 1_000);
    const { io } = captureIO();
    await dlqDispatchDrop('x', { store, io });
    expect(await store.get('x')).toBeDefined();
  });
});

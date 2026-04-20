import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentEvent, EventStore } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { createEventsTailTool, runEventsTail } from './events-tail.js';

function makeStore(): EventStore {
  const db = new Database(':memory:', { create: true });
  return createEventStore({ db });
}

const SAMPLE: AgentEvent = {
  id: 'evt-1',
  kind: 'webhook.received',
  source: { type: 'webhook', triggerId: 'gh-pr', sourceId: 'gh-pr' } as never,
  target: { type: 'broadcast' },
  timestamp: Date.parse('2026-04-16T10:00:00Z'),
  payload: { action: 'opened', pr: 42 },
  auth: { kind: 'hmac', signatureHash: 'abc' },
  meta: { correlationId: 'run-1' },
};

describe('runEventsTail', () => {
  let store: EventStore;

  beforeEach(() => {
    store = makeStore();
  });

  test('returns count 0 for an empty store', async () => {
    const out = await runEventsTail({}, { store, storePath: ':memory:' });
    expect(out.count).toBe(0);
    expect(out.events).toEqual([]);
  });

  test('summarises an event with payload preview', async () => {
    await store.record(SAMPLE);
    const out = await runEventsTail({}, { store, storePath: ':memory:' });
    expect(out.count).toBe(1);
    const first = out.events[0];
    expect(first?.id).toBe('evt-1');
    expect(first?.kind).toBe('webhook.received');
    expect(first?.correlationId).toBe('run-1');
    expect(first?.payloadPreview).toContain('"action":"opened"');
  });

  test('filters by kind', async () => {
    await store.record(SAMPLE);
    await store.record({
      ...SAMPLE,
      id: 'evt-2',
      kind: 'trigger.fire',
      source: { type: 'cron', triggerId: 'daily', schedule: '0 9 * * *' } as never,
    });
    const out = await runEventsTail({ kind: 'trigger.fire' }, { store, storePath: ':memory:' });
    expect(out.count).toBe(1);
    expect(out.events[0]?.id).toBe('evt-2');
  });

  test('filters by correlationId', async () => {
    await store.record(SAMPLE);
    await store.record({ ...SAMPLE, id: 'evt-2', meta: { correlationId: 'run-2' } });
    const out = await runEventsTail({ correlationId: 'run-2' }, { store, storePath: ':memory:' });
    expect(out.count).toBe(1);
    expect(out.events[0]?.id).toBe('evt-2');
  });

  test('honours the `last` cap', async () => {
    for (let i = 0; i < 5; i++) {
      await store.record({ ...SAMPLE, id: `evt-${i}`, timestamp: SAMPLE.timestamp + i });
    }
    const out = await runEventsTail({ last: 3 }, { store, storePath: ':memory:' });
    expect(out.count).toBe(3);
  });

  test('truncates long payloads with …', async () => {
    const big = { body: 'x'.repeat(500) };
    await store.record({ ...SAMPLE, id: 'big', payload: big });
    const out = await runEventsTail({ last: 1 }, { store, storePath: ':memory:' });
    const preview = out.events[0]?.payloadPreview ?? '';
    expect(preview.length).toBeLessThanOrEqual(141);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('createEventsTailTool', () => {
  test('readonly + parallelSafe', () => {
    const tool = createEventsTailTool();
    expect(tool.readonly).toBe(true);
    expect(tool.parallelSafe).toBe(true);
  });

  test('permissionKey encodes filters', () => {
    const tool = createEventsTailTool();
    expect(tool.permissionKey({})).toBe('events-tail');
    expect(tool.permissionKey({ kind: 'webhook.received' })).toBe(
      'events-tail:kind:webhook.received',
    );
    expect(tool.permissionKey({ correlationId: 'run-9' })).toBe('events-tail:corr:run-9');
  });

  test('execute surfaces a validation error for negative last', async () => {
    const tool = createEventsTailTool();
    const ctx = {
      session: {} as never,
      permissions: {} as never,
      abortSignal: new AbortController().signal,
      depth: 0,
      runAgent: (async () => ({}) as never) as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    };
    const events: unknown[] = [];
    for await (const ev of tool.execute({ last: -1 }, ctx)) events.push(ev);
    expect((events[0] as { type: string }).type).toBe('error');
  });
});

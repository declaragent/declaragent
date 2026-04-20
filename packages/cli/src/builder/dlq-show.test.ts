import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentEvent, EventStore } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { createDlqShowTool, runDlqShow } from './dlq-show.js';

function makeStore(): EventStore {
  const db = new Database(':memory:', { create: true });
  return createEventStore({ db });
}

const BASE: AgentEvent = {
  id: 'evt-x',
  kind: 'webhook.received',
  source: { type: 'webhook', triggerId: 'gh-pr', sourceId: 'gh-pr' } as never,
  target: { type: 'broadcast' },
  timestamp: 1_700_000_000_000,
  payload: { pr: 42 },
  auth: { kind: 'hmac', signatureHash: 'abc' },
};

describe('runDlqShow', () => {
  let store: EventStore;

  beforeEach(() => {
    store = makeStore();
  });

  test('returns count 0 when nothing rejected', async () => {
    await store.record(BASE);
    await store.markOutcome('evt-x', { kind: 'broadcast' });
    const out = await runDlqShow({}, { store, storePath: ':memory:' });
    expect(out.count).toBe(0);
  });

  test('surfaces rejected entries with a decorated reason', async () => {
    await store.record(BASE);
    await store.markOutcome('evt-x', {
      kind: 'rejected',
      reason: 'rate-limit',
      details: 'burst exceeded',
    });
    const out = await runDlqShow({}, { store, storePath: ':memory:' });
    expect(out.count).toBe(1);
    expect(out.entries[0]?.reason).toContain('rejected:rate-limit');
    expect(out.entries[0]?.reason).toContain('burst exceeded');
  });

  test('sourceId filter scopes to one adapter', async () => {
    await store.record(BASE);
    await store.record({
      ...BASE,
      id: 'evt-y',
      source: { type: 'webhook', triggerId: 'other', sourceId: 'other' } as never,
    });
    await store.markOutcome('evt-x', { kind: 'rejected', reason: 'unauthorized' });
    await store.markOutcome('evt-y', { kind: 'rejected', reason: 'unauthorized' });
    const out = await runDlqShow({ sourceId: 'gh-pr' }, { store, storePath: ':memory:' });
    expect(out.count).toBe(1);
    expect(out.entries[0]?.id).toBe('evt-x');
  });

  test('limit caps the result size', async () => {
    for (let i = 0; i < 5; i++) {
      await store.record({ ...BASE, id: `evt-${i}`, timestamp: BASE.timestamp + i });
      await store.markOutcome(`evt-${i}`, { kind: 'rejected', reason: 'no-handler' });
    }
    const out = await runDlqShow({ limit: 2 }, { store, storePath: ':memory:' });
    expect(out.count).toBe(2);
  });
});

describe('createDlqShowTool', () => {
  test('readonly + parallelSafe', () => {
    const tool = createDlqShowTool();
    expect(tool.readonly).toBe(true);
    expect(tool.parallelSafe).toBe(true);
  });

  test('permissionKey includes sourceId when present', () => {
    const tool = createDlqShowTool();
    expect(tool.permissionKey({})).toBe('dlq-show');
    expect(tool.permissionKey({ sourceId: 'gh' })).toBe('dlq-show:gh');
  });
});

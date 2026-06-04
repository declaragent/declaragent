import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type MemoryStore, createSqliteMemoryStore } from '../memory/sqlite-memory.js';
import { collectToolEvents, makeToolContext } from '../testing/context.js';
import { type MemoryTools, createMemoryTools } from './memory.js';

describe('memory tools', () => {
  let store: MemoryStore;
  let tools: MemoryTools;

  beforeEach(() => {
    store = createSqliteMemoryStore({ path: ':memory:' });
    tools = createMemoryTools({ store, namespace: 'support' });
  });

  afterEach(() => {
    store.close();
  });

  test('exposes three tools under the snake_case names', () => {
    expect(tools.memoryWrite.name).toBe('memory_write');
    expect(tools.memoryRead.name).toBe('memory_read');
    expect(tools.memorySearch.name).toBe('memory_search');
    expect(tools.all).toHaveLength(3);
    expect(tools.all.map((t) => t.name)).toEqual(['memory_write', 'memory_read', 'memory_search']);
  });

  test('memory_write then memory_read round-trips value + tags', async () => {
    const writeOut = await collectToolEvents(
      tools.memoryWrite.execute(
        { key: 'user:tz', value: 'America/New_York', tags: ['user', 'pref'] },
        makeToolContext(),
      ),
    );
    expect(writeOut.error).toBeUndefined();
    expect(writeOut.result).toEqual({ key: 'user:tz', namespace: 'support' });

    const readOut = await collectToolEvents(
      tools.memoryRead.execute({ key: 'user:tz' }, makeToolContext()),
    );
    expect(readOut.error).toBeUndefined();
    expect(readOut.result?.found).toBe(true);
    expect(readOut.result?.value).toBe('America/New_York');
    expect(readOut.result?.tags).toEqual(['user', 'pref']);
  });

  test('memory_read miss yields a result with found:false (not an error)', async () => {
    const out = await collectToolEvents(
      tools.memoryRead.execute({ key: 'absent' }, makeToolContext()),
    );
    expect(out.error).toBeUndefined();
    expect(out.result).toEqual({ key: 'absent', found: false });
  });

  test('memory_search matches by substring', async () => {
    await collectToolEvents(
      tools.memoryWrite.execute({ key: 'k1', value: 'escalate to tier 2' }, makeToolContext()),
    );
    await collectToolEvents(
      tools.memoryWrite.execute({ key: 'k2', value: 'close the ticket' }, makeToolContext()),
    );
    const out = await collectToolEvents(
      tools.memorySearch.execute({ query: 'escalate' }, makeToolContext()),
    );
    expect(out.error).toBeUndefined();
    expect(out.result?.matches.map((m) => m.key)).toEqual(['k1']);
  });

  test('memory_search matches by tag', async () => {
    await collectToolEvents(
      tools.memoryWrite.execute({ key: 'a', value: 'x', tags: ['ops'] }, makeToolContext()),
    );
    await collectToolEvents(
      tools.memoryWrite.execute({ key: 'b', value: 'y', tags: ['ui'] }, makeToolContext()),
    );
    const out = await collectToolEvents(
      tools.memorySearch.execute({ query: '', tags: ['ops'] }, makeToolContext()),
    );
    expect(out.result?.matches.map((m) => m.key)).toEqual(['a']);
  });

  test('empty query with no tags returns all stored records', async () => {
    await collectToolEvents(tools.memoryWrite.execute({ key: 'a', value: '1' }, makeToolContext()));
    await collectToolEvents(tools.memoryWrite.execute({ key: 'b', value: '2' }, makeToolContext()));
    const out = await collectToolEvents(
      tools.memorySearch.execute({ query: '' }, makeToolContext()),
    );
    expect(out.result?.matches.map((m) => m.key).sort()).toEqual(['a', 'b']);
  });

  test('permission keys are namespace-scoped', () => {
    expect(tools.memoryWrite.permissionKey({ key: 'note-1', value: 'v' })).toBe('support/note-1');
    expect(tools.memoryRead.permissionKey({ key: 'note-1' })).toBe('support/note-1');
    expect(tools.memorySearch.permissionKey({ query: 'anything' })).toBe('support');
  });

  test('read and search are marked readonly; write is not', () => {
    expect(tools.memoryRead.readonly).toBe(true);
    expect(tools.memorySearch.readonly).toBe(true);
    expect(tools.memoryWrite.readonly).toBeUndefined();
  });

  test('namespaces isolate two tool sets over one store', async () => {
    const other = createMemoryTools({ store, namespace: 'sales' });
    await collectToolEvents(
      tools.memoryWrite.execute({ key: 'shared', value: 'support-value' }, makeToolContext()),
    );
    await collectToolEvents(
      other.memoryWrite.execute({ key: 'shared', value: 'sales-value' }, makeToolContext()),
    );
    const supportRead = await collectToolEvents(
      tools.memoryRead.execute({ key: 'shared' }, makeToolContext()),
    );
    const salesRead = await collectToolEvents(
      other.memoryRead.execute({ key: 'shared' }, makeToolContext()),
    );
    expect(supportRead.result?.value).toBe('support-value');
    expect(salesRead.result?.value).toBe('sales-value');
  });
});

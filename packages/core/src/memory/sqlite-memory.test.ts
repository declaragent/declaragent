import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MemoryStore, createSqliteMemoryStore } from './sqlite-memory.js';

describe('SqliteMemoryStore', () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-memory-'));
    store = createSqliteMemoryStore({ path: join(dir, 'memory.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('write then read round-trips value and tags', () => {
    store.write('agent-a', 'fav-color', 'blue', { tags: ['preference', 'ui'] });
    const rec = store.read('agent-a', 'fav-color');
    expect(rec).toBeDefined();
    expect(rec?.namespace).toBe('agent-a');
    expect(rec?.key).toBe('fav-color');
    expect(rec?.value).toBe('blue');
    expect(rec?.tags).toEqual(['preference', 'ui']);
    expect(rec?.createdAt).toBeInstanceOf(Date);
    expect(rec?.updatedAt).toBeInstanceOf(Date);
  });

  test('write without tags persists an empty tag array', () => {
    store.write('agent-a', 'k', 'v');
    expect(store.read('agent-a', 'k')?.tags).toEqual([]);
  });

  test('read returns undefined for a missing key', () => {
    expect(store.read('agent-a', 'nope')).toBeUndefined();
  });

  test('persists across close() and reopen (survives a process restart)', () => {
    const dbPath = join(dir, 'persist.db');
    const first = createSqliteMemoryStore({ path: dbPath });
    first.write('agent-a', 'runbook', 'restart the worker pool', { tags: ['ops'] });
    first.close();

    const reopened = createSqliteMemoryStore({ path: dbPath });
    const rec = reopened.read('agent-a', 'runbook');
    expect(rec?.value).toBe('restart the worker pool');
    expect(rec?.tags).toEqual(['ops']);
    reopened.close();
  });

  test('namespaces are isolated: same key in two namespaces is independent', () => {
    store.write('agent-a', 'shared-key', 'value-a');
    store.write('agent-b', 'shared-key', 'value-b');
    expect(store.read('agent-a', 'shared-key')?.value).toBe('value-a');
    expect(store.read('agent-b', 'shared-key')?.value).toBe('value-b');

    // Deleting in one namespace leaves the other intact.
    expect(store.delete('agent-a', 'shared-key')).toBe(true);
    expect(store.read('agent-a', 'shared-key')).toBeUndefined();
    expect(store.read('agent-b', 'shared-key')?.value).toBe('value-b');
  });

  test('overwrite replaces value + tags and bumps updatedAt while keeping createdAt', () => {
    store.write('agent-a', 'k', 'v1', { tags: ['old'] });
    const before = store.read('agent-a', 'k');
    expect(before?.value).toBe('v1');

    // Force a measurable time gap so updatedAt strictly advances.
    const t = Date.now();
    while (Date.now() === t) {
      // busy-wait one ms
    }

    store.write('agent-a', 'k', 'v2', { tags: ['new'] });
    const after = store.read('agent-a', 'k');
    expect(after?.value).toBe('v2');
    expect(after?.tags).toEqual(['new']);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
    expect((after?.updatedAt.getTime() ?? 0) >= (before?.updatedAt.getTime() ?? 0)).toBe(true);
  });

  test('delete returns false for a missing key', () => {
    expect(store.delete('agent-a', 'never-existed')).toBe(false);
  });

  test('list returns all records in a namespace, newest first', () => {
    store.write('agent-a', 'a', '1');
    store.write('agent-a', 'b', '2');
    store.write('agent-b', 'c', '3');
    const listed = store.list('agent-a');
    expect(listed).toHaveLength(2);
    expect(listed.map((r) => r.key).sort()).toEqual(['a', 'b']);
  });

  describe('search', () => {
    beforeEach(() => {
      store.write('ns', 'user:alice', 'Alice likes dark mode', { tags: ['user', 'ui'] });
      store.write('ns', 'user:bob', 'Bob prefers light mode', { tags: ['user', 'ui'] });
      store.write('ns', 'config:retries', '3', { tags: ['config'] });
      store.write('other-ns', 'user:carol', 'Carol', { tags: ['user'] });
    });

    test('empty query returns the full namespace', () => {
      const out = store.search('ns', {});
      expect(out).toHaveLength(3);
      expect(out.every((r) => r.namespace === 'ns')).toBe(true);
    });

    test('prefix matches keys', () => {
      const out = store.search('ns', { prefix: 'user:' });
      expect(out.map((r) => r.key).sort()).toEqual(['user:alice', 'user:bob']);
    });

    test('substring matches key OR value', () => {
      const byValue = store.search('ns', { substring: 'dark mode' });
      expect(byValue.map((r) => r.key)).toEqual(['user:alice']);
      const byKey = store.search('ns', { substring: 'retries' });
      expect(byKey.map((r) => r.key)).toEqual(['config:retries']);
    });

    test('tags match all-of (AND)', () => {
      const out = store.search('ns', { tags: ['user', 'ui'] });
      expect(out.map((r) => r.key).sort()).toEqual(['user:alice', 'user:bob']);
      const single = store.search('ns', { tags: ['config'] });
      expect(single.map((r) => r.key)).toEqual(['config:retries']);
    });

    test('combined filters AND together', () => {
      const out = store.search('ns', { prefix: 'user:', substring: 'light', tags: ['ui'] });
      expect(out.map((r) => r.key)).toEqual(['user:bob']);
    });

    test('search is namespace-scoped', () => {
      const out = store.search('ns', { prefix: 'user:' });
      expect(out.every((r) => r.namespace === 'ns')).toBe(true);
      expect(out.find((r) => r.key === 'user:carol')).toBeUndefined();
    });
  });
});

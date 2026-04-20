import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus } from './bus.js';
import { createMailbox } from './mailbox.js';
import type { AgentEvent, EventBus } from './types.js';

function memDb(): Database {
  const db = new Database(':memory:', { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'declaragent-mailbox-'));
  const path = join(dir, 'mailbox.sqlite');
  return {
    path,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('createMailbox', () => {
  test('send → drainFor returns the enqueued message', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });

    const id = await mailbox.send('bob', { hello: 'world' }, 'alice');
    const drained = await mailbox.drainFor('bob');

    expect(drained).toHaveLength(1);
    const event = drained[0] as AgentEvent;
    expect(event.id).toBe(id);
    expect(event.kind).toBe('mailbox.message');
    expect(event.source).toEqual({ type: 'mailbox', fromAgent: 'alice' });
    expect(event.target).toEqual({ type: 'broadcast' });
    expect(event.payload).toEqual({ hello: 'world' });
    expect(event.auth).toEqual({ kind: 'internal' });
    expect(event.meta?.idempotencyKey).toBe(id);
  });

  test('multiple sends drain in FIFO order', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      ids.push(await mailbox.send('bob', { n }, 'alice'));
    }
    const drained = await mailbox.drainFor('bob');
    expect(drained.map((e) => e.id)).toEqual(ids);
    expect(drained.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2, 3]);
  });

  test('drainFor on empty returns empty array', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    expect(await mailbox.drainFor('nobody')).toEqual([]);
  });

  test('second drain is a no-op (tombstones prevent re-delivery)', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    await mailbox.send('bob', 1, 'alice');
    await mailbox.send('bob', 2, 'alice');

    const first = await mailbox.drainFor('bob');
    const second = await mailbox.drainFor('bob');
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);
  });

  test('depth reflects pending count and drops to zero after drain', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    expect(await mailbox.depth('bob')).toBe(0);
    await mailbox.send('bob', 1, 'alice');
    await mailbox.send('bob', 2, 'alice');
    expect(await mailbox.depth('bob')).toBe(2);
    await mailbox.drainFor('bob');
    expect(await mailbox.depth('bob')).toBe(0);
  });

  test('depth after a fresh open rebuilds from SQLite', async () => {
    // Simulates a daemon restart: the in-memory depth cache is gone but
    // SQLite still has pending rows.
    const { path, cleanup } = tmpDbPath();
    try {
      const a = new Database(path, { create: true });
      const mbA = createMailbox({ db: a });
      await mbA.send('bob', 'msg', 'alice');
      a.close();

      const b = new Database(path, { create: true });
      const mbB = createMailbox({ db: b });
      expect(await mbB.depth('bob')).toBe(1);
      const drained = await mbB.drainFor('bob');
      expect(drained).toHaveLength(1);
      b.close();
    } finally {
      cleanup();
    }
  });

  test('persistence across in-process DB close/reopen', async () => {
    const { path, cleanup } = tmpDbPath();
    try {
      const a = new Database(path, { create: true });
      const mbA = createMailbox({ db: a });
      await mbA.send('bob', { msg: 'one' }, 'alice');
      await mbA.send('bob', { msg: 'two' }, 'alice');
      a.close();

      const b = new Database(path, { create: true });
      const mbB = createMailbox({ db: b });
      const drained = await mbB.drainFor('bob');
      expect(drained.map((e) => (e.payload as { msg: string }).msg)).toEqual(['one', 'two']);
      b.close();
    } finally {
      cleanup();
    }
  });

  test('send publishes to bus when supplied', async () => {
    const db = memDb();
    const bus: EventBus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('mailbox.message', (e) => {
      received.push(e);
    });

    const mailbox = createMailbox({ db, bus });
    const id = await mailbox.send('bob', { payload: 'ping' }, 'alice');
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(id);
    expect(received[0]?.kind).toBe('mailbox.message');
  });

  test('send without bus still persists and drains normally', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    await mailbox.send('bob', 'no-bus', 'alice');
    const drained = await mailbox.drainFor('bob');
    expect(drained).toHaveLength(1);
  });

  test('send rejects empty toAgent or fromAgent', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    await expect(mailbox.send('', 'p', 'alice')).rejects.toThrow('toAgent');
    await expect(mailbox.send('bob', 'p', '')).rejects.toThrow('fromAgent');
  });

  test('vacuum removes tombstones older than cutoff', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    await mailbox.send('bob', 1, 'alice');
    await mailbox.drainFor('bob');

    // A 60s horizon is far longer than our test took → tombstone survives.
    const recent = await mailbox.vacuum(60_000);
    expect(recent).toBe(0);

    // Simulate time passing by rewriting drained_at to a past timestamp.
    db.exec(
      `UPDATE mailbox SET drained_at = drained_at - ${8 * 24 * 60 * 60 * 1000} WHERE drained_at IS NOT NULL`,
    );
    const purged = await mailbox.vacuum();
    expect(purged).toBe(1);
  });

  test('distinct agents have independent queues', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    await mailbox.send('bob', 'b1', 'alice');
    await mailbox.send('bob', 'b2', 'alice');
    await mailbox.send('carol', 'c1', 'alice');

    expect(await mailbox.depth('bob')).toBe(2);
    expect(await mailbox.depth('carol')).toBe(1);

    const bobEvents = await mailbox.drainFor('bob');
    expect(bobEvents).toHaveLength(2);
    expect(await mailbox.depth('carol')).toBe(1);
  });

  test('payload preserves objects, arrays, and nested shapes', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    const payload = { nested: { arr: [1, 2, { k: 'v' }], b: true }, s: 'hi' };
    await mailbox.send('bob', payload, 'alice');
    const [event] = await mailbox.drainFor('bob');
    expect(event?.payload).toEqual(payload);
  });
});

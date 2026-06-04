import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EventSourceAdapter,
  type EventSourceInstance,
  type Logger,
  createExtensionRegistry,
  createPermissionGate,
  startDaemon,
} from '@declaragent/core';
import { startDaemonSocket } from './daemon-socket.js';
import { dlqList, dlqRedrive, dlqShow } from './dlq-cli.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

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
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
  };
}

/** Stub adapter with explicit DLQ entries. */
function dlqAdapter(entries: { id: string; body: string; reason: string }[]): {
  adapter: EventSourceAdapter<{ id: string }>;
  redriven: string[];
} {
  const redriven: string[] = [];
  const adapter: EventSourceAdapter<{ id: string }> = {
    type: 'dlq-stub',
    validateConfig(c: unknown): asserts c is { id: string } {
      if (!c || typeof (c as { id: string }).id !== 'string') throw new Error('bad');
    },
    async create(cfg): Promise<EventSourceInstance> {
      return {
        id: cfg.id,
        type: 'dlq-stub',
        async start() {},
        async stop() {},
        async pause() {},
        async resume() {},
        async health() {
          return { status: 'ok' };
        },
        metrics() {
          return { eventsPublished: 0, lastEventAt: null };
        },
        async listDLQ() {
          return entries.map((e) => ({
            id: e.id,
            body: e.body,
            headers: {},
            reason: e.reason,
            insertedAtMs: 1_700_000_000_000,
          }));
        },
        async showDLQ(id) {
          const e = entries.find((x) => x.id === id);
          if (!e) return undefined;
          return {
            id: e.id,
            body: e.body,
            headers: {},
            reason: e.reason,
            insertedAtMs: 1_700_000_000_000,
          };
        },
        async redriveDLQ(id) {
          redriven.push(id);
        },
      };
    },
  };
  return { adapter, redriven };
}

interface Stack {
  socketPath: string;
  redriven: string[];
  close: () => Promise<void>;
}

async function bootStack(): Promise<Stack> {
  const db = new Database(':memory:', { create: true });
  const registry = createExtensionRegistry({
    logger: NOOP_LOGGER,
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    configDir: '/tmp',
  });
  const { adapter, redriven } = dlqAdapter([
    { id: 'msg-1', body: 'one', reason: 'timeout' },
    { id: 'msg-2', body: 'two', reason: 'bad-payload' },
  ]);
  const daemon = await startDaemon({
    db,
    registry,
    adapters: { 'dlq-stub': adapter as EventSourceAdapter<unknown> },
    sources: [{ type: 'dlq-stub', config: { id: 'orders' } }],
  });
  const dir = mkdtempSync(join(tmpdir(), 'declaragent-dlq-cli-'));
  const server = await startDaemonSocket({ daemon, socketPath: join(dir, 'd.sock') });
  return {
    socketPath: server.socketPath,
    redriven,
    async close() {
      await server.close();
      await daemon.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('dlqList', () => {
  let stack: Stack;
  beforeEach(async () => {
    stack = await bootStack();
  });
  afterEach(async () => {
    await stack.close();
  });

  test('prints the DLQ entries', async () => {
    const { out, io } = captureIO();
    const code = await dlqList({ source: 'orders' }, { socketPath: stack.socketPath, io });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('dlq entries (2)');
    expect(text).toContain('msg-1');
    expect(text).toContain('timeout');
    expect(text).toContain('msg-2');
  });

  test('errors when the source adapter does not expose DLQ methods', async () => {
    const { err, io } = captureIO();
    const code = await dlqList({ source: 'unknown' }, { socketPath: stack.socketPath, io });
    expect(code).toBe(1);
    expect(err.join('')).toMatch(/no live source/);
  });

  test('errors when the daemon socket is absent', async () => {
    const { err, io } = captureIO();
    const code = await dlqList(
      { source: 'orders' },
      { socketPath: '/tmp/declaragent-does-not-exist.sock', io },
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('daemon not running');
  });
});

describe('dlqShow', () => {
  let stack: Stack;
  beforeEach(async () => {
    stack = await bootStack();
  });
  afterEach(async () => {
    await stack.close();
  });

  test('prints the entry as JSON', async () => {
    const { out, io } = captureIO();
    const code = await dlqShow('orders', 'msg-1', { socketPath: stack.socketPath, io });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.id).toBe('msg-1');
    expect(parsed.reason).toBe('timeout');
  });

  test('errors with a helpful message when the entry is missing', async () => {
    const { err, io } = captureIO();
    const code = await dlqShow('orders', 'ghost', { socketPath: stack.socketPath, io });
    expect(code).toBe(1);
    const text = err.join('');
    expect(text).toMatch(/not found/);
    // P1-12: surface a next action — the exact list command for this source.
    expect(text).toContain('declaragent dlq list --source orders');
  });
});

describe('dlqRedrive', () => {
  let stack: Stack;
  beforeEach(async () => {
    stack = await bootStack();
  });
  afterEach(async () => {
    await stack.close();
  });

  test('calls redriveDLQ on the adapter and reports success', async () => {
    const { out, io } = captureIO();
    const code = await dlqRedrive('orders', 'msg-1', { socketPath: stack.socketPath, io });
    expect(code).toBe(0);
    expect(out.join('')).toContain('redriven msg-1');
    expect(stack.redriven).toEqual(['msg-1']);
  });
});

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@declaragent/core';
import { createExtensionRegistry, createPermissionGate, startDaemon } from '@declaragent/core';
import { connectDaemonClient } from './daemon-client.js';
import { startDaemonSocket } from './daemon-socket.js';

function tmpSocket(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'declaragent-daemon-sock-'));
  return {
    path: join(dir, 'daemon.sock'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

async function bootStack(): Promise<{
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  socketPath: string;
  close(): Promise<void>;
}> {
  const db = new Database(':memory:', { create: true });
  const registry = createExtensionRegistry({
    logger: NOOP_LOGGER,
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    configDir: '/tmp',
  });
  const daemon = await startDaemon({ db, registry, adapters: {} });
  const { path, cleanup } = tmpSocket();
  const server = await startDaemonSocket({ daemon, socketPath: path });
  return {
    daemon,
    socketPath: server.socketPath,
    async close() {
      await server.close();
      await daemon.shutdown();
      db.close();
      cleanup();
    },
  };
}

describe('daemon Unix socket round-trip', () => {
  test('status returns a structured result over the socket', async () => {
    const stack = await bootStack();
    try {
      const client = await connectDaemonClient(stack.socketPath);
      try {
        const resp = await client.call({ id: 'q1', method: 'status' });
        expect(resp.method).toBe('status');
        if (resp.method === 'status' && 'result' in resp) {
          expect(resp.result.sources).toEqual([]);
          expect(resp.result.uptimeMs).toBeGreaterThanOrEqual(0);
        } else {
          throw new Error('expected result, got error');
        }
      } finally {
        client.close();
      }
    } finally {
      await stack.close();
    }
  });

  test('reload and shutdown both ack over the socket', async () => {
    const stack = await bootStack();
    try {
      const client = await connectDaemonClient(stack.socketPath);
      try {
        const reload = await client.call({ id: 'q2', method: 'reload' });
        expect(reload.method).toBe('reload');
        if (reload.method === 'reload' && 'result' in reload) {
          expect(reload.result).toEqual({
            added: [],
            removed: [],
            changed: [],
            unchanged: [],
          });
        }

        const shutdown = await client.call({ id: 'q3', method: 'shutdown' });
        expect(shutdown.method === 'shutdown' && 'result' in shutdown && shutdown.result.ok).toBe(
          true,
        );
        await stack.daemon.waitForShutdown();
      } finally {
        client.close();
      }
    } finally {
      await stack.close();
    }
  });

  test('send-event routes through the daemon dispatcher', async () => {
    const stack = await bootStack();
    try {
      const client = await connectDaemonClient(stack.socketPath);
      try {
        const resp = await client.call({
          id: 'q4',
          method: 'send-event',
          params: {
            event: {
              id: 'wire-evt',
              kind: 'user.input',
              source: { type: 'user', sessionId: 's' },
              target: { type: 'broadcast' },
              timestamp: Date.now(),
              payload: {},
              auth: { kind: 'local-user' },
            },
          },
        });
        expect(resp.method).toBe('send-event');
        if (resp.method === 'send-event' && 'result' in resp) {
          expect(resp.result.outcome).toEqual({ kind: 'broadcast' });
        } else {
          throw new Error('expected result, got error');
        }
      } finally {
        client.close();
      }
    } finally {
      await stack.close();
    }
  });

  test('concurrent calls are correlated by id', async () => {
    const stack = await bootStack();
    try {
      const client = await connectDaemonClient(stack.socketPath);
      try {
        const [a, b, c] = await Promise.all([
          client.call({ id: 'qa', method: 'status' }),
          client.call({ id: 'qb', method: 'reload' }),
          client.call({ id: 'qc', method: 'status' }),
        ]);
        expect(a.id).toBe('qa');
        expect(b.id).toBe('qb');
        expect(c.id).toBe('qc');
      } finally {
        client.close();
      }
    } finally {
      await stack.close();
    }
  });
});

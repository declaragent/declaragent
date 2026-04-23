/**
 * Unit tests for the shared control-socket client helper.
 *
 * Extraction of {@link control-socket-client.ts} (backlog #42) consolidated
 * the connect → call → close dance from `ps-cli.ts` and `dlq-dispatch-cli.ts`.
 * These tests exercise the three helper surfaces (`withControlSocketClient`,
 * `tryFetchControlSocketStatus`, `unwrapOpResult`) against a real
 * `startControlSocket`-bound daemon — no mocks below the socket layer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ControlSocketContext,
  type ControlSocketServer,
  startControlSocket,
} from '@declaragent/core';
import {
  tryFetchControlSocketStatus,
  unwrapOpResult,
  withControlSocketClient,
} from './control-socket-client.js';

function makeContext(agentId = 'test-agent'): ControlSocketContext {
  const startedAt = Date.now();
  return {
    agentId,
    pid: 1234,
    startedAt,
    sources: () => [],
    lastEventAt: () => undefined,
  };
}

describe('control-socket-client helper', () => {
  let dir: string;
  let server: ControlSocketServer | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-ctrl-sock-client-'));
    server = null;
  });

  afterEach(async () => {
    if (server) await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('withControlSocketClient invokes fn and always closes', async () => {
    const socketPath = join(dir, 'ctrl.sock');
    server = await startControlSocket({
      context: makeContext(),
      socketPath,
    });

    const pongResult = await withControlSocketClient(
      socketPath,
      { timeoutMs: 1000 },
      async (client) => {
        const resp = await client.call({ id: 'p1', op: 'ping' });
        return unwrapOpResult('ping', resp);
      },
    );
    expect(pongResult).toEqual({ pong: true });
  });

  test('withControlSocketClient closes even when fn throws', async () => {
    const socketPath = join(dir, 'ctrl.sock');
    server = await startControlSocket({
      context: makeContext(),
      socketPath,
    });

    // We can't observe close from outside, but we can prove the helper
    // doesn't swallow the error — and that a subsequent call still
    // works (the server is still alive; only the client was torn down).
    await expect(
      withControlSocketClient(socketPath, { timeoutMs: 1000 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Fresh call on the same server — if the previous client had leaked,
    // some implementations would refuse a second connect; this proves
    // the lifecycle is clean.
    const again = await withControlSocketClient(socketPath, { timeoutMs: 1000 }, async (c) =>
      c.call({ id: 'p2', op: 'ping' }),
    );
    expect(again.op).toBe('ping');
  });

  test('tryFetchControlSocketStatus returns the live snapshot', async () => {
    const socketPath = join(dir, 'ctrl.sock');
    server = await startControlSocket({
      context: makeContext('status-agent'),
      socketPath,
    });

    const status = await tryFetchControlSocketStatus(socketPath, { timeoutMs: 1000 });
    expect(status).not.toBeNull();
    expect(status?.agentId).toBe('status-agent');
    expect(status?.pid).toBe(1234);
    expect(status?.sources).toEqual([]);
  });

  test('tryFetchControlSocketStatus returns null when the socket is absent', async () => {
    // No server started — the path will ENOENT.
    const status = await tryFetchControlSocketStatus(join(dir, 'missing.sock'));
    expect(status).toBeNull();
  });

  test('unwrapOpResult narrows to the expected op', async () => {
    const socketPath = join(dir, 'ctrl.sock');
    server = await startControlSocket({
      context: makeContext(),
      socketPath,
    });

    const result = await withControlSocketClient(
      socketPath,
      { timeoutMs: 1000 },
      async (client) => {
        const resp = await client.call({ id: 's1', op: 'status' });
        // Wrong op → null
        expect(unwrapOpResult('ping', resp)).toBeNull();
        return unwrapOpResult('status', resp);
      },
    );
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe('test-agent');
  });

  test('unwrapOpResult returns null on an error response', async () => {
    // `dlq.requeue` without bus/store wired returns `{ code: 'ENOBUS' }`.
    const socketPath = join(dir, 'ctrl.sock');
    server = await startControlSocket({
      context: makeContext(),
      socketPath,
    });

    const result = await withControlSocketClient(
      socketPath,
      { timeoutMs: 1000 },
      async (client) => {
        const resp = await client.call({
          id: 'r1',
          op: 'dlq.requeue',
          params: { eventId: 'nope' },
        });
        return unwrapOpResult('dlq.requeue', resp);
      },
    );
    expect(result).toBeNull();
  });
});

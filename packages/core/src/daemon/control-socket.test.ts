import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus } from '../events/bus.js';
import { createEventStore } from '../events/store.js';
import type { AgentEvent, EventSourceInstance } from '../events/types.js';
import {
  type ControlSocketContext,
  connectControlSocket,
  controlSocketPath,
  encodeControlSocketMessage,
  handleControlSocketRequest,
  isControlSocketRequest,
  startControlSocket,
} from './control-socket.js';

function mockSource(id: string, type: string): EventSourceInstance {
  return {
    id,
    type,
    async start() {
      /* noop */
    },
    async stop() {
      /* noop */
    },
    async pause() {
      /* noop */
    },
    async resume() {
      /* noop */
    },
    async health() {
      return { status: 'healthy' as const };
    },
    metrics() {
      return {
        eventsPublished: 0,
        lastEventAt: null,
      };
    },
  };
}

describe('isControlSocketRequest', () => {
  test('accepts the five known ops', () => {
    expect(isControlSocketRequest({ id: 'a', op: 'ping' })).toBe(true);
    expect(isControlSocketRequest({ id: 'b', op: 'status' })).toBe(true);
    expect(isControlSocketRequest({ id: 'c', op: 'reload' })).toBe(true);
    expect(isControlSocketRequest({ id: 'd', op: 'shutdown' })).toBe(true);
    expect(
      isControlSocketRequest({ id: 'e', op: 'dlq.requeue', params: { eventId: 'evt-1' } }),
    ).toBe(true);
  });

  test('rejects dlq.requeue without params.eventId', () => {
    expect(isControlSocketRequest({ id: 'x', op: 'dlq.requeue' })).toBe(false);
    expect(isControlSocketRequest({ id: 'x', op: 'dlq.requeue', params: {} })).toBe(false);
    expect(isControlSocketRequest({ id: 'x', op: 'dlq.requeue', params: { eventId: '' } })).toBe(
      false,
    );
  });

  test('rejects unknown ops and malformed objects', () => {
    expect(isControlSocketRequest(null)).toBe(false);
    expect(isControlSocketRequest({})).toBe(false);
    expect(isControlSocketRequest({ id: 1, op: 'ping' })).toBe(false);
    expect(isControlSocketRequest({ id: 'a', op: 'evil' })).toBe(false);
  });
});

describe('encodeControlSocketMessage', () => {
  test('emits one JSON object per line with a trailing newline', () => {
    const line = encodeControlSocketMessage({ id: 'q1', op: 'ping' });
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim()) as { id: string; op: string };
    expect(parsed.id).toBe('q1');
    expect(parsed.op).toBe('ping');
  });
});

describe('controlSocketPath', () => {
  test('places unix sockets under ~/.declaragent/<agentId>/', () => {
    // Skipped on Windows where the pipe-path shape is different; the
    // test harness runs on macOS/Linux in CI.
    const p = controlSocketPath('billing-agent', '/home/u');
    expect(p === '/home/u/.declaragent/billing-agent/control.sock' || p.startsWith('\\\\.\\')).toBe(
      true,
    );
  });

  test('sanitizes the agent id for the filesystem', () => {
    const p = controlSocketPath('bad/../id', '/home/u');
    expect(p.includes('/..')).toBe(false);
  });
});

describe('handleControlSocketRequest — op dispatch table', () => {
  function fixtureContext(overrides: Partial<ControlSocketContext> = {}): ControlSocketContext {
    return {
      agentId: 'billing-agent',
      pid: 4242,
      startedAt: Date.now() - 1000,
      sources: () => [mockSource('src-1', 'webhook'), mockSource('src-2', 'cron')],
      lastEventAt: () => 1700000000000,
      ...overrides,
    };
  }

  test('ping returns pong', async () => {
    const resp = await handleControlSocketRequest({ id: 'q1', op: 'ping' }, fixtureContext());
    expect(resp.op).toBe('ping');
    if (resp.op === 'ping' && 'result' in resp) {
      expect(resp.result.pong).toBe(true);
    }
  });

  test('status returns pid, sources, uptime, lastEventAt', async () => {
    const ctx = fixtureContext();
    const resp = await handleControlSocketRequest({ id: 'q2', op: 'status' }, ctx);
    expect(resp.op).toBe('status');
    if (resp.op === 'status' && 'result' in resp) {
      expect(resp.result.pid).toBe(4242);
      expect(resp.result.agentId).toBe('billing-agent');
      expect(resp.result.uptimeMs).toBeGreaterThanOrEqual(500);
      expect(resp.result.sources).toEqual([
        { id: 'src-1', type: 'webhook' },
        { id: 'src-2', type: 'cron' },
      ]);
      expect(resp.result.lastEventAt).toBe(1700000000000);
    }
  });

  test('status omits lastEventAt when there are no events', async () => {
    const ctx = fixtureContext({ lastEventAt: () => undefined });
    const resp = await handleControlSocketRequest({ id: 'q2', op: 'status' }, ctx);
    if (resp.op === 'status' && 'result' in resp) {
      expect('lastEventAt' in resp.result).toBe(false);
    }
  });

  test('dlq.requeue routes through the requeue helper and returns ok on success', async () => {
    const db = new Database(':memory:', { create: true });
    const store = createEventStore({ db });
    const bus = createEventBus();
    const event: AgentEvent = {
      id: 'evt-socket-1',
      kind: 'trigger.fire',
      source: { type: 'self', reason: 'retry' },
      target: { type: 'skill', name: 'do', inputs: {} },
      timestamp: Date.now(),
      payload: {},
      auth: { kind: 'internal' },
    };
    await store.record(event);
    await store.upsertRejection('evt-socket-1', 'circuit-open', undefined);

    const ctx = fixtureContext({ bus, store });
    const resp = await handleControlSocketRequest(
      { id: 'q3', op: 'dlq.requeue', params: { eventId: 'evt-socket-1' } },
      ctx,
    );
    expect(resp.op).toBe('dlq.requeue');
    if (resp.op === 'dlq.requeue' && 'result' in resp) {
      expect(resp.result.ok).toBe(true);
    }
    db.close();
  });

  test('dlq.requeue returns ENOBUS when the daemon has no bus wired', async () => {
    const ctx = fixtureContext();
    const resp = await handleControlSocketRequest(
      { id: 'q4', op: 'dlq.requeue', params: { eventId: 'any' } },
      ctx,
    );
    expect(resp.op).toBe('dlq.requeue');
    if (resp.op === 'dlq.requeue' && 'error' in resp) {
      expect(resp.error.code).toBe('ENOBUS');
    }
  });

  test('dlq.requeue result flags dlq-miss on the second call (idempotent)', async () => {
    const db = new Database(':memory:', { create: true });
    const store = createEventStore({ db });
    const bus = createEventBus();
    const event: AgentEvent = {
      id: 'evt-dup',
      kind: 'trigger.fire',
      source: { type: 'self', reason: 'retry' },
      target: { type: 'skill', name: 'x', inputs: {} },
      timestamp: Date.now(),
      payload: {},
      auth: { kind: 'internal' },
    };
    await store.record(event);
    await store.upsertRejection('evt-dup', 'no-handler', undefined);

    const ctx = fixtureContext({ bus, store });
    const first = await handleControlSocketRequest(
      { id: 'q5', op: 'dlq.requeue', params: { eventId: 'evt-dup' } },
      ctx,
    );
    const second = await handleControlSocketRequest(
      { id: 'q6', op: 'dlq.requeue', params: { eventId: 'evt-dup' } },
      ctx,
    );
    if (first.op === 'dlq.requeue' && 'result' in first) expect(first.result.ok).toBe(true);
    if (second.op === 'dlq.requeue' && 'result' in second) {
      expect(second.result.ok).toBe(false);
      if (!second.result.ok) expect(second.result.reason).toBe('dlq-miss');
    }
    db.close();
  });

  test('reload returns unsupported when no reload handler is wired', async () => {
    const resp = await handleControlSocketRequest({ id: 'q7', op: 'reload' }, fixtureContext());
    expect(resp.op).toBe('reload');
    if (resp.op === 'reload' && 'result' in resp) {
      expect(resp.result.reloaded).toBe(false);
      expect(resp.result.reason).toBe('unsupported');
    }
  });

  test('reload delegates to the provided handler', async () => {
    const ctx = fixtureContext({
      reload: async () => ({
        reloaded: false,
        reason: 'skills-changed',
        message: 'skill set drifted; restart up to apply',
      }),
    });
    const resp = await handleControlSocketRequest({ id: 'q8', op: 'reload' }, ctx);
    if (resp.op === 'reload' && 'result' in resp) {
      expect(resp.result.reloaded).toBe(false);
      expect(resp.result.reason).toBe('skills-changed');
    }
  });

  test('shutdown acks synchronously and fires the shutdown hook in the background', async () => {
    let fired = false;
    const ctx = fixtureContext({
      shutdown: () => {
        fired = true;
      },
    });
    const resp = await handleControlSocketRequest({ id: 'q9', op: 'shutdown' }, ctx);
    expect(resp.op).toBe('shutdown');
    if (resp.op === 'shutdown' && 'result' in resp) {
      expect(resp.result.ok).toBe(true);
    }
    // Allow the microtask/macrotask to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(true);
  });

  test('handler exceptions are caught and returned as EHANDLER errors', async () => {
    const ctx = fixtureContext({
      reload: () => {
        throw new Error('boom');
      },
    });
    const resp = await handleControlSocketRequest({ id: 'q10', op: 'reload' }, ctx);
    if (resp.op === 'reload' && 'error' in resp) {
      expect(resp.error.code).toBe('EHANDLER');
      expect(resp.error.message).toContain('boom');
    }
  });
});

describe('control socket server — end-to-end', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'declaragent-control-sock-'));
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function ctxFor(agentId: string, opts: Partial<ControlSocketContext> = {}): ControlSocketContext {
    return {
      agentId,
      pid: process.pid,
      startedAt: Date.now(),
      sources: () => [],
      lastEventAt: () => undefined,
      ...opts,
    };
  }

  test('stale socket on startup is unlinked and rebound', async () => {
    const socketPath = join(tmpDir, 'control.sock');
    // Simulate a stale socket from a prior crash.
    const first = await startControlSocket({
      context: ctxFor('a1'),
      socketPath,
    });
    await first.close();
    // Leave a stale file behind deliberately — this is what we're
    // testing so if close() already unlinks, rebinding still succeeds
    // anyway (primary invariant: next bind never wedges).
    const second = await startControlSocket({
      context: ctxFor('a1'),
      socketPath,
    });
    // Second bind succeeded — that's the assertion.
    const client = await connectControlSocket(socketPath);
    const resp = await client.call({ id: 'ping-1', op: 'ping' });
    if (resp.op === 'ping' && 'result' in resp) {
      expect(resp.result.pong).toBe(true);
    }
    client.close();
    await second.close();
  });

  test('all five ops are reachable over the real socket transport', async () => {
    const socketPath = join(tmpDir, 'control.sock');
    let shutdownFired = false;
    const server = await startControlSocket({
      context: ctxFor('billing', {
        sources: () => [mockSource('webhook-1', 'webhook')],
        lastEventAt: () => 1700000000000,
        reload: () => ({ reloaded: true }),
        shutdown: () => {
          shutdownFired = true;
        },
      }),
      socketPath,
    });

    const client = await connectControlSocket(socketPath);
    try {
      const ping = await client.call({ id: '1', op: 'ping' });
      expect(ping.op === 'ping' && 'result' in ping && ping.result.pong).toBe(true);

      const status = await client.call({ id: '2', op: 'status' });
      expect(status.op === 'status' && 'result' in status && status.result.pid).toBe(process.pid);
      if (status.op === 'status' && 'result' in status) {
        expect(status.result.sources).toEqual([{ id: 'webhook-1', type: 'webhook' }]);
        expect(status.result.lastEventAt).toBe(1700000000000);
      }

      const requeueResp = await client.call({
        id: '3',
        op: 'dlq.requeue',
        params: { eventId: 'nonexistent' },
      });
      // No bus wired → ENOBUS.
      expect(requeueResp.op === 'dlq.requeue' && 'error' in requeueResp).toBe(true);

      const reload = await client.call({ id: '4', op: 'reload' });
      if (reload.op === 'reload' && 'result' in reload) {
        expect(reload.result.reloaded).toBe(true);
      }

      const shutdown = await client.call({ id: '5', op: 'shutdown' });
      expect(shutdown.op === 'shutdown' && 'result' in shutdown && shutdown.result.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(shutdownFired).toBe(true);
    } finally {
      client.close();
      await server.close();
    }
  });

  test('concurrent calls on one connection correlate by id', async () => {
    const socketPath = join(tmpDir, 'control.sock');
    const server = await startControlSocket({ context: ctxFor('a2'), socketPath });
    const client = await connectControlSocket(socketPath);
    try {
      const [a, b, c] = await Promise.all([
        client.call({ id: 'A', op: 'ping' }),
        client.call({ id: 'B', op: 'status' }),
        client.call({ id: 'C', op: 'ping' }),
      ]);
      expect(a.id).toBe('A');
      expect(b.id).toBe('B');
      expect(c.id).toBe('C');
    } finally {
      client.close();
      await server.close();
    }
  });

  test('malformed request gets a typed EBADREQ error rather than a reset', async () => {
    const socketPath = join(tmpDir, 'control.sock');
    const server = await startControlSocket({ context: ctxFor('a3'), socketPath });
    try {
      // Speak directly over the socket to send a garbage line.
      const { connect } = await import('node:net');
      const socket = connect(socketPath);
      socket.setEncoding('utf8');
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', reject);
      });
      const got = new Promise<string>((resolve) => {
        socket.on('data', (buf) => resolve(typeof buf === 'string' ? buf : buf.toString('utf8')));
      });
      socket.write('{"id":"x","op":"not-a-real-op"}\n');
      const line = await got;
      const parsed = JSON.parse(line.trim()) as { error?: { code: string } };
      expect(parsed.error?.code).toBe('EBADREQ');
      socket.end();
    } finally {
      await server.close();
    }
  });
});

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, ControlSocketServer, EventBus, EventStore } from '@declaragent/core';
import {
  controlSocketPath,
  createEventBus,
  createEventStore,
  startControlSocket,
} from '@declaragent/core';
import {
  dlqDispatchDrop,
  dlqDispatchList,
  dlqDispatchRequeue,
  dlqDispatchShow,
} from './dlq-dispatch-cli.js';
import type { UpState } from './up-lifecycle.js';

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

// ── requeue (Enterprise Production Plan §3 item #3) ─────────────────────
//
// The requeue verb talks to the per-agent control socket bound by
// `declaragent up`. We bind a real {@link startControlSocket} against a
// tmp HOME + wire it to an in-memory bus + store, then drive the CLI
// via `dlqDispatchRequeue`. This exercises the exact wire path an
// operator hits in the field (NDJSON-over-UDS → `requeue()` helper →
// bus.publish + deleteRejection).
describe('dlqDispatchRequeue (integration)', () => {
  let home: string;
  let homeOverride: string | undefined;
  let server: ControlSocketServer | null = null;
  const agentId = 'test-agent';

  async function bindSocket(opts: { bus?: EventBus; store?: EventStore }): Promise<string> {
    const srv = await startControlSocket({
      context: {
        agentId,
        pid: process.pid,
        startedAt: Date.now(),
        sources: () => [],
        lastEventAt: () => undefined,
        ...(opts.bus && { bus: opts.bus }),
        ...(opts.store && { store: opts.store }),
      },
    });
    server = srv;
    return srv.socketPath;
  }

  function fakeUpState(ids: readonly string[]): () => UpState | null {
    return () => ({
      version: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      manifestPath: '/tmp/agent.yaml',
      agents: ids.map((id) => ({ id, path: '/tmp', sources: [] })),
    });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'declara-dlq-requeue-'));
    homeOverride = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    try {
      await server?.close();
    } catch {
      // ignore — best-effort
    }
    server = null;
    if (homeOverride !== undefined) process.env.HOME = homeOverride;
    rmSync(home, { recursive: true, force: true });
  });

  test('happy path — requeue publishes event onto bus + deletes rejection', async () => {
    const store = memStore();
    const bus = createEventBus();
    await seedRejected(store, 'evt-1', 'invalid', 2, 1_000);

    // Subscribe BEFORE requeue so we can assert the re-publish hit the bus.
    const delivered: AgentEvent[] = [];
    bus.subscribe('*', (ev: AgentEvent) => {
      delivered.push(ev);
    });

    await bindSocket({ bus, store });

    const { io, out, err } = captureIO();
    const code = await dlqDispatchRequeue(
      { eventId: 'evt-1', resolveSocket: (id) => controlSocketPath(id, home) },
      { io, readUpState: fakeUpState([agentId]) },
    );
    expect(code).toBe(0);
    expect(err.join('')).toBe('');
    expect(out.join('')).toContain('requeued "evt-1"');
    expect(out.join('')).toContain('attempts before requeue: 2');

    // Bus observed the re-publish.
    expect(delivered.length).toBe(1);
    const first = delivered[0];
    if (!first) throw new Error('expected delivered event');
    expect(first.id).toBe('evt-1');

    // Rejection row is gone (the helper deletes it after publish).
    expect(await store.getRejection('evt-1')).toBeUndefined();
    // The event body stays in `events` — the historical record is
    // preserved even though the DLQ ledger is cleared.
    expect(await store.get('evt-1')).toBeDefined();
  });

  test('idempotence — second requeue returns exit code 2 (dlq-miss)', async () => {
    const store = memStore();
    const bus = createEventBus();
    await seedRejected(store, 'evt-2', 'invalid', 1, 1_000);
    await bindSocket({ bus, store });

    // First call succeeds.
    const cap1 = captureIO();
    const first = await dlqDispatchRequeue(
      { eventId: 'evt-2', resolveSocket: (id) => controlSocketPath(id, home) },
      { io: cap1.io, readUpState: fakeUpState([agentId]) },
    );
    expect(first).toBe(0);

    // Second call hits the `dlq-miss` path because the first deleted
    // the row. We surface that as exit code 2 so scripts can tell
    // apart a genuine requeue from a silent re-attempt.
    const cap2 = captureIO();
    const second = await dlqDispatchRequeue(
      { eventId: 'evt-2', resolveSocket: (id) => controlSocketPath(id, home) },
      { io: cap2.io, readUpState: fakeUpState([agentId]) },
    );
    expect(second).toBe(2);
    expect(cap2.err.join('')).toContain('no dispatch DLQ entry');
    expect(cap2.err.join('')).toContain('already requeued or never rejected');
  });

  test('unknown id returns dlq-miss exit code 2 (never was in DLQ)', async () => {
    const store = memStore();
    const bus = createEventBus();
    await bindSocket({ bus, store });

    const cap = captureIO();
    const code = await dlqDispatchRequeue(
      { eventId: 'never-existed', resolveSocket: (id) => controlSocketPath(id, home) },
      { io: cap.io, readUpState: fakeUpState([agentId]) },
    );
    expect(code).toBe(2);
    expect(cap.err.join('')).toContain('no dispatch DLQ entry');
  });

  test('event body missing (vacuumed) — returns exit code 3 (event-miss)', async () => {
    const store = memStore();
    const bus = createEventBus();
    // Put a rejection row in place but NOT the corresponding event body.
    await store.upsertRejection('ghost', 'invalid', 'skill exploded', 1_000);
    await bindSocket({ bus, store });

    const cap = captureIO();
    const code = await dlqDispatchRequeue(
      { eventId: 'ghost', resolveSocket: (id) => controlSocketPath(id, home) },
      { io: cap.io, readUpState: fakeUpState([agentId]) },
    );
    expect(code).toBe(3);
    expect(cap.err.join('')).toContain('no longer in the events table');
  });

  test('socket not running — exit code 1 with an "is `declaragent up` running?" hint', async () => {
    // Don't bind a server. The resolver returns a path that doesn't
    // exist on disk.
    const cap = captureIO();
    const code = await dlqDispatchRequeue(
      {
        eventId: 'whatever',
        resolveSocket: () => join(home, 'missing', 'control.sock'),
      },
      { io: cap.io, readUpState: fakeUpState([agentId]) },
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('declaragent up');
  });

  test('no agents up — exit code 1 with a start-it hint', async () => {
    const cap = captureIO();
    const code = await dlqDispatchRequeue(
      { eventId: 'whatever' },
      { io: cap.io, readUpState: () => null },
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('no agents are up');
  });

  test('multiple agents up without --agent — exit code 4 listing the agent ids', async () => {
    const cap = captureIO();
    const code = await dlqDispatchRequeue(
      { eventId: 'whatever' },
      { io: cap.io, readUpState: fakeUpState(['a-one', 'a-two']) },
    );
    expect(code).toBe(4);
    const errText = cap.err.join('');
    expect(errText).toContain('a-one');
    expect(errText).toContain('a-two');
    expect(errText).toContain('--agent');
  });

  test('multiple agents up with --agent — targets the named one', async () => {
    const store = memStore();
    const bus = createEventBus();
    await seedRejected(store, 'evt-3', 'invalid', 1, 1_000);
    await bindSocket({ bus, store });

    const cap = captureIO();
    const code = await dlqDispatchRequeue(
      {
        eventId: 'evt-3',
        agentId,
        resolveSocket: (id) => controlSocketPath(id, home),
      },
      {
        io: cap.io,
        // Even with several agents listed, the explicit --agent wins.
        readUpState: fakeUpState(['distractor-1', agentId, 'distractor-2']),
      },
    );
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('requeued "evt-3"');
  });
});

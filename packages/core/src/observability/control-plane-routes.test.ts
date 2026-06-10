import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { createSqliteAuditSink } from '../audit/sqlite-sink.js';
import type { TenantAuditRecord } from '../audit/types.js';
import { createEventStore } from '../events/store.js';
import type { AgentEvent, DispatchOutcome } from '../events/types.js';
import {
  type AuditResponse,
  type DlqMutationResponse,
  type DlqResponse,
  type EventsResponse,
  auditRoute,
  dlqDropRoute,
  dlqRequeueRoute,
  dlqRoute,
  eventsRoute,
} from './control-plane-routes.js';
import {
  type ControlPlaneServerInstance,
  type ControlPlaneServerListenOptions,
  startControlPlaneServer,
} from './control-plane-server.js';

// ── Harness ────────────────────────────────────────────────────────────────

interface FakeServer extends ControlPlaneServerInstance {
  readonly fetch: ControlPlaneServerListenOptions['fetch'];
}

async function startFake(routes: Parameters<typeof startControlPlaneServer>[0]['routes']): Promise<{
  handle: Awaited<ReturnType<typeof startControlPlaneServer>>;
  server: FakeServer;
}> {
  let captured: FakeServer | null = null;
  const listen: NonNullable<Parameters<typeof startControlPlaneServer>[0]['listen']> = async ({
    port,
    hostname,
    fetch,
  }) => {
    const server: FakeServer = {
      port,
      hostname,
      fetch,
      stop() {},
    };
    captured = server;
    return server;
  };
  const handle = await startControlPlaneServer({ routes, listen });
  if (!captured) throw new Error('listen stub did not run');
  return { handle, server: captured };
}

const LOCAL_HEADERS = { host: '127.0.0.1:9464' } as const;

function memDb(): Database {
  return new Database(':memory:', { create: true });
}

function makeEvent(overrides: Partial<AgentEvent> & { id: string; timestamp: number }): AgentEvent {
  return {
    kind: 'webhook.received',
    source: { type: 'webhook', triggerId: 't', remoteAddr: '10.0.0.1' },
    target: { type: 'session', sessionId: 'sess-x', mode: 'inject' },
    payload: {},
    auth: { kind: 'internal' },
    ...overrides,
  };
}

// ── /events tests ──────────────────────────────────────────────────────────

describe('eventsRoute', () => {
  it('returns a page of events with nextCursor=null when no more data', async () => {
    const store = createEventStore({ db: memDb() });
    for (let i = 0; i < 3; i += 1) {
      await store.record(makeEvent({ id: `e${i}`, timestamp: 1_000 + i }));
    }
    const { server, handle } = await startFake([eventsRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/events?limit=10', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsResponse;
    expect(body.events).toHaveLength(3);
    // DESC by ts: e2, e1, e0
    expect(body.events.map((e) => e.id)).toEqual(['e2', 'e1', 'e0']);
    expect(body.nextCursor).toBeNull();
    await handle.close();
  });

  it('paginates with an opaque cursor across two pages', async () => {
    const store = createEventStore({ db: memDb() });
    for (let i = 0; i < 5; i += 1) {
      await store.record(makeEvent({ id: `e${i}`, timestamp: 1_000 + i }));
    }
    const { server, handle } = await startFake([eventsRoute(store)]);

    const page1 = (await (
      await server.fetch(new Request('http://127.0.0.1/events?limit=2', { headers: LOCAL_HEADERS }))
    ).json()) as EventsResponse;
    expect(page1.events.map((e) => e.id)).toEqual(['e4', 'e3']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await (
      await server.fetch(
        new Request(
          `http://127.0.0.1/events?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
          { headers: LOCAL_HEADERS },
        ),
      )
    ).json()) as EventsResponse;
    expect(page2.events.map((e) => e.id)).toEqual(['e2', 'e1']);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = (await (
      await server.fetch(
        new Request(
          `http://127.0.0.1/events?limit=2&cursor=${encodeURIComponent(page2.nextCursor as string)}`,
          { headers: LOCAL_HEADERS },
        ),
      )
    ).json()) as EventsResponse;
    expect(page3.events.map((e) => e.id)).toEqual(['e0']);
    expect(page3.nextCursor).toBeNull();

    await handle.close();
  });

  it('applies the state=circuit-open filter', async () => {
    const store = createEventStore({ db: memDb() });
    for (let i = 0; i < 3; i += 1) {
      await store.record(makeEvent({ id: `ok-${i}`, timestamp: 1_000 + i }));
      await store.markOutcome(`ok-${i}`, {
        kind: 'dispatched',
        sessionId: 's',
      } satisfies DispatchOutcome);
    }
    await store.record(makeEvent({ id: 'broken', timestamp: 2_000 }));
    await store.markOutcome('broken', {
      kind: 'rejected',
      reason: 'circuit-open',
    } satisfies DispatchOutcome);

    const { server, handle } = await startFake([eventsRoute(store)]);
    const body = (await (
      await server.fetch(
        new Request('http://127.0.0.1/events?state=circuit-open&limit=10', {
          headers: LOCAL_HEADERS,
        }),
      )
    ).json()) as EventsResponse;
    expect(body.events.map((e) => e.id)).toEqual(['broken']);
    await handle.close();
  });

  it('returns 400 on an unknown state value', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([eventsRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/events?state=nope', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/state/);
    await handle.close();
  });

  it('returns 400 on a malformed cursor', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([eventsRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/events?cursor=not-base64!!', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cursor/);
    await handle.close();
  });

  it('returns 400 on a non-numeric limit', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([eventsRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/events?limit=abc', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });

  it('returns 400 when limit exceeds maxLimit', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([eventsRoute(store, { maxLimit: 5 })]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/events?limit=100', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });

  it('returns 405 on non-GET/HEAD', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([eventsRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/events', {
        method: 'POST',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(405);
    await handle.close();
  });
});

// ── /dlq tests ─────────────────────────────────────────────────────────────

describe('dlqRoute', () => {
  it('returns rejections newest-first with nextCursor=null', async () => {
    const store = createEventStore({ db: memDb() });
    await store.upsertRejection('a', 'circuit-open', 'boom', 1_000);
    await store.upsertRejection('b', 'rate-limit', undefined, 2_000);

    const { server, handle } = await startFake([dlqRoute(store)]);
    const body = (await (
      await server.fetch(new Request('http://127.0.0.1/dlq?limit=10', { headers: LOCAL_HEADERS }))
    ).json()) as DlqResponse;
    expect(body.rejections.map((r) => r.eventId)).toEqual(['b', 'a']);
    expect(body.nextCursor).toBeNull();
    await handle.close();
  });

  it('paginates across two pages', async () => {
    const store = createEventStore({ db: memDb() });
    for (let i = 0; i < 5; i += 1) {
      await store.upsertRejection(`r${i}`, 'circuit-open', undefined, 1_000 + i);
    }
    const { server, handle } = await startFake([dlqRoute(store)]);
    const page1 = (await (
      await server.fetch(new Request('http://127.0.0.1/dlq?limit=2', { headers: LOCAL_HEADERS }))
    ).json()) as DlqResponse;
    expect(page1.rejections.map((r) => r.eventId)).toEqual(['r4', 'r3']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await (
      await server.fetch(
        new Request(
          `http://127.0.0.1/dlq?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
          { headers: LOCAL_HEADERS },
        ),
      )
    ).json()) as DlqResponse;
    expect(page2.rejections.map((r) => r.eventId)).toEqual(['r2', 'r1']);
    await handle.close();
  });

  it('filters by minAttempts', async () => {
    const store = createEventStore({ db: memDb() });
    await store.upsertRejection('once', 'circuit-open', undefined, 1_000);
    await store.upsertRejection('twice', 'circuit-open', undefined, 2_000);
    await store.upsertRejection('twice', 'circuit-open', undefined, 3_000);

    const { server, handle } = await startFake([dlqRoute(store)]);
    const body = (await (
      await server.fetch(
        new Request('http://127.0.0.1/dlq?minAttempts=2&limit=10', {
          headers: LOCAL_HEADERS,
        }),
      )
    ).json()) as DlqResponse;
    expect(body.rejections.map((r) => r.eventId)).toEqual(['twice']);
    await handle.close();
  });

  it('returns 400 on unsupported kind', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([dlqRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq?kind=mcp', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });

  it('returns 400 on malformed cursor', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([dlqRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq?cursor=!!!', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });

  it('returns 400 on non-positive minAttempts', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([dlqRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq?minAttempts=0', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });
});

// ── /dlq/drop + /dlq/requeue tests ─────────────────────────────────────────

describe('dlqDropRoute', () => {
  it('removes a DLQ row and returns 200 ok', async () => {
    const store = createEventStore({ db: memDb() });
    await store.upsertRejection('evt-1', 'circuit-open', undefined, 1_000);

    const { server, handle } = await startFake([dlqDropRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq/drop?kind=dispatch&id=evt-1', {
        method: 'POST',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DlqMutationResponse;
    expect(body.ok).toBe(true);
    expect(body.op).toBe('drop');
    expect(body.eventId).toBe('evt-1');
    expect(body.attemptsBeforeOp).toBe(1);

    // Row actually gone:
    const gone = await store.getRejection('evt-1');
    expect(gone).toBeFalsy();
    await handle.close();
  });

  it('returns 404 with not-found when the id is absent', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([dlqDropRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq/drop?kind=dispatch&id=nope', {
        method: 'POST',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as DlqMutationResponse;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('not-found');
    await handle.close();
  });

  it('fires onAudit with initiator, op, ok, and attempts', async () => {
    const store = createEventStore({ db: memDb() });
    await store.upsertRejection('evt-a', 'circuit-open', undefined, 1_000);
    const captured: Array<Record<string, unknown>> = [];
    const route = dlqDropRoute(store, {
      onAudit: (r) => {
        captured.push(r);
      },
    });
    const { server, handle } = await startFake([route]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq/drop?kind=dispatch&id=evt-a', {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'x-declaragent-initiator': 'alice' },
      }),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const rec = captured[0];
    expect(rec).toBeDefined();
    expect(rec?.op).toBe('drop');
    expect(rec?.ok).toBe(true);
    expect(rec?.initiator).toBe('alice');
    expect(rec?.attemptsBeforeOp).toBe(1);
    expect(rec?.dlqKind).toBe('dispatch');
    await handle.close();
  });

  it('rejects GET with 405', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([dlqDropRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq/drop?kind=dispatch&id=x', {
        method: 'GET',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(405);
    await handle.close();
  });

  it('returns 400 when id is missing', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([dlqDropRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq/drop?kind=dispatch', {
        method: 'POST',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });

  it('returns 400 on unsupported kind', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([dlqDropRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq/drop?kind=mcp&id=x', {
        method: 'POST',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });
});

describe('dlqRequeueRoute', () => {
  it('republishes the event and deletes the rejection row', async () => {
    const store = createEventStore({ db: memDb() });
    const event = makeEvent({ id: 'evt-r', timestamp: 1_000 });
    await store.record(event);
    await store.upsertRejection('evt-r', 'circuit-open', undefined, 1_500);
    const published: AgentEvent[] = [];
    const bus = {
      publish: async (e: AgentEvent) => {
        published.push(e);
      },
      subscribe: () => () => {},
      recent: () => [],
      drained: async () => {},
      registerPressureListener: () => () => {},
      inflightCount: () => 0,
    };
    const { server, handle } = await startFake([dlqRequeueRoute({ store, bus })]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq/requeue?kind=dispatch&id=evt-r', {
        method: 'POST',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as DlqMutationResponse;
    expect(body.ok).toBe(true);
    expect(body.op).toBe('requeue');
    expect(body.attemptsBeforeOp).toBe(1);
    expect(published).toHaveLength(1);
    // Re-dispatched under a fresh id with lineage (same-id republish was a
    // dedup no-op).
    expect(published[0]?.id).not.toBe('evt-r');
    expect(published[0]?.meta?.causedBy).toBe('evt-r');
    const gone = await store.getRejection('evt-r');
    expect(gone).toBeFalsy();
    await handle.close();
  });

  it('returns 404 with dlq-miss on absent id', async () => {
    const store = createEventStore({ db: memDb() });
    const bus = {
      publish: async (_e: AgentEvent) => {},
      subscribe: () => () => {},
      recent: () => [],
      drained: async () => {},
      registerPressureListener: () => () => {},
      inflightCount: () => 0,
    };
    const { server, handle } = await startFake([dlqRequeueRoute({ store, bus })]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq/requeue?kind=dispatch&id=nope', {
        method: 'POST',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as DlqMutationResponse;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('dlq-miss');
    await handle.close();
  });

  it('fires onAudit with requeue op tag', async () => {
    const store = createEventStore({ db: memDb() });
    const event = makeEvent({ id: 'evt-q', timestamp: 1_000 });
    await store.record(event);
    await store.upsertRejection('evt-q', 'circuit-open', undefined, 1_500);
    const bus = {
      publish: async (_e: AgentEvent) => {},
      subscribe: () => () => {},
      recent: () => [],
      drained: async () => {},
      registerPressureListener: () => () => {},
      inflightCount: () => 0,
    };
    const captured: Array<Record<string, unknown>> = [];
    const route = dlqRequeueRoute(
      { store, bus },
      {
        onAudit: (r) => {
          captured.push(r);
        },
      },
    );
    const { server, handle } = await startFake([route]);
    await server.fetch(
      new Request('http://127.0.0.1/dlq/requeue?kind=dispatch&id=evt-q', {
        method: 'POST',
        headers: { ...LOCAL_HEADERS, 'x-declaragent-initiator': 'bob' },
      }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.op).toBe('requeue');
    expect(captured[0]?.ok).toBe(true);
    expect(captured[0]?.initiator).toBe('bob');
    await handle.close();
  });
});

// ── /audit tests ───────────────────────────────────────────────────────────

describe('auditRoute', () => {
  async function seedAudit(
    entries: number,
  ): Promise<Awaited<ReturnType<typeof createSqliteAuditSink>>> {
    const sink = await createSqliteAuditSink({ path: ':memory:' });
    for (let i = 0; i < entries; i += 1) {
      const rec: TenantAuditRecord = {
        kind: 'tool_call',
        ts: 1_000 + i,
        tenantId: 'tenant-a',
        sessionId: `sess-${i}`,
        tool: 'bash',
        permissionKey: 'bash(*)',
        outcome: 'allow',
      };
      await sink.record(rec);
    }
    return sink;
  }

  it('returns entries in ASC seq order with nextCursor=null when done', async () => {
    const sink = await seedAudit(3);
    const { server, handle } = await startFake([auditRoute(sink)]);
    const body = (await (
      await server.fetch(new Request('http://127.0.0.1/audit?limit=10', { headers: LOCAL_HEADERS }))
    ).json()) as AuditResponse;
    expect(body.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(body.nextCursor).toBeNull();
    expect(body.verify).toBeUndefined();
    await handle.close();
  });

  it('paginates across two pages', async () => {
    const sink = await seedAudit(5);
    const { server, handle } = await startFake([auditRoute(sink)]);
    const page1 = (await (
      await server.fetch(new Request('http://127.0.0.1/audit?limit=2', { headers: LOCAL_HEADERS }))
    ).json()) as AuditResponse;
    expect(page1.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = (await (
      await server.fetch(
        new Request(
          `http://127.0.0.1/audit?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
          { headers: LOCAL_HEADERS },
        ),
      )
    ).json()) as AuditResponse;
    expect(page2.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = (await (
      await server.fetch(
        new Request(
          `http://127.0.0.1/audit?limit=2&cursor=${encodeURIComponent(page2.nextCursor as string)}`,
          { headers: LOCAL_HEADERS },
        ),
      )
    ).json()) as AuditResponse;
    expect(page3.entries.map((e) => e.seq)).toEqual([5]);
    expect(page3.nextCursor).toBeNull();
    await handle.close();
  });

  it('attaches verify summary when ?verify=1', async () => {
    const sink = await seedAudit(3);
    const { server, handle } = await startFake([auditRoute(sink)]);
    const body = (await (
      await server.fetch(
        new Request('http://127.0.0.1/audit?verify=1&limit=10', { headers: LOCAL_HEADERS }),
      )
    ).json()) as AuditResponse;
    expect(body.verify).toBeDefined();
    expect(body.verify?.ok).toBe(true);
    expect(body.verify?.totalEntries).toBe(3);
    expect(body.verify?.verifiedEntries).toBe(3);
    expect(body.verify?.violationCount).toBe(0);
    await handle.close();
  });

  it('returns 400 on malformed cursor', async () => {
    const sink = await seedAudit(1);
    const { server, handle } = await startFake([auditRoute(sink)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/audit?cursor=garbage!!!', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });

  it('returns 400 on bad since', async () => {
    const sink = await seedAudit(1);
    const { server, handle } = await startFake([auditRoute(sink)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/audit?since=not-a-date', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });

  it('returns 405 on non-GET/HEAD', async () => {
    const sink = await seedAudit(1);
    const { server, handle } = await startFake([auditRoute(sink)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/audit', {
        method: 'DELETE',
        headers: LOCAL_HEADERS,
      }),
    );
    expect(res.status).toBe(405);
    await handle.close();
  });

  it('filters by tenant', async () => {
    const sink = await createSqliteAuditSink({ path: ':memory:' });
    await sink.record({
      kind: 'tool_call',
      ts: 1,
      tenantId: 'a',
      sessionId: 's',
      tool: 'bash',
      permissionKey: 'bash(*)',
      outcome: 'allow',
    });
    await sink.record({
      kind: 'tool_call',
      ts: 2,
      tenantId: 'b',
      sessionId: 's',
      tool: 'bash',
      permissionKey: 'bash(*)',
      outcome: 'allow',
    });
    const { server, handle } = await startFake([auditRoute(sink)]);
    const body = (await (
      await server.fetch(
        new Request('http://127.0.0.1/audit?tenant=b&limit=10', { headers: LOCAL_HEADERS }),
      )
    ).json()) as AuditResponse;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.tenantId).toBe('b');
    await handle.close();
  });
});

// ── Multi-agent fan-out (#19) ──────────────────────────────────────────────

describe('eventsRoute ?all=1 fan-out', () => {
  it('merges events across agents DESC by timestamp when ?all=1', async () => {
    const storeA = createEventStore({ db: memDb() });
    const storeB = createEventStore({ db: memDb() });
    await storeA.record(makeEvent({ id: 'a1', timestamp: 100 }));
    await storeA.record(makeEvent({ id: 'a2', timestamp: 300 }));
    await storeB.record(makeEvent({ id: 'b1', timestamp: 200 }));
    await storeB.record(makeEvent({ id: 'b2', timestamp: 400 }));

    const route = eventsRoute(storeA, {
      fanOut: () => [
        { agentId: 'agent-a', store: storeA },
        { agentId: 'agent-b', store: storeB },
      ],
    });
    const { server, handle } = await startFake([route]);
    const body = (await (
      await server.fetch(
        new Request('http://127.0.0.1/events?all=1&limit=10', { headers: LOCAL_HEADERS }),
      )
    ).json()) as EventsResponse;
    expect(body.events.map((e) => e.id)).toEqual(['b2', 'a2', 'b1', 'a1']);
    // agentId tag is surfaced on every row under `?all=1`.
    const byId = new Map(body.events.map((e) => [e.id, e.agentId]));
    expect(byId.get('a1')).toBe('agent-a');
    expect(byId.get('b1')).toBe('agent-b');
    await handle.close();
  });

  it('single-agent response does NOT populate agentId (back-compat)', async () => {
    const store = createEventStore({ db: memDb() });
    await store.record(makeEvent({ id: 'x', timestamp: 1 }));
    const { server, handle } = await startFake([eventsRoute(store)]);
    const body = (await (
      await server.fetch(
        new Request('http://127.0.0.1/events?limit=10', { headers: LOCAL_HEADERS }),
      )
    ).json()) as EventsResponse;
    expect(body.events[0]?.agentId).toBeUndefined();
    await handle.close();
  });

  it('returns 400 on ?all=1 when no fanOut provider is configured', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([eventsRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/events?all=1', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/all=1/);
    await handle.close();
  });

  it('returns an empty page when fanOut yields zero agents', async () => {
    const store = createEventStore({ db: memDb() });
    const route = eventsRoute(store, { fanOut: () => [] });
    const { server, handle } = await startFake([route]);
    const body = (await (
      await server.fetch(
        new Request('http://127.0.0.1/events?all=1&limit=10', { headers: LOCAL_HEADERS }),
      )
    ).json()) as EventsResponse;
    expect(body.events).toEqual([]);
    expect(body.nextCursor).toBeNull();
    await handle.close();
  });
});

describe('dlqRoute ?all=1 fan-out', () => {
  it('merges rejections across agents DESC by lastSeenMs when ?all=1', async () => {
    const storeA = createEventStore({ db: memDb() });
    const storeB = createEventStore({ db: memDb() });
    await storeA.upsertRejection('a-only', 'circuit-open', undefined, 1_000);
    await storeB.upsertRejection('b-only', 'rate-limit', undefined, 2_000);

    const route = dlqRoute(storeA, {
      fanOut: () => [
        { agentId: 'agent-a', store: storeA },
        { agentId: 'agent-b', store: storeB },
      ],
    });
    const { server, handle } = await startFake([route]);
    const body = (await (
      await server.fetch(
        new Request('http://127.0.0.1/dlq?all=1&limit=10', { headers: LOCAL_HEADERS }),
      )
    ).json()) as DlqResponse;
    expect(body.rejections.map((r) => r.eventId)).toEqual(['b-only', 'a-only']);
    const byId = new Map(body.rejections.map((r) => [r.eventId, r.agentId]));
    expect(byId.get('a-only')).toBe('agent-a');
    expect(byId.get('b-only')).toBe('agent-b');
    await handle.close();
  });

  it('returns 400 on ?all=1 when no fanOut provider is configured', async () => {
    const store = createEventStore({ db: memDb() });
    const { server, handle } = await startFake([dlqRoute(store)]);
    const res = await server.fetch(
      new Request('http://127.0.0.1/dlq?all=1', { headers: LOCAL_HEADERS }),
    );
    expect(res.status).toBe(400);
    await handle.close();
  });

  it('single-agent response does NOT populate agentId (back-compat)', async () => {
    const store = createEventStore({ db: memDb() });
    await store.upsertRejection('x', 'circuit-open', undefined, 1_000);
    const { server, handle } = await startFake([dlqRoute(store)]);
    const body = (await (
      await server.fetch(new Request('http://127.0.0.1/dlq?limit=10', { headers: LOCAL_HEADERS }))
    ).json()) as DlqResponse;
    expect(body.rejections[0]?.agentId).toBeUndefined();
    await handle.close();
  });
});

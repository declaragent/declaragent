/**
 * CLI verb tests for cross-host `fleet ps / events / dlq / logs`.
 *
 * These exercise the merge + error-isolation + `--host` filter paths
 * end-to-end with a mock client — zero network, zero fleet.yaml I/O
 * (the tests pass `hosts` directly through the deps seam).
 */

import { describe, expect, it } from 'bun:test';
import type { DlqResponse, EventsResponse, FleetHost, UpStatusSnapshot } from '@declaragent/core';
import type { CrossHostControlPlaneClient } from './cross-host-control-plane-client.js';
import {
  fleetDlqDrop,
  fleetDlqList,
  fleetDlqRequeue,
  fleetEventsList,
  fleetLogs,
  fleetPs,
} from './fleet-cross-host-cli.js';

/**
 * Default mutation stubs so pre-existing mock clients remain compatible
 * with the extended {@link CrossHostControlPlaneClient} surface (Slice 6b
 * adds `dropDlqEntry` + `requeueDlqEntry`). Tests that exercise the
 * mutation paths override these explicitly.
 */
const MUTATION_STUBS = {
  dropDlqEntry: async () => ({ ok: true as const, op: 'drop' as const, eventId: 'stub' }),
  requeueDlqEntry: async () => ({ ok: true as const, op: 'requeue' as const, eventId: 'stub' }),
};

function makeIO(): {
  io: { out: (s: string) => void; err: (s: string) => void };
  outBuf: string[];
  errBuf: string[];
} {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return {
    io: {
      out: (s: string) => outBuf.push(s),
      err: (s: string) => errBuf.push(s),
    },
    outBuf,
    errBuf,
  };
}

function snap(pid: number, agentId: string, dispatched = 0): UpStatusSnapshot {
  return {
    version: 1,
    cliVersion: '0.7.4',
    pid,
    startedAt: '2026-04-22T08:00:00Z',
    manifestPath: '/tmp/fleet.yaml',
    agents: [
      {
        id: agentId,
        path: `/agents/${agentId}`,
        uptimeMs: 3_600_000,
        sources: [],
        channels: [],
        metrics: {
          eventsDispatched: dispatched,
          eventsRejected: 0,
          breakerOpen: 0,
        },
      },
    ],
  };
}

const HOSTS: FleetHost[] = [
  { name: 'us-east', url: 'http://us' },
  { name: 'eu-west', url: 'http://eu' },
];

describe('fleetPs', () => {
  it('fans out across hosts and renders a table', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async (h) => snap(1, `agent-${h.name}`, 100),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      ...MUTATION_STUBS,
    };
    const { io, outBuf } = makeIO();
    const code = await fleetPs({}, { io, hosts: HOSTS, client });
    expect(code).toBe(0);
    const out = outBuf.join('');
    expect(out).toContain('us-east');
    expect(out).toContain('eu-west');
    expect(out).toContain('agent-us-east');
    expect(out).toContain('agent-eu-west');
  });

  it('isolates a failing host and still returns rows from survivors', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async (h) => {
        if (h.name === 'eu-west') throw new Error('connect timeout');
        return snap(1, 'classifier');
      },
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      ...MUTATION_STUBS,
    };
    const { io, outBuf, errBuf } = makeIO();
    const code = await fleetPs({}, { io, hosts: HOSTS, client });
    expect(code).toBe(1); // partial failure → non-zero exit
    const out = outBuf.join('');
    expect(out).toContain('us-east');
    const err = errBuf.join('');
    expect(err).toContain('1 host(s) unreachable');
    expect(err).toContain('eu-west');
    expect(err).toContain('connect timeout');
  });

  it('--host restricts to one host', async () => {
    const calls: string[] = [];
    const client: CrossHostControlPlaneClient = {
      getStatus: async (h) => {
        calls.push(h.name);
        return snap(1, 'only');
      },
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      ...MUTATION_STUBS,
    };
    const { io } = makeIO();
    await fleetPs({ host: 'us-east' }, { io, hosts: HOSTS, client });
    expect(calls).toEqual(['us-east']);
  });

  it('--host with unknown name exits 1 with a clear error', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      ...MUTATION_STUBS,
    };
    const { io, errBuf } = makeIO();
    const code = await fleetPs({ host: 'jp-tokyo' }, { io, hosts: HOSTS, client });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('host "jp-tokyo" not declared');
  });

  it('empty hosts list prints pointer to single-host `ps`', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      ...MUTATION_STUBS,
    };
    const { io, outBuf } = makeIO();
    const code = await fleetPs({}, { io, hosts: [], client });
    expect(code).toBe(0);
    expect(outBuf.join('')).toContain('declaragent ps');
  });

  it('--json emits per-host status + failures', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async (h) => {
        if (h.name === 'eu-west') throw new Error('refused');
        return snap(42, 'classifier', 10);
      },
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      ...MUTATION_STUBS,
    };
    const { io, outBuf } = makeIO();
    const code = await fleetPs({ json: true }, { io, hosts: HOSTS, client });
    expect(code).toBe(1);
    const parsed = JSON.parse(outBuf.join('')) as {
      hosts: { host: string; ok: boolean }[];
      failures: { host: string }[];
    };
    expect(parsed.hosts.length).toBe(2);
    expect(parsed.failures.length).toBe(1);
    expect(parsed.failures[0]?.host).toBe('eu-west');
  });
});

describe('fleetEventsList', () => {
  it('merges events from multiple hosts by timestamp DESC', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async (h) => ({
        events: [
          {
            id: `${h.name}-old`,
            kind: 'webhook.received',
            ts: h.name === 'us-east' ? 1000 : 500,
            recordedAt: 1000,
            correlationId: undefined,
            sourceType: 'webhook',
            targetType: 'skill',
            outcome: undefined,
            outcomeAt: undefined,
            event: {},
            agentId: 'classifier',
          },
        ],
        nextCursor: null,
      }),
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      ...MUTATION_STUBS,
    };
    const { io, outBuf } = makeIO();
    const code = await fleetEventsList({ json: true }, { io, hosts: HOSTS, client });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('')) as {
      events: { host: string; id: string; ts: number }[];
    };
    expect(parsed.events.length).toBe(2);
    // Newer first.
    expect(parsed.events[0]?.id).toBe('us-east-old');
    expect(parsed.events[1]?.id).toBe('eu-west-old');
  });

  it('survivors rendered when one host fails', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async (h) => {
        if (h.name === 'eu-west') throw new Error('500 internal');
        return {
          events: [
            {
              id: 'e1',
              kind: 'trigger.fire',
              ts: 2000,
              recordedAt: 2000,
              correlationId: undefined,
              sourceType: 'cron',
              targetType: 'skill',
              outcome: undefined,
              outcomeAt: undefined,
              event: {},
            },
          ],
          nextCursor: null,
        };
      },
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      ...MUTATION_STUBS,
    };
    const { io, outBuf, errBuf } = makeIO();
    const code = await fleetEventsList({}, { io, hosts: HOSTS, client });
    expect(code).toBe(1);
    expect(outBuf.join('')).toContain('events (1)');
    expect(errBuf.join('')).toContain('eu-west');
  });
});

describe('fleetDlqList', () => {
  it('merges rejections sorted by lastSeenMs DESC', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async (h) => ({
        rejections: [
          {
            eventId: `${h.name}-evt`,
            reason: 'circuit-open',
            details: undefined,
            attemptCount: 3,
            firstSeenMs: 100,
            lastSeenMs: h.name === 'us-east' ? 900 : 200,
            agentId: 'classifier',
          },
        ],
        nextCursor: null,
      }),
      ...MUTATION_STUBS,
    };
    const { io, outBuf } = makeIO();
    const code = await fleetDlqList({ json: true }, { io, hosts: HOSTS, client });
    expect(code).toBe(0);
    const parsed = JSON.parse(outBuf.join('')) as {
      rejections: { host: string; eventId: string }[];
    };
    expect(parsed.rejections[0]?.host).toBe('us-east');
    expect(parsed.rejections[1]?.host).toBe('eu-west');
  });
});

describe('fleetLogs (snapshot mode)', () => {
  it('prints a pointer when no hosts are declared', async () => {
    // fetch is never called because we pass hosts=[] → early return.
    const { io, outBuf } = makeIO();
    await fleetLogs({ follow: true }, { io, hosts: [] });
    expect(outBuf.join('')).toContain('declaragent ps');
  });

  it('unknown --host exits 1', async () => {
    const { io, errBuf } = makeIO();
    const code = await fleetLogs({ host: 'unknown' }, { io, hosts: HOSTS });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('host "unknown" not declared');
  });
});

describe('fleetLogs -f (live multi-host follow, Slice 6a)', () => {
  it('streams log frames from multiple hosts tagged with [host/agent]', async () => {
    const encoder = new TextEncoder();
    // Each host gets a streamed response we drive from inside fetch.
    const hostStreams = new Map<string, { push: (s: string) => void; close: () => void }>();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const origin = new URL(url).origin;
      let pushFn: ((s: string) => void) | null = null;
      let closeFn: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          pushFn = (s) => controller.enqueue(encoder.encode(s));
          closeFn = () => {
            try {
              controller.close();
            } catch {
              // already closed
            }
          };
          hostStreams.set(origin, { push: pushFn, close: closeFn });
        },
      });
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        closeFn?.();
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const { io, outBuf, errBuf } = makeIO();
    const logsHosts: FleetHost[] = [
      { name: 'us-east', url: 'http://us' },
      { name: 'eu-west', url: 'http://eu' },
    ];

    const runPromise = fleetLogs(
      { follow: true, installSignalHandlers: false },
      { io, hosts: logsHosts, clientOptions: { fetchImpl } },
    );

    // Wait for both origins to attach their controllers.
    await waitUntil(() => hostStreams.size >= 2);
    hostStreams
      .get('http://us')
      ?.push(
        `event: log\ndata: ${JSON.stringify({ ts: 100, agentId: 'a', message: 'hi-us' })}\n\n`,
      );
    hostStreams
      .get('http://eu')
      ?.push(
        `event: log\ndata: ${JSON.stringify({ ts: 110, agentId: 'b', message: 'hi-eu' })}\n\n`,
      );

    await waitUntil(() => outBuf.join('').includes('hi-us') && outBuf.join('').includes('hi-eu'));
    const out = outBuf.join('');
    expect(out).toContain('[us-east/a]');
    expect(out).toContain('[eu-west/b]');
    expect(out).toContain('hi-us');
    expect(out).toContain('hi-eu');
    // tail header on stderr
    expect(errBuf.join('')).toContain('tailing 2 host');

    // Close both streams → done. We expect the runPromise to resolve
    // once every per-host loop has exited, which requires we trigger a
    // stop. The simplest way from this test: close streams (triggers
    // disconnect + reconnect loop), then kill the in-flight fetches
    // by closing the pending stream controllers again. Since fetch's
    // abort is wired we just need to tear everything down. Use the
    // public API path: send SIGINT… but we disabled signals. So we
    // directly invoke the reconnect exit path via closing + assert
    // that the runPromise hangs (expected). For this test the stream
    // tag assertions are the contract — the lifecycle is covered in
    // fleet-logs-stream.test.ts. Forcibly close controllers.
    for (const s of hostStreams.values()) s.close();
    // Poll for the promise to race via a short timeout — we don't
    // await indefinitely.
    const raced = await Promise.race([
      runPromise.then(() => 'done' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 50)),
    ]);
    // Follow loop reconnects forever — 'timeout' is the expected
    // shape. What we care about is that fetch was called twice +
    // output was produced.
    expect(raced).toBe('timeout');
  });
});

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── fleet dlq drop / requeue (Slice 6b) ─────────────────────────────────

describe('fleetDlqDrop', () => {
  it('single host (only one declared) drops without needing --host', async () => {
    const calls: string[] = [];
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async (h, args) => {
        calls.push(`${h.name}/${args.id}`);
        return { ok: true, op: 'drop', eventId: args.id, attemptsBeforeOp: 2 };
      },
      requeueDlqEntry: async () => ({ ok: true, op: 'requeue', eventId: 'x' }),
    };
    const { io, outBuf } = makeIO();
    const code = await fleetDlqDrop(
      { id: 'evt-1', kind: 'dispatch' },
      { io, hosts: [HOSTS[0] as FleetHost], client, initiator: 'tester' },
    );
    expect(code).toBe(0);
    expect(calls).toEqual(['us-east/evt-1']);
    expect(outBuf.join('')).toContain('us-east');
  });

  it('errors out (exit 2) when fleet has >1 host and neither --host nor --all-hosts is set', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async () => ({ ok: true, op: 'drop', eventId: 'x' }),
      requeueDlqEntry: async () => ({ ok: true, op: 'requeue', eventId: 'x' }),
    };
    const { io, errBuf } = makeIO();
    const code = await fleetDlqDrop({ id: 'evt' }, { io, hosts: HOSTS, client });
    expect(code).toBe(2);
    expect(errBuf.join('')).toMatch(/pass --host|--all-hosts/);
  });

  it('--all-hosts without --yes invokes confirm; false cancels with exit 3', async () => {
    const calls: string[] = [];
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async (h, args) => {
        calls.push(h.name);
        return { ok: true, op: 'drop', eventId: args.id };
      },
      requeueDlqEntry: async () => ({ ok: true, op: 'requeue', eventId: 'x' }),
    };
    const { io, errBuf } = makeIO();
    const code = await fleetDlqDrop(
      { id: 'evt', allHosts: true },
      { io, hosts: HOSTS, client, confirm: () => false },
    );
    expect(code).toBe(3);
    expect(calls).toEqual([]); // no host actually hit
    expect(errBuf.join('')).toContain('cancelled');
  });

  it('--all-hosts --yes fans out to every host', async () => {
    const calls: string[] = [];
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async (h, args) => {
        calls.push(h.name);
        return { ok: true, op: 'drop', eventId: args.id, attemptsBeforeOp: 1 };
      },
      requeueDlqEntry: async () => ({ ok: true, op: 'requeue', eventId: 'x' }),
    };
    const { io, outBuf } = makeIO();
    const code = await fleetDlqDrop(
      { id: 'evt', allHosts: true, yes: true },
      { io, hosts: HOSTS, client },
    );
    expect(code).toBe(0);
    expect(calls.sort()).toEqual(['eu-west', 'us-east']);
    expect(outBuf.join('')).toContain('us-east');
    expect(outBuf.join('')).toContain('eu-west');
  });

  it('partial host failure → exit 1 with both successes and failures reported', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async (h, args) => {
        if (h.name === 'eu-west') {
          // Logical miss — the row isn't on this host. Returned by the
          // route as `{ok: false, reason: 'not-found'}`.
          return { ok: false, op: 'drop', eventId: args.id, reason: 'not-found' };
        }
        return { ok: true, op: 'drop', eventId: args.id, attemptsBeforeOp: 3 };
      },
      requeueDlqEntry: async () => ({ ok: true, op: 'requeue', eventId: 'x' }),
    };
    const { io, outBuf } = makeIO();
    const code = await fleetDlqDrop(
      { id: 'evt-p', allHosts: true, yes: true },
      { io, hosts: HOSTS, client },
    );
    expect(code).toBe(1);
    const out = outBuf.join('');
    expect(out).toContain('us-east');
    expect(out).toContain('eu-west');
    expect(out).toContain('not-found');
  });

  it('transport failure on one host surfaces with host tag', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async (h, args) => {
        if (h.name === 'eu-west') throw new Error('connect refused');
        return { ok: true, op: 'drop', eventId: args.id };
      },
      requeueDlqEntry: async () => ({ ok: true, op: 'requeue', eventId: 'x' }),
    };
    const { io, outBuf } = makeIO();
    const code = await fleetDlqDrop(
      { id: 'x', allHosts: true, yes: true },
      { io, hosts: HOSTS, client },
    );
    expect(code).toBe(1);
    const out = outBuf.join('');
    expect(out).toContain('eu-west');
    expect(out).toContain('connect refused');
  });

  it('--id is required', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async () => ({ ok: true, op: 'drop', eventId: 'x' }),
      requeueDlqEntry: async () => ({ ok: true, op: 'requeue', eventId: 'x' }),
    };
    const { io, errBuf } = makeIO();
    const code = await fleetDlqDrop({}, { io, hosts: HOSTS, client });
    expect(code).toBe(1);
    expect(errBuf.join('')).toContain('--id is required');
  });

  it('rejects both --host and --all-hosts', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async () => ({ ok: true, op: 'drop', eventId: 'x' }),
      requeueDlqEntry: async () => ({ ok: true, op: 'requeue', eventId: 'x' }),
    };
    const { io, errBuf } = makeIO();
    const code = await fleetDlqDrop(
      { id: 'x', host: 'us-east', allHosts: true },
      { io, hosts: HOSTS, client, confirm: () => true },
    );
    expect(code).toBe(1);
    expect(errBuf.join('')).toMatch(/EITHER --host .* OR --all-hosts/);
  });
});

describe('fleetDlqRequeue', () => {
  it('requeues on a single --host and passes initiator through', async () => {
    let seenInitiator: string | undefined;
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async () => ({ ok: true, op: 'drop', eventId: 'x' }),
      requeueDlqEntry: async (_h, args) => {
        seenInitiator = args.initiator;
        return { ok: true, op: 'requeue', eventId: args.id, attemptsBeforeOp: 2 };
      },
    };
    const { io } = makeIO();
    const code = await fleetDlqRequeue(
      { id: 'evt-z', host: 'us-east' },
      { io, hosts: HOSTS, client, initiator: 'operator1' },
    );
    expect(code).toBe(0);
    expect(seenInitiator).toBe('operator1');
  });

  it('--json emits per-host rows', async () => {
    const client: CrossHostControlPlaneClient = {
      getStatus: async () => snap(1, 'x'),
      getEvents: async () => ({ events: [], nextCursor: null }) as EventsResponse,
      getDlq: async () => ({ rejections: [], nextCursor: null }) as DlqResponse,
      dropDlqEntry: async () => ({ ok: true, op: 'drop', eventId: 'x' }),
      requeueDlqEntry: async (h, args) =>
        h.name === 'eu-west'
          ? { ok: false, op: 'requeue', eventId: args.id, reason: 'dlq-miss' }
          : { ok: true, op: 'requeue', eventId: args.id, attemptsBeforeOp: 1 },
    };
    const { io, outBuf } = makeIO();
    const code = await fleetDlqRequeue(
      { id: 'evt-j', allHosts: true, yes: true, json: true },
      { io, hosts: HOSTS, client },
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(outBuf.join('')) as {
      op: string;
      hosts: Array<{ host: string; ok: boolean; response?: { reason?: string } }>;
    };
    expect(parsed.op).toBe('requeue');
    expect(parsed.hosts).toHaveLength(2);
    const eu = parsed.hosts.find((h) => h.host === 'eu-west');
    expect(eu?.ok).toBe(false);
    expect(eu?.response?.reason).toBe('dlq-miss');
  });
});

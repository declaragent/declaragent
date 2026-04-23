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
import { fleetDlqList, fleetEventsList, fleetLogs, fleetPs } from './fleet-cross-host-cli.js';

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
  it('prints a hint when -f is passed (Slice 6 deferred)', async () => {
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

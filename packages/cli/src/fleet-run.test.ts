import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentSpec,
  Logger,
  PermissionGate,
  SessionHandle,
  ToolContext,
  ToolEvent,
} from '@declaragent/core';
import { loadFleet, parsePeersConfig } from '@declaragent/core';
import {
  createMemoryBus,
  createMemoryTransport,
  createPendingRegistry,
  createRequestAgentTool,
} from '@declaragent/plugin-agent-rpc';
import {
  type FleetAgentHandler,
  type FleetRunIO,
  defaultHandler,
  fleetRun,
  startFleetDaemon,
} from './fleet-run.js';

// Minimal ToolContext + event collector. Mirrors the helpers inside
// plugin-agent-rpc (which aren't re-exported) so this test doesn't need
// to reach into that package's private surface.
const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};
const STUB_SPEC: AgentSpec = {
  name: 'test-agent',
  model: 'claude-opus-4-6',
  systemPrompt: 'you are a test',
};
const STUB_PERMS: PermissionGate = {
  mode: 'bypass',
  check: async () => ({ outcome: 'allow' as const }),
  recordDenial() {},
  denialsInSession: () => 0,
  scope(): PermissionGate {
    return STUB_PERMS;
  },
};
function makeStubSession(id = 'test-session'): SessionHandle {
  return {
    id,
    spec: STUB_SPEC,
    transcript: [],
    appendMessage: async () => {},
    ledger: () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      turns: 0,
      estimatedCostUSD: 0,
    }),
    markTurn: async () => {},
    updateSpec: async () => {},
  };
}
function makeToolContext(): ToolContext {
  return {
    session: makeStubSession(),
    permissions: STUB_PERMS,
    abortSignal: new AbortController().signal,
    depth: 0,
    runAgent: async () => ({
      stopReason: 'end_turn' as const,
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    logger: NOOP_LOGGER,
  };
}
async function collectEvents<O>(iter: AsyncIterable<ToolEvent<O>>): Promise<{
  progress: string[];
  result?: O;
  error?: { message: string; code?: string };
}> {
  const out: {
    progress: string[];
    result?: O;
    error?: { message: string; code?: string };
  } = { progress: [] };
  for await (const ev of iter) {
    if (ev.type === 'progress') out.progress.push(ev.message);
    if (ev.type === 'result') out.result = ev.output;
    if (ev.type === 'error') {
      out.error = { message: ev.error.message };
      if (ev.error.code !== undefined) out.error.code = ev.error.code;
    }
  }
  return out;
}

interface Harness {
  root: string;
  write(relative: string, contents: string): void;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-run-'));
  return {
    root,
    write(relative, contents) {
      const full = join(root, relative);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents, 'utf-8');
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function captureIo(): { io: FleetRunIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

/**
 * Builds a two-agent fleet where `pr-reviewer` exposes a `review-pr`
 * capability over the shared memory transport, and `concierge` is
 * client-only. Returns the loaded fleet ready for {@link startFleetDaemon}.
 */
async function twoAgentFleet(h: Harness): ReturnType<typeof loadFleet> {
  h.write(
    'fleet.yaml',
    `version: 1
name: demo
agents:
  - id: concierge
    path: ./agents/concierge
  - id: pr-reviewer
    path: ./agents/pr-reviewer
`,
  );
  h.write('agents/concierge/agent.yaml', 'name: concierge\n');
  h.write('agents/pr-reviewer/agent.yaml', 'name: pr-reviewer\n');
  h.write(
    'agents/pr-reviewer/capabilities.yaml',
    `version: 1
agent: agent://pr-reviewer
transports:
  - kind: memory
    topics: { requests: agents.pr-reviewer.requests }
capabilities:
  - name: review-pr
    timeoutMs: 60000
    idempotent: true
`,
  );
  return loadFleet({ root: h.root });
}

describe('startFleetDaemon', () => {
  test('boots every agent + subscribes memory transports', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const daemon = await startFleetDaemon({ fleet });
      try {
        expect(daemon.agents.size).toBe(2);
        const reviewer = daemon.agents.get('pr-reviewer');
        expect(reviewer?.capabilities).toEqual(['review-pr']);
        expect(reviewer?.topics).toEqual(['agents.pr-reviewer.requests']);
        const concierge = daemon.agents.get('concierge');
        expect(concierge?.capabilities).toEqual([]);
        expect(concierge?.topics).toEqual([]);
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('round-trips a request end-to-end via the shared bus', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const bus = createMemoryBus();
      const daemon = await startFleetDaemon({ fleet, bus });
      try {
        // Producer side: concierge fires `RequestAgent` through a fresh
        // transport on the same bus. The pr-reviewer worker's default
        // handler echoes the payload back.
        const conciergeTransport = createMemoryTransport({ bus });
        const peers = parsePeersConfig({
          version: 1,
          peers: [
            {
              agent: 'agent://pr-reviewer',
              transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
            },
          ],
        });
        const pending = createPendingRegistry();
        // Wire concierge's own inbox so responses route into the registry.
        const conciergeResponses = conciergeTransport.subscribe(
          'agents.concierge.responses',
          async (envelope) => {
            if (envelope.kind !== 'response') return;
            const payload = envelope.payload as
              | { ok: true; data: unknown }
              | { ok: false; error: { code: string; message: string } };
            pending.settle(
              envelope.correlationId,
              payload.ok
                ? { status: 'ok', data: payload.data }
                : { status: 'error', error: payload.error },
            );
          },
        );

        const tool = createRequestAgentTool({
          selfAgent: 'agent://concierge',
          peers,
          transports: new Map([['memory', conciergeTransport]]),
          pending,
          replyTo: 'memory://agents.concierge.responses',
        });
        const events = await collectEvents(
          tool.execute(
            {
              to: 'agent://pr-reviewer',
              capability: 'review-pr',
              payload: { prUrl: 'https://github.com/x/y/pull/1' },
              timeoutMs: 2000,
            },
            makeToolContext(),
          ),
        );
        expect(events.result?.status).toBe('ok');
        const data = events.result?.response as { echoed: { prUrl: string } };
        expect(data.echoed.prUrl).toBe('https://github.com/x/y/pull/1');

        const metrics = daemon.agents.get('pr-reviewer')?.metrics();
        expect(metrics?.received).toBe(1);
        expect(metrics?.responded).toBe(1);
        conciergeResponses();
        await conciergeTransport.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('custom makeHandler overrides the default echo handler', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const calls: Array<{ agentId: string; capability: string }> = [];
      const bus = createMemoryBus();
      const handler: FleetAgentHandler = async (ctx) => {
        calls.push({ agentId: ctx.agentId, capability: ctx.capability });
        await ctx.respond({ ok: true, data: { customized: true } });
      };
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        makeHandler: () => handler,
      });
      try {
        const conciergeTransport = createMemoryTransport({ bus });
        const peers = parsePeersConfig({
          version: 1,
          peers: [
            {
              agent: 'agent://pr-reviewer',
              transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
            },
          ],
        });
        const pending = createPendingRegistry();
        const detach = conciergeTransport.subscribe(
          'agents.concierge.responses',
          async (envelope) => {
            if (envelope.kind !== 'response') return;
            const payload = envelope.payload as { ok: true; data: unknown };
            pending.settle(envelope.correlationId, { status: 'ok', data: payload.data });
          },
        );
        const tool = createRequestAgentTool({
          selfAgent: 'agent://concierge',
          peers,
          transports: new Map([['memory', conciergeTransport]]),
          pending,
          replyTo: 'memory://agents.concierge.responses',
        });
        const events = await collectEvents(
          tool.execute(
            {
              to: 'agent://pr-reviewer',
              capability: 'review-pr',
              payload: { hi: 1 },
              timeoutMs: 2000,
            },
            makeToolContext(),
          ),
        );
        expect(events.result?.status).toBe('ok');
        expect(events.result?.response).toEqual({ customized: true });
        expect(calls).toEqual([{ agentId: 'pr-reviewer', capability: 'review-pr' }]);
        detach();
        await conciergeTransport.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('handler that throws reports HANDLER_ERROR back to the caller', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const bus = createMemoryBus();
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        makeHandler: () => async () => {
          throw new Error('kaboom');
        },
      });
      try {
        const conciergeTransport = createMemoryTransport({ bus });
        const peers = parsePeersConfig({
          version: 1,
          peers: [
            {
              agent: 'agent://pr-reviewer',
              transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
            },
          ],
        });
        const pending = createPendingRegistry();
        const detach = conciergeTransport.subscribe(
          'agents.concierge.responses',
          async (envelope) => {
            if (envelope.kind !== 'response') return;
            const payload = envelope.payload as
              | { ok: true; data: unknown }
              | { ok: false; error: { code: string; message: string } };
            pending.settle(
              envelope.correlationId,
              payload.ok
                ? { status: 'ok', data: payload.data }
                : { status: 'error', error: payload.error },
            );
          },
        );
        const tool = createRequestAgentTool({
          selfAgent: 'agent://concierge',
          peers,
          transports: new Map([['memory', conciergeTransport]]),
          pending,
          replyTo: 'memory://agents.concierge.responses',
        });
        const events = await collectEvents(
          tool.execute(
            {
              to: 'agent://pr-reviewer',
              capability: 'review-pr',
              payload: {},
              timeoutMs: 2000,
            },
            makeToolContext(),
          ),
        );
        expect(events.result?.status).toBe('error');
        expect(events.result?.error?.code).toBe('HANDLER_ERROR');
        const metrics = daemon.agents.get('pr-reviewer')?.metrics();
        expect(metrics?.errored).toBe(1);
        detach();
        await conciergeTransport.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('shutdown stops every worker + unsubscribes from the bus', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const bus = createMemoryBus();
      const daemon = await startFleetDaemon({ fleet, bus });
      expect(bus.subscriberCount('agents.pr-reviewer.requests')).toBe(1);
      await daemon.shutdown();
      expect(bus.subscriberCount('agents.pr-reviewer.requests')).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('defaultHandler', () => {
  test('echoes the envelope payload', async () => {
    let received: unknown = null;
    await defaultHandler({
      agentId: 'agent-a',
      capability: 'foo',
      envelope: {
        version: 1,
        kind: 'request',
        messageId: 'm',
        correlationId: 'c',
        from: 'agent://other',
        to: 'agent://agent-a',
        capability: 'foo',
        payload: { hello: 'world' },
      },
      respond: async (r) => {
        received = r;
      },
    });
    expect(received).toEqual({
      ok: true,
      data: { agent: 'agent-a', capability: 'foo', echoed: { hello: 'world' } },
    });
  });
});

describe('fleetRun (CLI verb)', () => {
  test('errors cleanly when no fleet.yaml is found', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetRun({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml');
    } finally {
      h.cleanup();
    }
  });

  test('errors when the fleet has zero agents', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', 'version: 1\nname: empty\nagents: []\n');
      const cap = captureIo();
      const code = await fleetRun({}, { io: cap.io, root: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('fleet has no agents');
    } finally {
      h.cleanup();
    }
  });

  test('runs the selected subset via --agent and prints a ready line', async () => {
    const h = mkHarness();
    try {
      await twoAgentFleet(h);
      const cap = captureIo();
      const code = await fleetRun(
        { agents: ['pr-reviewer'] },
        {
          io: cap.io,
          root: h.root,
          onStart: async (daemon) => {
            expect(daemon.agents.size).toBe(1);
            expect(daemon.agents.has('pr-reviewer')).toBe(true);
            expect(daemon.agents.has('concierge')).toBe(false);
          },
        },
      );
      expect(code).toBe(0);
      const out = cap.out.join('');
      expect(out).toContain('running 1 agent');
      expect(out).toContain('pr-reviewer');
      expect(out).toContain('ready');
    } finally {
      h.cleanup();
    }
  });

  test('--agent with no matches → exit 1 + helpful error', async () => {
    const h = mkHarness();
    try {
      await twoAgentFleet(h);
      const cap = captureIo();
      const code = await fleetRun({ agents: ['ghost'] }, { io: cap.io, root: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('none of --agent');
    } finally {
      h.cleanup();
    }
  });
});

// ── Slice 7: version-skew wiring ──────────────────────────────────────

async function fleetWithMinVersion(
  h: Harness,
  minFleetVersion: string,
): ReturnType<typeof loadFleet> {
  h.write(
    'fleet.yaml',
    `version: 1
name: demo
agents:
  - id: pr-reviewer
    path: ./agents/pr-reviewer
rpc:
  stampFleetVersion: true
  minFleetVersion: ${minFleetVersion}
`,
  );
  h.write('agents/pr-reviewer/agent.yaml', 'name: pr-reviewer\n');
  h.write(
    'agents/pr-reviewer/capabilities.yaml',
    `version: 1
agent: agent://pr-reviewer
transports:
  - kind: memory
    topics: { requests: agents.pr-reviewer.requests }
capabilities:
  - name: review-pr
`,
  );
  return loadFleet({ root: h.root });
}

function buildPeers() {
  return parsePeersConfig({
    version: 1,
    peers: [
      {
        agent: 'agent://pr-reviewer',
        transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
      },
    ],
  });
}

describe('fleet-run version-skew (slice 7)', () => {
  test('rejects a caller older than minFleetVersion with EVERSION_SKEW', async () => {
    const h = mkHarness();
    try {
      const fleet = await fleetWithMinVersion(h, 'v1.2.0-cut');
      const bus = createMemoryBus();
      const ioCap = captureIo();
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        selfFleetVersion: 'v1.2.0-abc',
        io: ioCap.io,
      });
      try {
        const conciergeTransport = createMemoryTransport({ bus });
        const pending = createPendingRegistry();
        const detach = conciergeTransport.subscribe(
          'agents.concierge.responses',
          async (envelope) => {
            if (envelope.kind !== 'response') return;
            const payload = envelope.payload as
              | { ok: true; data: unknown }
              | { ok: false; error: { code: string; message: string } };
            pending.settle(
              envelope.correlationId,
              payload.ok
                ? { status: 'ok', data: payload.data }
                : { status: 'error', error: payload.error },
            );
          },
        );
        const tool = createRequestAgentTool({
          selfAgent: 'agent://concierge',
          peers: buildPeers(),
          transports: new Map([['memory', conciergeTransport]]),
          pending,
          replyTo: 'memory://agents.concierge.responses',
          fleetVersion: 'v1.0.0-old', // older than minFleetVersion
        });
        const events = await collectEvents(
          tool.execute(
            {
              to: 'agent://pr-reviewer',
              capability: 'review-pr',
              payload: { prUrl: 'x' },
              timeoutMs: 2000,
            },
            makeToolContext(),
          ),
        );
        expect(events.result?.status).toBe('error');
        expect(events.result?.error?.code).toBe('EVERSION_SKEW');
        expect(events.result?.error?.message).toContain('v1.0.0');

        const metrics = daemon.agents.get('pr-reviewer')?.metrics();
        expect(metrics?.versionRejected).toBe(1);
        expect(metrics?.responded).toBe(0);

        // Audit-shape check: the rejection fires a log line with the
        // standard `fleet.version.skew.reject` prefix that downstream
        // sinks can grep for.
        expect(ioCap.err.join('')).toContain('fleet.version.skew.reject');
        detach();
        await conciergeTransport.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('accepts a newer caller + increments skew metric + logs warning', async () => {
    const h = mkHarness();
    try {
      const fleet = await fleetWithMinVersion(h, 'v1.0.0-any');
      const bus = createMemoryBus();
      const ioCap = captureIo();
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        selfFleetVersion: 'v1.2.0-abc',
        io: ioCap.io,
      });
      try {
        const conciergeTransport = createMemoryTransport({ bus });
        const pending = createPendingRegistry();
        const detach = conciergeTransport.subscribe(
          'agents.concierge.responses',
          async (envelope) => {
            if (envelope.kind !== 'response') return;
            const payload = envelope.payload as
              | { ok: true; data: unknown }
              | { ok: false; error: { code: string; message: string } };
            pending.settle(
              envelope.correlationId,
              payload.ok
                ? { status: 'ok', data: payload.data }
                : { status: 'error', error: payload.error },
            );
          },
        );
        const tool = createRequestAgentTool({
          selfAgent: 'agent://concierge',
          peers: buildPeers(),
          transports: new Map([['memory', conciergeTransport]]),
          pending,
          replyTo: 'memory://agents.concierge.responses',
          fleetVersion: 'v1.3.0-new', // newer than self
        });
        const events = await collectEvents(
          tool.execute(
            {
              to: 'agent://pr-reviewer',
              capability: 'review-pr',
              payload: { prUrl: 'x' },
              timeoutMs: 2000,
            },
            makeToolContext(),
          ),
        );
        expect(events.result?.status).toBe('ok');

        const metrics = daemon.agents.get('pr-reviewer')?.metrics();
        expect(metrics?.versionSkewNewer).toBe(1);
        expect(metrics?.versionRejected).toBe(0);
        expect(metrics?.responded).toBe(1);
        expect(ioCap.err.join('')).toContain('fleet.version.skew');
        detach();
        await conciergeTransport.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('unstamped caller passes through without raising skew metrics', async () => {
    const h = mkHarness();
    try {
      const fleet = await fleetWithMinVersion(h, 'v1.0.0-any');
      const bus = createMemoryBus();
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        selfFleetVersion: 'v1.2.0-abc',
      });
      try {
        const conciergeTransport = createMemoryTransport({ bus });
        const pending = createPendingRegistry();
        const detach = conciergeTransport.subscribe(
          'agents.concierge.responses',
          async (envelope) => {
            if (envelope.kind !== 'response') return;
            const payload = envelope.payload as { ok: true; data: unknown };
            pending.settle(envelope.correlationId, { status: 'ok', data: payload.data });
          },
        );
        const tool = createRequestAgentTool({
          selfAgent: 'agent://concierge',
          peers: buildPeers(),
          transports: new Map([['memory', conciergeTransport]]),
          pending,
          replyTo: 'memory://agents.concierge.responses',
          // no fleetVersion → no header stamped
        });
        const events = await collectEvents(
          tool.execute(
            {
              to: 'agent://pr-reviewer',
              capability: 'review-pr',
              payload: {},
              timeoutMs: 2000,
            },
            makeToolContext(),
          ),
        );
        expect(events.result?.status).toBe('ok');
        const metrics = daemon.agents.get('pr-reviewer')?.metrics();
        expect(metrics?.versionRejected).toBe(0);
        expect(metrics?.versionSkewNewer).toBe(0);
        expect(metrics?.responded).toBe(1);
        detach();
        await conciergeTransport.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });
});

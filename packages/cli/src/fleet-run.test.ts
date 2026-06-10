import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAddress,
  AgentRpcEnvelope,
  AgentSpec,
  LoadedCapabilities,
  Logger,
  PermissionGate,
  SessionHandle,
  StoredAuditEntry,
  TenantAuditRecord,
  TenantAuditSink,
  ToolContext,
  ToolEvent,
} from '@declaragent/core';
import {
  createCapabilityValidatorRegistry,
  loadFleet,
  parseCapabilitiesConfig,
  parsePeersConfig,
} from '@declaragent/core';
import {
  type AuthVerifyRegistry,
  type CapabilitySchemaViolationEmitter,
  createMemoryBus,
  createMemoryTransport,
  createPendingRegistry,
  createRequestAgentTool,
} from '@declaragent/plugin-agent-rpc';
import {
  type FleetAgentHandler,
  type FleetAgentRpcContext,
  type FleetRunIO,
  type FleetTransportFactory,
  createMemoizedLoadAgent,
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
          // Bypass the LLM factory path so the test works on any
          // machine regardless of `~/.declaragent/config.json` state.
          makeHandler: () => defaultHandler,
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

  test('exits 1 with a helpful error when no provider creds are configured', async () => {
    const h = mkHarness();
    try {
      await twoAgentFleet(h);
      const cap = captureIo();
      const code = await fleetRun(
        {},
        {
          io: cap.io,
          root: h.root,
          // No makeHandler + stubbed "no creds" → CLI should bail
          // before touching the daemon.
          resolveCredentials: () => null,
        },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no provider credentials');
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

describe('startFleetDaemon — slice 5 (transport factories + RequestAgent wiring)', () => {
  test('makeHandler receives an rpc context with peers + transports map', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const peers = parsePeersConfig({
        version: 1,
        peers: [
          {
            agent: 'agent://pr-reviewer',
            transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
          },
        ],
      });
      const received: FleetAgentRpcContext[] = [];
      const bus = createMemoryBus();
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        peers,
        makeHandler: (_agent, ctx) => {
          received.push(ctx);
          return defaultHandler;
        },
      });
      try {
        expect(received).toHaveLength(2);
        // Each agent gets its own `selfAddress`.
        expect(received.map((c) => c.selfAddress).sort()).toEqual([
          'agent://concierge',
          'agent://pr-reviewer',
        ]);
        // Transport map ships `memory` at minimum.
        expect(received[0]?.transports.has('memory')).toBe(true);
        // Peers passed through untouched.
        expect(received[0]?.peers).toBe(peers);
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('non-memory transport factory is invoked once per declared kind', async () => {
    const h = mkHarness();
    try {
      // twoAgentFleet declares memory only — synthesize a grafted copy
      // that adds a kafka transport to pr-reviewer's capabilities.
      const real = await twoAgentFleet(h);
      const kafkaOn = real.agents.map((a) => {
        if (!a.capabilities) return a;
        return {
          ...a,
          capabilities: {
            ...a.capabilities,
            config: {
              ...a.capabilities.config,
              transports: [
                ...a.capabilities.config.transports,
                {
                  kind: 'kafka' as const,
                  brokers: ['broker:9092'],
                  topics: { requests: 'agents.pr-reviewer.requests.kafka' },
                },
              ],
            },
          },
        };
      });
      const grafted = {
        ...real,
        agents: kafkaOn,
        agentsById: new Map(kafkaOn.map((a) => [a.id, a])),
      };

      let factoryCalls = 0;
      const factory: FleetTransportFactory = async (config, _deps) => {
        factoryCalls += 1;
        expect(config.kind).toBe('kafka');
        // Return a no-op RpcTransport stub. The daemon just holds it.
        return {
          kind: 'kafka' as const,
          publish: async () => {},
          subscribe: () => () => {},
          close: async () => {},
        };
      };

      const bus = createMemoryBus();
      const daemon = await startFleetDaemon({
        fleet: grafted,
        bus,
        transportFactories: { kafka: factory },
        makeHandler: () => defaultHandler,
      });
      try {
        expect(factoryCalls).toBe(1);
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('(WS4) response is published on the inbound transport (per-envelope replyTo), not pinned to memory', async () => {
    const h = mkHarness();
    try {
      const real = await twoAgentFleet(h);
      // Graft a kafka transport onto pr-reviewer.
      const kafkaOn = real.agents.map((a) => {
        if (!a.capabilities || a.id !== 'pr-reviewer') return a;
        return {
          ...a,
          capabilities: {
            ...a.capabilities,
            config: {
              ...a.capabilities.config,
              transports: [
                ...a.capabilities.config.transports,
                {
                  kind: 'kafka' as const,
                  brokers: ['broker:9092'],
                  topics: { requests: 'agents.pr-reviewer.requests.kafka' },
                },
              ],
            },
          },
        };
      });
      const grafted = {
        ...real,
        agents: kafkaOn,
        agentsById: new Map(kafkaOn.map((a) => [a.id, a])),
      };

      // Fake kafka transport: records what's published + lets us inject a request.
      const kafkaPublished: { topic: string; envelope: AgentRpcEnvelope }[] = [];
      let kafkaHandler: ((e: AgentRpcEnvelope) => Promise<void>) | undefined;
      const kafkaFactory: FleetTransportFactory = () => ({
        kind: 'kafka' as const,
        publish: async (topic: string, envelope: AgentRpcEnvelope) => {
          kafkaPublished.push({ topic, envelope });
        },
        subscribe: (_topic: string, handler: (e: AgentRpcEnvelope) => Promise<void>) => {
          kafkaHandler = handler;
          return () => {};
        },
        close: async () => {},
      });

      const bus = createMemoryBus();
      const daemon = await startFleetDaemon({
        fleet: grafted,
        bus,
        transportFactories: { kafka: kafkaFactory },
        makeHandler: () => defaultHandler,
      });
      try {
        if (!kafkaHandler) throw new Error('kafka transport never subscribed');
        // A request that arrived over kafka, asking for a kafka reply.
        await kafkaHandler({
          version: 1,
          kind: 'request',
          messageId: 'm-kafka-1',
          correlationId: 'c-kafka-1',
          from: 'agent://concierge',
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          replyTo: 'kafka://agents.concierge.responses',
          payload: { prUrl: 'x' },
          auth: { kind: 'internal' },
        } as AgentRpcEnvelope);
        await new Promise((r) => setTimeout(r, 30));

        // The response went out on the KAFKA transport (the fix) — not memory.
        expect(kafkaPublished).toHaveLength(1);
        expect(kafkaPublished[0]?.topic).toBe('agents.concierge.responses');
        expect(kafkaPublished[0]?.envelope.kind).toBe('response');
        expect(kafkaPublished[0]?.envelope.correlationId).toBe('c-kafka-1');
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('unregistered transport kind is warned about + skipped (not fatal)', async () => {
    const h = mkHarness();
    try {
      const real = await twoAgentFleet(h);
      const kafkaOn = real.agents.map((a) => {
        if (!a.capabilities) return a;
        return {
          ...a,
          capabilities: {
            ...a.capabilities,
            config: {
              ...a.capabilities.config,
              transports: [
                ...a.capabilities.config.transports,
                {
                  kind: 'kafka' as const,
                  brokers: ['broker:9092'],
                  topics: { requests: 'agents.pr-reviewer.requests.kafka' },
                },
              ],
            },
          },
        };
      });
      const grafted = {
        ...real,
        agents: kafkaOn,
        agentsById: new Map(kafkaOn.map((a) => [a.id, a])),
      };

      const errs: string[] = [];
      const io: FleetRunIO = {
        out: () => {},
        err: (s) => {
          errs.push(s);
        },
      };
      const daemon = await startFleetDaemon({
        fleet: grafted,
        bus: createMemoryBus(),
        // No transportFactories for kafka — should warn + skip.
        io,
        makeHandler: () => defaultHandler,
      });
      try {
        expect(errs.some((e) => e.includes('kafka'))).toBe(true);
        expect(errs.some((e) => e.includes('no factory'))).toBe(true);
        // Daemon still ran — memory transport still bound.
        expect(daemon.agents.get('pr-reviewer')?.topics).toContain('agents.pr-reviewer.requests');
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });
});

// ── Round 6: #4 inline verify-auth + #11 typed-capability wiring ──────
//
// The daemon-level tests below exercise the two integrations landed in
// fleet-run.ts:
//
//   - #4 — `startAgentWorker.onRequest` verifies inbound envelopes
//          against an injected `AuthVerifyRegistry` before dispatching
//          to the handler. Rejects land in the `rejected_events` table
//          (via `authRejectSink`) + emit an `auth_check` audit row.
//
//   - #11 — the producer-side `RequestAgent` tool is built with the
//          fleet-run-wide validator registry + peer-capability map so
//          payloads that violate a peer's `inputSchema` short-circuit
//          pre-publish + emit a `capability_schema_violation` audit row.
//
// Both tests stub the runtime surfaces (audit sink + reject sink) so the
// coverage is hermetic — no sqlite, no IdP.

function makeMemoryAuditSink(): {
  sink: TenantAuditSink;
  records: TenantAuditRecord[];
} {
  const records: TenantAuditRecord[] = [];
  const sink: TenantAuditSink = {
    async record(r) {
      records.push(r);
    },
    async query() {
      return records.map(
        (r, i) =>
          ({
            seq: i + 1,
            record: r,
            prevHash: '',
            recordHash: '',
          }) as StoredAuditEntry,
      );
    },
    async erase() {
      return 0;
    },
    async verify() {
      return {
        ok: true,
        totalEntries: records.length,
        verifiedEntries: records.length,
        violations: [],
      };
    },
    async prune() {
      return 0;
    },
    close() {
      /* no-op */
    },
  };
  return { sink, records };
}

describe('fleet-run #4 inline verify-auth', () => {
  test('unauthenticated envelope lands in DLQ + emits auth_check reject row', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const bus = createMemoryBus();
      const { sink, records } = makeMemoryAuditSink();

      // Always-reject registry — simulates a peer whose token failed
      // verify without needing a real IdP/JWT pipeline.
      const rejectingRegistry: AuthVerifyRegistry = {
        resolve(peerId) {
          if (peerId !== 'agent://concierge') return undefined;
          return {
            config: {
              provider: 'oauth2-client',
              tokenEndpoint: 'https://idp.test/token',
              clientId: 'test',
              clientSecretRef: 'env:STUB',
            } as never,
            provider: {
              name: 'oauth2-client',
              async sign() {
                return { kind: 'internal' };
              },
              async verify() {
                return {
                  ok: false,
                  reason: 'bad-signature',
                  message: 'stub-provider: payload unsigned',
                };
              },
            },
          };
        },
      };

      const dlqDrops: Array<{ id: string; reason: string; message: string }> = [];
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        authRegistry: rejectingRegistry,
        auditSink: sink,
        authRejectSink: (entry) => {
          dlqDrops.push({
            id: entry.envelope.messageId,
            reason: entry.reason,
            message: entry.message,
          });
        },
        makeHandler: () => async () => {
          throw new Error('handler should never run — auth rejected first');
        },
      });
      try {
        // Publish a request envelope directly onto pr-reviewer's topic,
        // impersonating concierge.
        const conciergeTransport = createMemoryTransport({ bus });
        const envelope: AgentRpcEnvelope = {
          version: 1,
          kind: 'request',
          messageId: 'msg-auth-1',
          correlationId: 'corr-auth-1',
          from: 'agent://concierge',
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: { prUrl: 'x' },
          auth: { kind: 'internal' },
        };
        await conciergeTransport.publish('agents.pr-reviewer.requests', envelope);
        // Allow async handlers to settle.
        await new Promise((r) => setTimeout(r, 50));

        // DLQ sink captured the drop.
        expect(dlqDrops).toHaveLength(1);
        expect(dlqDrops[0]).toEqual({
          id: 'msg-auth-1',
          reason: 'auth-rejected',
          message: 'stub-provider: payload unsigned',
        });

        // Audit sink captured an auth_check `reject` row.
        const authChecks = records.filter((r) => r.kind === 'auth_check');
        expect(authChecks).toHaveLength(1);
        const first = authChecks[0];
        if (first === undefined || first.kind !== 'auth_check') {
          throw new Error('expected auth_check record');
        }
        expect(first.decision).toBe('reject');
        expect(first.reason).toBe('bad-signature');
        expect(first.peerId).toBe('agent://concierge');
        expect(first.correlationId).toBe('corr-auth-1');

        // Handler never ran → `responded` stays at 0, but the worker
        // received + metrics'd the envelope before short-circuiting.
        const metrics = daemon.agents.get('pr-reviewer')?.metrics();
        expect(metrics?.received).toBe(1);
        expect(metrics?.responded).toBe(0);
        await conciergeTransport.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  // WS2 — strictAuth fails closed on a sender with no registry entry.
  test('strictAuth rejects an unregistered sender (unknown-peer), handler never runs', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const bus = createMemoryBus();
      const { sink, records } = makeMemoryAuditSink();
      // Registry that knows about NOBODY — every resolve misses.
      const emptyRegistry: AuthVerifyRegistry = { resolve: () => undefined };

      const dlqDrops: Array<{ id: string; reason: string }> = [];
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        authRegistry: emptyRegistry,
        strictAuth: true,
        auditSink: sink,
        authRejectSink: (entry) => {
          dlqDrops.push({ id: entry.envelope.messageId, reason: entry.reason });
        },
        makeHandler: () => async () => {
          throw new Error('handler should never run — unknown peer rejected first');
        },
      });
      try {
        const attackerTransport = createMemoryTransport({ bus });
        await attackerTransport.publish('agents.pr-reviewer.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-spoof-1',
          correlationId: 'corr-spoof-1',
          from: 'agent://attacker-not-in-registry',
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: { prUrl: 'x' },
          auth: { kind: 'internal' },
        } as AgentRpcEnvelope);
        await new Promise((r) => setTimeout(r, 50));

        expect(dlqDrops).toHaveLength(1);
        expect(dlqDrops[0]?.reason).toBe('auth-rejected');
        const authChecks = records.filter((r) => r.kind === 'auth_check');
        expect(authChecks).toHaveLength(1);
        const rec = authChecks[0];
        if (rec === undefined || rec.kind !== 'auth_check') throw new Error('expected auth_check');
        expect(rec.decision).toBe('reject');
        expect(rec.reason).toBe('unknown-peer');
        const metrics = daemon.agents.get('pr-reviewer')?.metrics();
        expect(metrics?.responded).toBe(0);
        await attackerTransport.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe('fleet-run #11 typed-capability validation', () => {
  test('schema-violation rejects pre-wire + emits capability_schema_violation audit row', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const bus = createMemoryBus();
      const { sink, records } = makeMemoryAuditSink();

      // Build a peer-capability table that declares an enum-gated
      // `severity` field — calls with a value outside the enum must
      // reject pre-wire (status: 'schema-violation') + emit an audit row.
      const typedCaps: LoadedCapabilities = parseCapabilitiesConfig({
        version: 1,
        agent: 'agent://pr-reviewer',
        transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
        capabilities: [
          {
            name: 'review-pr',
            inputSchema: {
              type: 'object',
              properties: {
                prUrl: { type: 'string' },
                severity: { enum: ['low', 'med', 'high'] },
              },
              required: ['severity'],
            },
          },
        ],
      });
      const peerCapabilities = new Map<AgentAddress, LoadedCapabilities>([
        ['agent://pr-reviewer' as AgentAddress, typedCaps],
      ]);
      const validators = createCapabilityValidatorRegistry();

      // Emitter writes to the shared audit sink — mirrors the
      // production `fleet-run.ts` wiring.
      const emitter: CapabilitySchemaViolationEmitter = async (event) => {
        await sink.record({
          kind: 'capability_schema_violation',
          ts: Date.now(),
          tenantId: 'default',
          capabilityName: event.capabilityName,
          peerId: event.peerId,
          side: event.side,
          violations: event.violations,
          correlationId: event.correlationId,
        });
      };

      const peers = parsePeersConfig({
        version: 1,
        peers: [
          {
            agent: 'agent://pr-reviewer',
            transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
          },
        ],
      });

      const daemon = await startFleetDaemon({
        fleet,
        bus,
        peers,
        peerCapabilities,
        validators,
        onSchemaViolation: emitter,
        makeHandler: () => defaultHandler,
      });
      try {
        // Hand-build a RequestAgent tool wired with the same validator
        // stack — exercises the exact fleet-run-llm-handler wiring path.
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
          peers,
          transports: new Map([['memory', conciergeTransport]]),
          pending,
          replyTo: 'memory://agents.concierge.responses',
          peerCapabilities,
          validators,
          onSchemaViolation: emitter,
        });

        const events = await collectEvents(
          tool.execute(
            {
              to: 'agent://pr-reviewer',
              capability: 'review-pr',
              // `severity: 'critical'` is outside the declared enum.
              payload: { prUrl: 'x', severity: 'critical' },
              timeoutMs: 2000,
            },
            makeToolContext(),
          ),
        );
        // Pre-wire rejection: status `schema-violation`, no envelope
        // reaches the receiver, no handler invocation.
        expect(events.result?.status).toBe('schema-violation');
        expect(events.result?.schemaSide).toBe('request');
        expect(events.result?.error?.code).toBe('EAGENTRPC_SCHEMA_VIOLATION');

        // Audit row landed — exactly one `capability_schema_violation`
        // entry per envelope (POST_ENTERPRISE_BACKLOG.md #9: audit
        // cardinality is batched per envelope, never per violation — so
        // a bad-actor envelope that trips N fields still emits 1 row).
        const schemaRows = records.filter((r) => r.kind === 'capability_schema_violation');
        expect(schemaRows).toHaveLength(1);
        const first = schemaRows[0];
        if (first === undefined || first.kind !== 'capability_schema_violation') {
          throw new Error('expected capability_schema_violation record');
        }
        expect(first.capabilityName).toBe('review-pr');
        expect(first.peerId).toBe('agent://pr-reviewer');
        expect(first.side).toBe('request');
        expect(first.violations.length).toBeGreaterThan(0);

        // The receiver never processed a request — validator rejected
        // before publish.
        const metrics = daemon.agents.get('pr-reviewer')?.metrics();
        expect(metrics?.received).toBe(0);
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

// ── #43 loadAgent memoization ────────────────────────────────────────────

describe('createMemoizedLoadAgent', () => {
  test('calls the loader once per unique agent path', async () => {
    const calls: string[] = [];
    const memo = createMemoizedLoadAgent(async (agent) => {
      calls.push(agent.path);
      // Minimal shape — cache contract is identity-equivalence of the
      // returned promise, not the LoadedAgent's internals.
      return { spec: { name: agent.id } } as unknown as Awaited<ReturnType<typeof memo>>;
    });
    const a = { id: 'a', path: '/tmp/a' } as unknown as Parameters<typeof memo>[0];
    const b = { id: 'b', path: '/tmp/b' } as unknown as Parameters<typeof memo>[0];
    const first = await memo(a);
    const second = await memo(a);
    expect(first).toBe(second);
    expect(calls).toEqual(['/tmp/a']);
    await memo(b);
    expect(calls).toEqual(['/tmp/a', '/tmp/b']);
    // Same path → cache hit, still just two distinct loader invocations.
    await memo(a);
    await memo(b);
    expect(calls).toEqual(['/tmp/a', '/tmp/b']);
  });

  test('failed loads stay in the cache so the probe does not re-read bad disk', async () => {
    let calls = 0;
    const memo = createMemoizedLoadAgent(async () => {
      calls += 1;
      throw new Error('bad yaml');
    });
    const a = { id: 'a', path: '/tmp/a' } as unknown as Parameters<typeof memo>[0];
    await expect(memo(a)).rejects.toThrow('bad yaml');
    await expect(memo(a)).rejects.toThrow('bad yaml');
    expect(calls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST_ENTERPRISE_BACKLOG.md #18 — per-agent auth registry
//
// The original 0.7.x wiring built ONE fleet-wide `AuthVerifyRegistry`
// and passed it to every worker. That collapses when two agents in the
// same fleet trust disjoint peer sets (e.g. tenant-X signer vs
// tenant-Y signer) — the fleet-wide registry would let A's peer talk
// to B.
//
// These tests exercise the per-agent override via `authRegistryByAgent`:
//   1. Two agents with disjoint peer sets → an envelope signed for A's
//      peer set is rejected when routed to B.
//   2. Agent with no per-agent entry → falls back to fleet-root
//      `authRegistry`.
//   3. Mixed fleet: agent A has per-agent registry, agent B doesn't →
//      A uses its own, B uses fleet-root.
//   4. Accessor `daemon.authRegistryFor(agentId)` resolves the same
//      effective registry the worker is bound to — exposed for the
//      control-plane Slice 3 fan-out.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tenant-scoped stub registry: accepts envelopes only from the specific
 * `trustedPeer` argument. Everything else rejects with `bad-signature`.
 * Mirrors the pattern used by the existing #4 test — no real IdP.
 */
function makeTenantRegistry(trustedPeer: string): AuthVerifyRegistry {
  return {
    resolve(peerId) {
      return {
        config: {
          provider: 'oauth2-client',
          tokenEndpoint: 'https://idp.test/token',
          clientId: 'test',
          clientSecretRef: 'env:STUB',
        } as never,
        provider: {
          name: 'oauth2-client',
          async sign() {
            return { kind: 'internal' };
          },
          async verify() {
            if (peerId === trustedPeer) {
              return {
                ok: true,
                principal: {
                  subject: `sub:${peerId}`,
                  issuer: 'https://idp.test/',
                  audience: 'agent://rcv',
                  scopes: [],
                  claims: {},
                },
              };
            }
            return {
              ok: false,
              reason: 'bad-signature',
              message: `peer ${peerId} not trusted by this registry`,
            };
          },
        },
      };
    },
  };
}

describe('fleet-run #18 per-agent auth registry', () => {
  test('two agents with disjoint peer sets reject cross-tenant envelopes', async () => {
    const h = mkHarness();
    try {
      // Three-agent fleet: alpha trusts tenant-X, beta trusts tenant-Y,
      // and both expose a memory-transport capability.
      h.write(
        'fleet.yaml',
        `version: 1
name: disjoint-tenants
agents:
  - id: alpha
    path: ./agents/alpha
  - id: beta
    path: ./agents/beta
  - id: tenant-x-signer
    path: ./agents/tenant-x-signer
  - id: tenant-y-signer
    path: ./agents/tenant-y-signer
`,
      );
      h.write('agents/alpha/agent.yaml', 'name: alpha\n');
      h.write(
        'agents/alpha/capabilities.yaml',
        `version: 1
agent: agent://alpha
transports:
  - kind: memory
    topics: { requests: agents.alpha.requests }
capabilities:
  - name: do-alpha
`,
      );
      h.write('agents/beta/agent.yaml', 'name: beta\n');
      h.write(
        'agents/beta/capabilities.yaml',
        `version: 1
agent: agent://beta
transports:
  - kind: memory
    topics: { requests: agents.beta.requests }
capabilities:
  - name: do-beta
`,
      );
      h.write('agents/tenant-x-signer/agent.yaml', 'name: tenant-x-signer\n');
      h.write('agents/tenant-y-signer/agent.yaml', 'name: tenant-y-signer\n');

      const fleet = await loadFleet({ root: h.root });
      const bus = createMemoryBus();
      const { sink, records } = makeMemoryAuditSink();

      const alphaRegistry = makeTenantRegistry('agent://tenant-x-signer');
      const betaRegistry = makeTenantRegistry('agent://tenant-y-signer');

      const dlqDrops: Array<{ id: string; reason: string; message: string }> = [];
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        authRegistryByAgent: new Map([
          ['alpha', alphaRegistry],
          ['beta', betaRegistry],
        ]),
        auditSink: sink,
        authRejectSink: (entry) => {
          dlqDrops.push({
            id: entry.envelope.messageId,
            reason: entry.reason,
            message: entry.message,
          });
        },
        makeHandler: () => defaultHandler,
      });
      try {
        const sender = createMemoryTransport({ bus });

        // Case 1: tenant-Y-signer tries to call alpha (trusts tenant-X only).
        // Must be rejected — this is the cross-tenant leakage the item
        // was filed to prevent.
        await sender.publish('agents.alpha.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-alpha-cross',
          correlationId: 'corr-alpha-cross',
          from: 'agent://tenant-y-signer',
          to: 'agent://alpha',
          capability: 'do-alpha',
          payload: {},
          auth: { kind: 'internal' },
        });

        // Case 2: tenant-Y-signer calls beta (its legitimate target).
        // Must be accepted.
        await sender.publish('agents.beta.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-beta-ok',
          correlationId: 'corr-beta-ok',
          from: 'agent://tenant-y-signer',
          to: 'agent://beta',
          capability: 'do-beta',
          payload: {},
          auth: { kind: 'internal' },
        });

        await new Promise((r) => setTimeout(r, 50));

        // Cross-tenant drop registered exactly once, on alpha's side.
        expect(dlqDrops).toHaveLength(1);
        expect(dlqDrops[0]?.id).toBe('msg-alpha-cross');

        const authChecks = records.filter((r) => r.kind === 'auth_check');
        const byCorrelation = new Map(authChecks.map((r) => [r.correlationId, r]));
        expect(byCorrelation.get('corr-alpha-cross')?.decision).toBe('reject');
        expect(byCorrelation.get('corr-beta-ok')?.decision).toBe('accept');

        // Metrics: alpha short-circuited (handler never ran); beta
        // processed the one legitimate envelope.
        expect(daemon.agents.get('alpha')?.metrics().received).toBe(1);
        expect(daemon.agents.get('alpha')?.metrics().responded).toBe(0);
        expect(daemon.agents.get('beta')?.metrics().received).toBe(1);
        expect(daemon.agents.get('beta')?.metrics().responded).toBe(1);

        // Accessor returns the agent-specific registry, not a stand-in.
        expect(daemon.authRegistryFor('alpha')).toBe(alphaRegistry);
        expect(daemon.authRegistryFor('beta')).toBe(betaRegistry);

        await sender.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('agent without per-agent entry falls back to fleet-root registry', async () => {
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const bus = createMemoryBus();

      const fleetRootRegistry = makeTenantRegistry('agent://concierge');

      const dlqDrops: Array<{ id: string }> = [];
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        authRegistry: fleetRootRegistry,
        // Empty map — no per-agent overrides → every agent falls back
        // to fleetRootRegistry.
        authRegistryByAgent: new Map(),
        authRejectSink: (entry) => {
          dlqDrops.push({ id: entry.envelope.messageId });
        },
        makeHandler: () => defaultHandler,
      });
      try {
        const sender = createMemoryTransport({ bus });
        // concierge is trusted by fleet-root → accepted.
        await sender.publish('agents.pr-reviewer.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-fallback-ok',
          correlationId: 'corr-fallback-ok',
          from: 'agent://concierge',
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: {},
          auth: { kind: 'internal' },
        });
        // Stranger not trusted → rejected by the same fallback registry.
        await sender.publish('agents.pr-reviewer.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-fallback-no',
          correlationId: 'corr-fallback-no',
          from: 'agent://stranger',
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: {},
          auth: { kind: 'internal' },
        });
        await new Promise((r) => setTimeout(r, 50));

        expect(dlqDrops).toHaveLength(1);
        expect(dlqDrops[0]?.id).toBe('msg-fallback-no');

        // Fallback is the fleet-root reference, not a clone.
        expect(daemon.authRegistryFor('pr-reviewer')).toBe(fleetRootRegistry);
        expect(daemon.authRegistryFor('concierge')).toBe(fleetRootRegistry);

        await sender.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('mixed: agent A uses per-agent registry, agent B uses fleet-root', async () => {
    const h = mkHarness();
    try {
      // Add a second capability-serving agent alongside pr-reviewer.
      h.write(
        'fleet.yaml',
        `version: 1
name: mixed
agents:
  - id: alpha
    path: ./agents/alpha
  - id: beta
    path: ./agents/beta
`,
      );
      h.write('agents/alpha/agent.yaml', 'name: alpha\n');
      h.write(
        'agents/alpha/capabilities.yaml',
        `version: 1
agent: agent://alpha
transports:
  - kind: memory
    topics: { requests: agents.alpha.requests }
capabilities:
  - name: do-alpha
`,
      );
      h.write('agents/beta/agent.yaml', 'name: beta\n');
      h.write(
        'agents/beta/capabilities.yaml',
        `version: 1
agent: agent://beta
transports:
  - kind: memory
    topics: { requests: agents.beta.requests }
capabilities:
  - name: do-beta
`,
      );
      const fleet = await loadFleet({ root: h.root });
      const bus = createMemoryBus();

      const alphaRegistry = makeTenantRegistry('agent://alpha-peer');
      const fleetRootRegistry = makeTenantRegistry('agent://root-peer');

      const dlqDrops: string[] = [];
      const daemon = await startFleetDaemon({
        fleet,
        bus,
        authRegistry: fleetRootRegistry,
        authRegistryByAgent: new Map([['alpha', alphaRegistry]]),
        authRejectSink: (entry) => {
          dlqDrops.push(entry.envelope.messageId);
        },
        makeHandler: () => defaultHandler,
      });
      try {
        const sender = createMemoryTransport({ bus });

        // alpha-peer → alpha: alpha's specific registry accepts.
        await sender.publish('agents.alpha.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-1',
          correlationId: 'corr-1',
          from: 'agent://alpha-peer',
          to: 'agent://alpha',
          capability: 'do-alpha',
          payload: {},
          auth: { kind: 'internal' },
        });
        // root-peer → alpha: alpha's specific registry doesn't know
        // root-peer. Rejected (the per-agent override MUST NOT consult
        // fleet-root).
        await sender.publish('agents.alpha.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-2',
          correlationId: 'corr-2',
          from: 'agent://root-peer',
          to: 'agent://alpha',
          capability: 'do-alpha',
          payload: {},
          auth: { kind: 'internal' },
        });
        // root-peer → beta: beta falls back to fleet-root → accepted.
        await sender.publish('agents.beta.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-3',
          correlationId: 'corr-3',
          from: 'agent://root-peer',
          to: 'agent://beta',
          capability: 'do-beta',
          payload: {},
          auth: { kind: 'internal' },
        });
        // alpha-peer → beta: beta falls back to fleet-root, which does
        // NOT trust alpha-peer. Rejected.
        await sender.publish('agents.beta.requests', {
          version: 1,
          kind: 'request',
          messageId: 'msg-4',
          correlationId: 'corr-4',
          from: 'agent://alpha-peer',
          to: 'agent://beta',
          capability: 'do-beta',
          payload: {},
          auth: { kind: 'internal' },
        });
        await new Promise((r) => setTimeout(r, 50));

        expect(dlqDrops.sort()).toEqual(['msg-2', 'msg-4']);

        // Accessor surfaces the effective registry per agent.
        expect(daemon.authRegistryFor('alpha')).toBe(alphaRegistry);
        expect(daemon.authRegistryFor('beta')).toBe(fleetRootRegistry);

        await sender.close();
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });

  test('rpcContext.authRegistry surfaces the effective registry to handlers', async () => {
    // Slice-3 (control-plane cross-host fan-out) needs the per-agent
    // registry reachable from the handler factory's rpcContext so a
    // fan-out seam can evaluate auth on the same verifier the worker
    // is bound to.
    const h = mkHarness();
    try {
      const fleet = await twoAgentFleet(h);
      const prRegistry = makeTenantRegistry('agent://concierge');

      const seen = new Map<string, AuthVerifyRegistry | undefined>();
      const daemon = await startFleetDaemon({
        fleet,
        authRegistryByAgent: new Map([['pr-reviewer', prRegistry]]),
        makeHandler: (agent, ctx) => {
          seen.set(agent.id, ctx.authRegistry);
          return defaultHandler;
        },
      });
      try {
        // concierge has no per-agent registry AND no fleet-root → undefined.
        expect(seen.get('concierge')).toBeUndefined();
        // pr-reviewer's rpcContext carries the per-agent registry.
        expect(seen.get('pr-reviewer')).toBe(prRegistry);
      } finally {
        await daemon.shutdown();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe('fleetRun CLI #18 — per-agent rpc-peers.yaml', () => {
  // Integration-style: writes a per-agent `rpc-peers.yaml` on disk,
  // asserts `fleetRun` builds a distinct registry for that agent. We
  // don't actually wire a real OIDC provider — the build-time check is
  // enough; the runtime reject behaviour is covered by the unit tests
  // above (which inject registries directly).
  test('loads <agentPath>/rpc-peers.yaml when present and keys by agent.id', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: per-agent-files
agents:
  - id: alpha
    path: ./agents/alpha
  - id: beta
    path: ./agents/beta
`,
      );
      // alpha opts into rpc.auth AND has its own per-agent peers file
      // with an OAuth2 peer entry. beta has no per-agent file and no
      // opt-in → unchanged behaviour.
      h.write(
        'agents/alpha/agent.yaml',
        `name: alpha
rpc:
  auth:
    enabled: true
`,
      );
      h.write(
        'agents/alpha/rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://tenant-x-signer
    transports:
      - kind: memory
        topics: { requests: agents.alpha.requests }
    auth:
      provider: oauth2-client
      tokenEndpoint: https://idp.tenant-x.example/token
      clientId: alpha-client
      clientSecretRef: env:ALPHA_SECRET
      jwksUri: https://idp.tenant-x.example/jwks
      issuer: https://idp.tenant-x.example/
      audience: agent://alpha
`,
      );
      h.write('agents/beta/agent.yaml', 'name: beta\n');

      // Stub credentials so fleetRun doesn't need a signed-in provider.
      process.env.ALPHA_SECRET = 'stub-secret';
      const { io, out, err } = captureIo();
      const rc = await fleetRun(
        {},
        {
          io,
          root: h.root,
          resolveCredentials: () => ({
            providerId: 'anthropic',
            apiKey: 'sk-test',
            source: 'config',
          }),
          // Replace the LLM-backed handler with the echo default so
          // the run doesn't try to reach a real provider.
          makeHandler: () => defaultHandler,
          onStart: async (daemon) => {
            // The per-agent registry for alpha came from the file we
            // wrote; beta has no entry → accessor returns undefined
            // (no fleet-root file either).
            expect(daemon.authRegistryFor('alpha')).toBeDefined();
            expect(daemon.authRegistryFor('beta')).toBeUndefined();
          },
        },
      );
      expect(rc).toBe(0);
      // Observable log: the per-agent registry load line lists alpha
      // with one peer.
      const joined = out.join('');
      expect(joined).toContain('rpc.auth per-agent: alpha');
      // No fatal errors.
      expect(err.join('')).not.toMatch(/registry build failed/);
    } finally {
      process.env.ALPHA_SECRET = undefined;
      h.cleanup();
    }
  });
});

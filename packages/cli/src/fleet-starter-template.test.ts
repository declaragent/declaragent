/**
 * Slice 9 — end-to-end test of the `fleet-starter` template.
 *
 * Copies the template into a tmpdir (via `addAgentFromPath` is a stretch;
 * we do a direct fs copy since the template is a complete fleet, not
 * a single-agent dir), then:
 *   1. Loads the fleet via the production loader.
 *   2. Asserts the manifest + agents + capabilities + peer table line up.
 *   3. Runs the fleet-run daemon for a full RPC round-trip.
 *
 * This is the acceptance check for slice 9: the template isn't just
 * well-formed on disk — it produces a running two-agent fleet.
 */

import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  AgentSpec,
  Logger,
  PermissionGate,
  SessionHandle,
  ToolContext,
  ToolEvent,
} from '@declaragent/core';
import { aggregateCapabilities, loadFleet, parsePeersConfig } from '@declaragent/core';
import {
  createMemoryBus,
  createMemoryTransport,
  createPendingRegistry,
  createRequestAgentTool,
} from '@declaragent/plugin-agent-rpc';
import { startFleetDaemon } from './fleet-run.js';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const TEMPLATE_DIR = join(REPO_ROOT, 'templates/fleet-starter');

function copyDirSync(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(src, dst);
    } else if (entry.isFile()) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}

function withTemplate<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const dst = mkdtempSync(join(tmpdir(), 'declaragent-fleet-starter-'));
  return fn(dst).finally(() => rmSync(dst, { recursive: true, force: true }));
}

// Minimal ToolContext stub, mirroring fleet-run.test.ts.
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
function makeStubSession(): SessionHandle {
  return {
    id: 't',
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
  result?: O;
}> {
  const out: { result?: O } = {};
  for await (const ev of iter) {
    if (ev.type === 'result') out.result = ev.output;
  }
  return out;
}

describe('templates/fleet-starter', () => {
  test('template directory exists + ships the expected shape', () => {
    // If this fails, the template was moved or renamed — fix it here.
    expect(statSync(TEMPLATE_DIR).isDirectory()).toBe(true);
    expect(statSync(join(TEMPLATE_DIR, 'fleet.yaml')).isFile()).toBe(true);
    expect(statSync(join(TEMPLATE_DIR, 'package.json')).isFile()).toBe(true);
    expect(statSync(join(TEMPLATE_DIR, 'rpc-peers.yaml')).isFile()).toBe(true);
    expect(statSync(join(TEMPLATE_DIR, '.env.example')).isFile()).toBe(true);
    expect(statSync(join(TEMPLATE_DIR, 'agents/concierge/agent.yaml')).isFile()).toBe(true);
    expect(statSync(join(TEMPLATE_DIR, 'agents/pr-reviewer/capabilities.yaml')).isFile()).toBe(
      true,
    );
  });

  test('loadFleet parses the template cleanly + aggregates review-pr', async () => {
    await withTemplate(async (root) => {
      copyDirSync(TEMPLATE_DIR, root);
      const fleet = await loadFleet({ root });
      expect(fleet.manifest.name).toBe('fleet-starter');
      expect(fleet.agents.map((a) => a.id).sort()).toEqual(['concierge', 'pr-reviewer']);

      const caps = aggregateCapabilities(fleet);
      expect(caps.byKey.get('pr-reviewer/review-pr')?.capability.timeoutMs).toBe(60000);
      expect(caps.clientOnly).toEqual(['concierge']);
    });
  });

  test('fleet-run with the template round-trips a review-pr request', async () => {
    await withTemplate(async (root) => {
      copyDirSync(TEMPLATE_DIR, root);
      const fleet = await loadFleet({ root });
      const bus = createMemoryBus();
      const daemon = await startFleetDaemon({ fleet, bus });
      try {
        const producer = createMemoryTransport({ bus });
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
        const detach = producer.subscribe('agents.concierge.responses', async (envelope) => {
          if (envelope.kind !== 'response') return;
          const payload = envelope.payload as { ok: true; data: unknown };
          pending.settle(envelope.correlationId, { status: 'ok', data: payload.data });
        });
        const tool = createRequestAgentTool({
          selfAgent: 'agent://concierge',
          peers,
          transports: new Map([['memory', producer]]),
          pending,
          replyTo: 'memory://agents.concierge.responses',
        });
        const events = await collectEvents(
          tool.execute(
            {
              to: 'agent://pr-reviewer',
              capability: 'review-pr',
              payload: { prUrl: 'https://github.com/acme/app/pull/1' },
              timeoutMs: 2000,
            },
            makeToolContext(),
          ),
        );
        expect(events.result?.status).toBe('ok');
        const data = events.result?.response as { echoed: { prUrl: string } };
        expect(data.echoed.prUrl).toBe('https://github.com/acme/app/pull/1');
        detach();
        await producer.close();
      } finally {
        await daemon.shutdown();
      }
    });
  });
});

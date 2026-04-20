/**
 * End-to-end phase-4 acceptance check. Mirrors the BUILDER_PLAN.md §7
 * phase-4 target transcript:
 *
 *   "build a concierge + pr-reviewer fleet"
 *
 * We don't drive this through a real LLM; instead we construct a
 * proposal by hand that resembles what the model would emit and apply
 * it end-to-end. That exercises every phase-4 wire without needing
 * an API call.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetInit } from '../fleet-init-cli.js';
import { createApplyChangeTool } from './apply-change.js';
import { ProposalRegistry } from './proposals.js';

function makeCtx() {
  return {
    session: {} as never,
    permissions: {} as never,
    abortSignal: new AbortController().signal,
    depth: 0,
    runAgent: (async () => ({}) as never) as never,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as never,
  };
}

describe('phase-4 end-to-end', () => {
  let root: string;
  let fleetRoot: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'declara-phase4-e2e-'));
    await fleetInit(
      { name: 'demo' },
      {
        cwd: root,
        io: {
          out: () => {},
          err: () => {},
        },
      },
    );
    fleetRoot = join(root, 'demo');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('builds a concierge + pr-reviewer fleet via propose→apply', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: fleetRoot });

    // Register a proposal shaped like what the fleet heuristic asks
    // the model to emit: two agents + peer wiring, all in one flow.
    const { proposal } = reg.register({
      summary: 'build a concierge + pr-reviewer fleet',
      steps: [
        {
          kind: 'addAgent',
          description: 'scaffold concierge from template',
          payload: { template: 'concierge', id: 'concierge' },
        },
        {
          kind: 'addAgent',
          description: 'scaffold pr-reviewer from rpc-server template',
          payload: { template: 'rpc-server', id: 'pr-reviewer' },
        },
        {
          kind: 'addPeer',
          description: 'wire concierge → pr-reviewer over memory',
          payload: {
            agent: 'agent://pr-reviewer',
            transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
          },
        },
      ],
    });

    reg.confirm(proposal.id);

    const events: unknown[] = [];
    for await (const ev of tool.execute({ proposalId: proposal.id }, makeCtx())) {
      events.push(ev);
    }

    const ev = events[0] as {
      type: string;
      output?: {
        ok: boolean;
        results: Array<{ kind: string; ok: boolean; error?: string }>;
      };
    };
    expect(ev.type).toBe('result');
    if (ev.output?.ok !== true) {
      // Surface the first failing step's error so regressions are obvious.
      const firstFail = ev.output?.results.find((r) => !r.ok);
      throw new Error(
        `apply failed: ${firstFail?.kind ?? '?'} — ${firstFail?.error ?? 'no error'}`,
      );
    }
    expect(ev.output.results).toHaveLength(3);
    for (const r of ev.output.results) {
      expect(r.ok).toBe(true);
    }

    // Fleet is coherent on disk.
    expect(existsSync(join(fleetRoot, 'agents/concierge/agent.yaml'))).toBe(true);
    expect(existsSync(join(fleetRoot, 'agents/pr-reviewer/agent.yaml'))).toBe(true);
    expect(existsSync(join(fleetRoot, 'rpc-peers.yaml'))).toBe(true);

    const peers = readFileSync(join(fleetRoot, 'rpc-peers.yaml'), 'utf-8');
    expect(peers).toContain('agent://pr-reviewer');
    expect(peers).toContain('agents.pr-reviewer.requests');

    const fleetYaml = readFileSync(join(fleetRoot, 'fleet.yaml'), 'utf-8');
    expect(fleetYaml).toContain('concierge');
    expect(fleetYaml).toContain('pr-reviewer');

    // Proposal state moved to applied.
    expect(reg.get(proposal.id)?.status).toBe('applied');
  });
});

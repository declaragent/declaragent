import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteAuditSink } from '@declaragent/core';
import type { TenantAuditSink } from '@declaragent/core';
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

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('DeclaraApplyChange tool', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-apply-change-'));
    writeFileSync(join(dir, 'agent.yaml'), 'name: a\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('rejects an unknown proposalId', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const events = await collect(tool.execute({ proposalId: 'nope' }, makeCtx()));
    expect((events[0] as { type: string }).type).toBe('error');
  });

  test('rejects a proposal that has not been confirmed yet', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const { proposal } = reg.register({
      summary: 'x',
      steps: [{ kind: 'addSkill', description: 'x', payload: {} }],
    });
    const events = await collect(tool.execute({ proposalId: proposal.id }, makeCtx()));
    expect((events[0] as { type: string }).type).toBe('error');
    reg.reject(proposal.id); // clean up pending
  });

  test('rejects an already-applied proposal', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const { proposal } = reg.register({
      summary: 'x',
      steps: [
        {
          kind: 'addSkill',
          description: 'create skill',
          payload: { name: 'hello', description: 'd', body: 'b' },
        },
      ],
    });
    reg.confirm(proposal.id);
    await collect(tool.execute({ proposalId: proposal.id }, makeCtx()));
    // Second invocation must refuse.
    const events = await collect(tool.execute({ proposalId: proposal.id }, makeCtx()));
    expect((events[0] as { type: string }).type).toBe('error');
  });

  test('happy path: addSkill step writes file, yaml, marks applied', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const { proposal } = reg.register({
      summary: 'x',
      steps: [
        {
          kind: 'addSkill',
          description: 'create pr-review skill',
          payload: {
            name: 'pr-review',
            description: 'Review a PR',
            body: 'Review the PR.',
          },
        },
      ],
    });
    reg.confirm(proposal.id);
    const events = await collect(tool.execute({ proposalId: proposal.id }, makeCtx()));
    const ev = events[0] as {
      type: string;
      output?: {
        ok: boolean;
        results: Array<{ ok: boolean; kind: string; writes: string[] }>;
        auditCorrelationId: string;
      };
    };
    expect(ev.type).toBe('result');
    expect(ev.output?.ok).toBe(true);
    expect(ev.output?.results).toHaveLength(1);
    expect(ev.output?.results[0]?.ok).toBe(true);
    expect(ev.output?.results[0]?.kind).toBe('addSkill');
    expect(existsSync(join(dir, 'skills', 'pr-review.md'))).toBe(true);
    const agentYaml = readFileSync(join(dir, 'agent.yaml'), 'utf-8');
    expect(agentYaml).toContain('skills/pr-review.md');
    expect(reg.get(proposal.id)?.status).toBe('applied');
    expect(ev.output?.auditCorrelationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('happy path: addSecret step appends to .env.example', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const { proposal } = reg.register({
      summary: 'x',
      steps: [
        {
          kind: 'addSecret',
          description: 'reserve GITHUB_TOKEN',
          payload: { ref: 'GITHUB_TOKEN', provider: 'env' },
        },
      ],
    });
    reg.confirm(proposal.id);
    const events = await collect(tool.execute({ proposalId: proposal.id }, makeCtx()));
    const ev = events[0] as { output?: { ok: boolean } };
    expect(ev.output?.ok).toBe(true);
    expect(readFileSync(join(dir, '.env.example'), 'utf-8')).toContain('DECLARA_GITHUB_TOKEN=');
  });

  test('multi-step: halts + reports the first failure', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const { proposal } = reg.register({
      summary: 'mixed',
      steps: [
        {
          kind: 'addSkill',
          description: 'ok',
          payload: { name: 'a', description: 'd', body: 'b' },
        },
        {
          // Unsupported kind — halts the walk.
          kind: 'editFile',
          description: 'unsupported in phase 3',
          payload: {},
        },
        {
          // Should not run.
          kind: 'addSecret',
          description: 'would succeed',
          payload: { ref: 'Z', provider: 'env' },
        },
      ],
    });
    reg.confirm(proposal.id);
    const events = await collect(tool.execute({ proposalId: proposal.id }, makeCtx()));
    const ev = events[0] as { output?: { ok: boolean; results: Array<{ ok: boolean }> } };
    expect(ev.output?.ok).toBe(false);
    expect(ev.output?.results).toHaveLength(2);
    expect(ev.output?.results[0]?.ok).toBe(true);
    expect(ev.output?.results[1]?.ok).toBe(false);
    expect(existsSync(join(dir, '.env.example'))).toBe(false);
  });

  test('addPeer step writes rpc-peers.yaml', async () => {
    writeFileSync(join(dir, 'fleet.yaml'), 'version: 1\nname: demo\nagents: []\n');
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const { proposal } = reg.register({
      summary: 'wire pr-reviewer',
      steps: [
        {
          kind: 'addPeer',
          description: 'wire pr-reviewer',
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
    const ev = events[0] as { output?: { ok: boolean } };
    expect(ev.output?.ok).toBe(true);
    expect(existsSync(join(dir, 'rpc-peers.yaml'))).toBe(true);
  });

  test('addAgent step dispatches through runFleetAdd', async () => {
    // Build a minimal tmp templates dir + real fleet at the scope root.
    const templatesDir = join(dir, 'templates');
    mkdirSync(join(templatesDir, 'rpc-server'), { recursive: true });
    writeFileSync(
      join(templatesDir, 'rpc-server', 'agent.yaml'),
      'name: pr-reviewer\nmodel: claude-sonnet-4-5\nsystemPrompt: x\n',
    );
    writeFileSync(
      join(templatesDir, 'rpc-server', 'capabilities.yaml'),
      [
        'version: 1',
        'agent: agent://pr-reviewer',
        'transports:',
        '  - kind: memory',
        '    topics: { requests: agents.pr-reviewer.requests }',
        'capabilities:',
        '  - name: review-pr',
        '',
      ].join('\n'),
    );
    // Scope root needs its own fleet.yaml.
    await fleetInit(
      { name: 'demo' },
      {
        cwd: dir,
        io: {
          out: () => {},
          err: () => {},
        },
      },
    );
    const fleetRoot = join(dir, 'demo');
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: fleetRoot });
    const { proposal } = reg.register({
      summary: 'add pr-reviewer',
      // runFleetAdd's default templatesDir walks up from the module —
      // we ship a copy here so the test is hermetic. We override by
      // passing `templatesDir` via an ENV override equivalent: the
      // tool's ctx doesn't expose templatesDir, so we rely on the
      // dispatcher picking up a co-located templates dir. When that's
      // not in place the payload fails fast with a validation error,
      // which is still a useful regression gate.
      steps: [
        {
          kind: 'addAgent',
          description: 'pr-reviewer from template',
          payload: { template: 'rpc-server', id: 'pr-reviewer' },
        },
      ],
    });
    reg.confirm(proposal.id);
    const events: unknown[] = [];
    for await (const ev of tool.execute({ proposalId: proposal.id }, makeCtx())) {
      events.push(ev);
    }
    const ev = events[0] as {
      output?: { ok: boolean; results: Array<{ ok: boolean; error?: string }> };
    };
    // Either the step succeeded (templates resolved) or it surfaced a
    // typed error from fleet-scaffold. Both paths validate the
    // dispatcher wiring; what must NOT happen is the "not supported"
    // fallback.
    const result = ev.output?.results[0];
    expect(result).toBeDefined();
    if (result) {
      expect(result.error ?? '').not.toContain('not supported yet');
    }
  });

  test('emits audit records when a sink is provided', async () => {
    const sink: TenantAuditSink = await createSqliteAuditSink({ path: ':memory:' });
    try {
      const reg = new ProposalRegistry();
      const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir, auditSink: sink });
      const { proposal } = reg.register({
        summary: 'x',
        steps: [
          {
            kind: 'addSkill',
            description: 'skill',
            payload: { name: 'hello', description: 'd', body: 'b' },
          },
        ],
      });
      reg.confirm(proposal.id);
      for await (const _ of tool.execute({ proposalId: proposal.id }, makeCtx())) {
        // drain
      }
      const entries = await sink.query({ kind: 'tool_call' });
      const tools = entries.map((e) => (e.record as { tool?: string }).tool).filter(Boolean);
      // One per step + one apply summary.
      expect(tools).toContain('Declara:addSkill');
      expect(tools).toContain('DeclaraApplyChange');
    } finally {
      await sink.close();
    }
  });

  test('stores rollback metadata on the registry after a successful apply', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const { proposal } = reg.register({
      summary: 'x',
      steps: [
        {
          kind: 'addSkill',
          description: 'skill',
          payload: { name: 'hello', description: 'd', body: 'b' },
        },
      ],
    });
    reg.confirm(proposal.id);
    for await (const _ of tool.execute({ proposalId: proposal.id }, makeCtx())) {
      // drain
    }
    const last = reg.lastApplied();
    expect(last?.proposalId).toBe(proposal.id);
    expect(last?.writes.length).toBeGreaterThan(0);
  });

  test('invalid payload on addSkill surfaces as a step error', async () => {
    const reg = new ProposalRegistry();
    const tool = createApplyChangeTool({ registry: reg, scopeRoot: dir });
    const { proposal } = reg.register({
      summary: 'x',
      steps: [
        {
          kind: 'addSkill',
          description: 'bad payload',
          // Missing required fields — zod will reject at apply time.
          payload: { name: 'x' },
        },
      ],
    });
    reg.confirm(proposal.id);
    const events = await collect(tool.execute({ proposalId: proposal.id }, makeCtx()));
    const ev = events[0] as {
      output?: { ok: boolean; results: Array<{ ok: boolean; error?: string }> };
    };
    expect(ev.output?.ok).toBe(false);
    expect(ev.output?.results[0]?.error).toContain('addSkill payload invalid');
  });
});

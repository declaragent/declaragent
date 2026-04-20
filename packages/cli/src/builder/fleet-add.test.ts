import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetInit } from '../fleet-init-cli.js';
import { createFleetAddTool, runFleetAdd } from './fleet-add.js';
import { BuilderScopeError, BuilderValidationError } from './types.js';

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (s: string) => {
        out.push(s);
      },
      err: (s: string) => {
        err.push(s);
      },
    },
    out,
    err,
  };
}

function scaffoldTemplate(root: string): string {
  const templatesDir = join(root, 'templates');
  mkdirSync(join(templatesDir, 'rpc-server'), { recursive: true });
  writeFileSync(
    join(templatesDir, 'rpc-server', 'agent.yaml'),
    'name: pr-reviewer\nmodel: claude-sonnet-4-5\nsystemPrompt: hi\n',
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
  return templatesDir;
}

async function scaffoldFleet(root: string): Promise<string> {
  await fleetInit({ name: 'demo' }, { cwd: root, io: captureIo().io });
  return join(root, 'demo');
}

describe('runFleetAdd', () => {
  let root: string;
  let fleetRoot: string;
  let templatesDir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'declara-builder-fleet-add-'));
    templatesDir = scaffoldTemplate(root);
    fleetRoot = await scaffoldFleet(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('writes a new agent + updates fleet.yaml', async () => {
    const out = await runFleetAdd(
      { template: 'rpc-server' },
      { scopeRoot: fleetRoot, templatesDir },
    );
    expect(out.ok).toBe(true);
    expect(out.agentId).toBe('pr-reviewer');
    expect(existsSync(join(fleetRoot, 'agents/pr-reviewer/agent.yaml'))).toBe(true);
    const fleet = readFileSync(join(fleetRoot, 'fleet.yaml'), 'utf-8');
    expect(fleet).toMatch(/pr-reviewer/);
    expect(out.writes).toContain(out.manifestPath);
  });

  test('honours an explicit id override', async () => {
    const out = await runFleetAdd(
      { template: 'rpc-server', id: 'reviewer-2' },
      { scopeRoot: fleetRoot, templatesDir },
    );
    expect(out.agentId).toBe('reviewer-2');
    expect(existsSync(join(fleetRoot, 'agents/reviewer-2/agent.yaml'))).toBe(true);
  });

  test('rejects when the scope root has no fleet.yaml', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'declara-no-fleet-'));
    try {
      await expect(
        runFleetAdd({ template: 'rpc-server' }, { scopeRoot: empty, templatesDir }),
      ).rejects.toBeInstanceOf(BuilderValidationError);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('refuses an out-of-scope fleetRoot without confirmOutsideScope', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'declara-sibling-fleet-'));
    try {
      writeFileSync(join(sibling, 'fleet.yaml'), 'version: 1\nname: x\nagents: []\n');
      await expect(
        runFleetAdd(
          { template: 'rpc-server', fleetRoot: sibling },
          { scopeRoot: fleetRoot, templatesDir },
        ),
      ).rejects.toBeInstanceOf(BuilderScopeError);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('unknown template bubbles up as a validation error', async () => {
    await expect(
      runFleetAdd({ template: 'nope' }, { scopeRoot: fleetRoot, templatesDir }),
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });
});

describe('createFleetAddTool', () => {
  let root: string;
  let fleetRoot: string;
  let templatesDir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'declara-builder-fleet-tool-'));
    templatesDir = scaffoldTemplate(root);
    fleetRoot = await scaffoldFleet(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('tool metadata', () => {
    const tool = createFleetAddTool({ scopeRoot: fleetRoot, templatesDir });
    expect(tool.name).toBe('DeclaraFleetAdd');
    expect(tool.readonly).toBe(false);
  });

  test('permissionKey includes template + id when provided', () => {
    const tool = createFleetAddTool({ scopeRoot: fleetRoot, templatesDir });
    expect(tool.permissionKey({ template: 'rpc-server' })).toBe('.:rpc-server');
    expect(tool.permissionKey({ template: 'rpc-server', id: 'r-2' })).toBe('.:rpc-server#r-2');
  });

  test('execute yields a validation error for a missing template', async () => {
    const tool = createFleetAddTool({ scopeRoot: fleetRoot, templatesDir });
    const ctx = {
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
    const events: unknown[] = [];
    for await (const ev of tool.execute({ template: '' } as never, ctx)) {
      events.push(ev);
    }
    expect((events[0] as { type: string }).type).toBe('error');
  });
});

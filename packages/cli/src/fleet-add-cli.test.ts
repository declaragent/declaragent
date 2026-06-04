import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultTemplatesDir, fleetAdd, resolveTemplatesDir } from './fleet-add-cli.js';
import { fleetInit } from './fleet-init-cli.js';

function captureIo(): {
  io: { out: (s: string) => void; err: (s: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    out,
    err,
  };
}

interface Harness {
  root: string;
  write(relative: string, contents: string): void;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-add-cli-'));
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

function setupHarness(h: Harness): { fleetRoot: string; templatesDir: string } {
  h.write('templates/rpc-server/agent.yaml', 'name: pr-reviewer\nmodel: m\nsystemPrompt: hi\n');
  h.write(
    'templates/rpc-server/capabilities.yaml',
    `version: 1
agent: agent://pr-reviewer
transports:
  - kind: memory
    topics: { requests: agents.pr-reviewer.requests }
capabilities:
  - name: review-pr
`,
  );
  return { fleetRoot: join(h.root, 'demo'), templatesDir: join(h.root, 'templates') };
}

describe('fleetAdd', () => {
  test('adds a template-based agent to an existing fleet', async () => {
    const h = mkHarness();
    try {
      const { fleetRoot, templatesDir } = setupHarness(h);
      await fleetInit({ name: 'demo' }, { cwd: h.root, io: captureIo().io });
      const cap = captureIo();
      const code = await fleetAdd(
        { template: 'rpc-server' },
        { io: cap.io, fleetRoot, templatesDir },
      );
      expect(code).toBe(0);
      expect(existsSync(join(fleetRoot, 'agents/pr-reviewer/agent.yaml'))).toBe(true);
      expect(cap.out.join('')).toContain('added agent "pr-reviewer"');
    } finally {
      h.cleanup();
    }
  });

  test('--id applies a custom id when the template name clashes', async () => {
    const h = mkHarness();
    try {
      const { fleetRoot, templatesDir } = setupHarness(h);
      await fleetInit({ name: 'demo' }, { cwd: h.root, io: captureIo().io });

      await fleetAdd({ template: 'rpc-server' }, { io: captureIo().io, fleetRoot, templatesDir });
      const cap = captureIo();
      const code = await fleetAdd(
        { template: 'rpc-server', id: 'reviewer-2' },
        { io: cap.io, fleetRoot, templatesDir },
      );
      expect(code).toBe(0);
      expect(existsSync(join(fleetRoot, 'agents/reviewer-2/agent.yaml'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('errors when neither --template nor --path is provided', async () => {
    const h = mkHarness();
    try {
      const { fleetRoot, templatesDir } = setupHarness(h);
      await fleetInit({ name: 'demo' }, { cwd: h.root, io: captureIo().io });
      const cap = captureIo();
      const code = await fleetAdd({}, { io: cap.io, fleetRoot, templatesDir });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('requires either');
    } finally {
      h.cleanup();
    }
  });

  test('errors when both --template and --path are provided', async () => {
    const h = mkHarness();
    try {
      const { fleetRoot, templatesDir } = setupHarness(h);
      await fleetInit({ name: 'demo' }, { cwd: h.root, io: captureIo().io });
      const cap = captureIo();
      const code = await fleetAdd(
        { template: 'rpc-server', path: '/tmp/nope' },
        { io: cap.io, fleetRoot, templatesDir },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/not both/);
    } finally {
      h.cleanup();
    }
  });

  test('errors when no fleet.yaml is found', async () => {
    const h = mkHarness();
    try {
      const { templatesDir } = setupHarness(h);
      const cap = captureIo();
      const code = await fleetAdd(
        { template: 'rpc-server' },
        { io: cap.io, cwd: h.root, templatesDir },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no fleet.yaml found');
    } finally {
      h.cleanup();
    }
  });

  test('--path mode copies an external agent dir', async () => {
    const h = mkHarness();
    try {
      const { fleetRoot } = setupHarness(h);
      await fleetInit({ name: 'demo' }, { cwd: h.root, io: captureIo().io });
      h.write('external/agent.yaml', 'name: external\nmodel: m\nsystemPrompt: hi\n');
      const cap = captureIo();
      const code = await fleetAdd(
        { path: join(h.root, 'external'), id: 'onboarded' },
        { io: cap.io, fleetRoot, templatesDir: join(h.root, 'templates') },
      );
      expect(code).toBe(0);
      expect(existsSync(join(fleetRoot, 'agents/onboarded/agent.yaml'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('resolveTemplatesDir', () => {
  test('prefers the installed-package layout (<pkg>/templates)', () => {
    // Simulate the npm install layout: module runs from `<pkg>/dist`, and
    // the prepack-copied templates live at `<pkg>/templates`.
    const here = '/usr/lib/node_modules/@declaragent/cli/dist';
    const installed = '/usr/lib/node_modules/@declaragent/cli/templates';
    const isDir = (p: string) => p === installed;
    expect(resolveTemplatesDir(here, isDir)).toBe(installed);
  });

  test('falls back to the monorepo repo-root walk when no package dir exists', () => {
    // Dev layout: module runs from `packages/cli/src`, templates live at
    // the repo root `<repo>/templates` (3 levels up).
    const here = '/repo/packages/cli/src';
    const repoTemplates = '/repo/templates';
    const isDir = (p: string) => p === repoTemplates;
    expect(resolveTemplatesDir(here, isDir)).toBe(repoTemplates);
  });

  test('returns the historical guess when nothing resolves', () => {
    const here = '/repo/packages/cli/src';
    const isDir = () => false;
    // join(here, '..', '..', '..', 'templates')
    expect(resolveTemplatesDir(here, isDir)).toBe('/repo/templates');
  });

  test('defaultTemplatesDir resolves a real directory named templates', () => {
    const dir = defaultTemplatesDir();
    expect(basename(dir)).toBe('templates');
    // In the monorepo this is the live repo-root templates dir.
    expect(existsSync(dir)).toBe(true);
  });
});

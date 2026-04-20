import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fleetDemote, fleetPromote } from './fleet-promote-cli.js';

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
  write(relPath: string, contents: string): void;
  mkdir(relPath: string): void;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-promote-cli-'));
  return {
    root,
    write(relPath, contents) {
      const full = join(root, relPath);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents, 'utf-8');
    },
    mkdir(relPath) {
      mkdirSync(join(root, relPath), { recursive: true });
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Recursively walk a directory and return the set of relative file paths
 * (posix-ish, with `/` separators on mac/linux) + their contents. Used to
 * snapshot the before/after tree for the demote round-trip test.
 */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      out.set(relative(root, full), readFileSync(full, 'utf-8'));
    }
  }
  walk(root);
  return out;
}

function seedSingleAgent(h: Harness, relRoot = 'my-agent'): string {
  const base = join(h.root, relRoot);
  h.write(
    `${relRoot}/agent.yaml`,
    `name: my-agent
model: claude-sonnet
systemPrompt: "I am a single agent."
`,
  );
  h.write(
    `${relRoot}/event-sources.yaml`,
    `version: 1
sources: []
`,
  );
  h.write(`${relRoot}/skills/hello.md`, '# hello skill\n');
  h.write(`${relRoot}/.env.example`, 'ANTHROPIC_API_KEY=\n');
  h.write(`${relRoot}/README.md`, '# my-agent\n\nA single agent.\n');
  return base;
}

describe('fleetPromote dry-run', () => {
  test('prints a plan without touching disk', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      const before = snapshotTree(agentPath);
      const cap = captureIo();

      const code = await fleetPromote({ path: agentPath }, { io: cap.io });

      expect(code).toBe(0);
      const stdout = cap.out.join('');
      expect(stdout).toContain('mv');
      expect(stdout).toContain('agent.yaml');
      expect(stdout).toContain('dry-run');

      // No files were written or moved.
      const after = snapshotTree(agentPath);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      expect(existsSync(join(agentPath, 'fleet.yaml'))).toBe(false);
      expect(existsSync(join(agentPath, 'agents'))).toBe(false);
      expect(existsSync(join(agentPath, 'PROMOTED.md'))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test('dry-run mentions per-agent files and shared-root exceptions', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      const cap = captureIo();
      await fleetPromote({ path: agentPath }, { io: cap.io });
      const stdout = cap.out.join('');
      expect(stdout).toContain('event-sources.yaml');
      expect(stdout).toContain('skills/');
      expect(stdout).toContain('README.md');
      expect(stdout).toContain('.env.example (unchanged; shared across fleet)');
    } finally {
      h.cleanup();
    }
  });

  test('errors when both --dry-run and --apply are set', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      const cap = captureIo();
      const code = await fleetPromote(
        { path: agentPath, dryRun: true, apply: true },
        { io: cap.io },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/not both/);
    } finally {
      h.cleanup();
    }
  });
});

describe('fleetPromote apply', () => {
  test('produces the expected fleet-of-one tree', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      const cap = captureIo();

      const code = await fleetPromote({ path: agentPath, apply: true }, { io: cap.io });
      expect(code).toBe(0);

      expect(existsSync(join(agentPath, 'fleet.yaml'))).toBe(true);
      expect(existsSync(join(agentPath, 'PROMOTED.md'))).toBe(true);
      expect(existsSync(join(agentPath, 'package.json'))).toBe(true);

      // Per-agent files moved under agents/<id>/.
      expect(existsSync(join(agentPath, 'agents/my-agent/agent.yaml'))).toBe(true);
      expect(existsSync(join(agentPath, 'agents/my-agent/event-sources.yaml'))).toBe(true);
      expect(existsSync(join(agentPath, 'agents/my-agent/skills/hello.md'))).toBe(true);
      expect(existsSync(join(agentPath, 'agents/my-agent/README.md'))).toBe(true);

      // Originals removed from the root.
      expect(existsSync(join(agentPath, 'agent.yaml'))).toBe(false);
      expect(existsSync(join(agentPath, 'event-sources.yaml'))).toBe(false);
      expect(existsSync(join(agentPath, 'skills'))).toBe(false);
      expect(existsSync(join(agentPath, 'README.md'))).toBe(false);

      // Shared-root files left alone.
      expect(existsSync(join(agentPath, '.env.example'))).toBe(true);

      // fleet.yaml references the new agent id + path.
      const manifest = parseYaml(readFileSync(join(agentPath, 'fleet.yaml'), 'utf-8'));
      expect(manifest.version).toBe(1);
      expect(manifest.name).toBe('my-agent');
      expect(manifest.agents).toEqual([{ id: 'my-agent', path: './agents/my-agent' }]);

      // Root package.json gets workspaces.
      const pkg = JSON.parse(readFileSync(join(agentPath, 'package.json'), 'utf-8'));
      expect(pkg.workspaces).toEqual(['agents/*']);
    } finally {
      h.cleanup();
    }
  });

  test('apply prints a success banner with the next-steps hint', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      const cap = captureIo();
      const code = await fleetPromote({ path: agentPath, apply: true }, { io: cap.io });
      expect(code).toBe(0);
      const stdout = cap.out.join('');
      expect(stdout).toContain('✓ promoted');
      expect(stdout).toContain('fleet validate');
      expect(stdout).toContain('fleet run');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleetPromote refusals', () => {
  test('refuses when source is already a fleet (has fleet.yaml)', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      h.write('my-agent/fleet.yaml', 'version: 1\nname: already-fleet\nagents: []\n');
      const cap = captureIo();
      const code = await fleetPromote({ path: agentPath, apply: true }, { io: cap.io });
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/already contains fleet\.yaml/);
    } finally {
      h.cleanup();
    }
  });

  test('refuses when source has no agent.yaml', async () => {
    const h = mkHarness();
    try {
      h.mkdir('empty-dir');
      h.write('empty-dir/README.md', '# empty\n');
      const cap = captureIo();
      const code = await fleetPromote(
        { path: join(h.root, 'empty-dir'), apply: true },
        { io: cap.io },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/no agent\.yaml/);
    } finally {
      h.cleanup();
    }
  });

  test('refuses when source path does not exist', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetPromote(
        { path: join(h.root, 'does-not-exist'), apply: true },
        { io: cap.io },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/does not exist/);
    } finally {
      h.cleanup();
    }
  });

  test('refuses a malformed agent id', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      const cap = captureIo();
      const code = await fleetPromote(
        { path: agentPath, apply: true, id: 'Not A Valid Id!' },
        { io: cap.io },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/URL-safe identifier/);
    } finally {
      h.cleanup();
    }
  });
});

describe('fleetPromote id override', () => {
  test('custom --id rewrites agent.yaml.name', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      const cap = captureIo();
      const code = await fleetPromote(
        { path: agentPath, apply: true, id: 'renamed' },
        { io: cap.io },
      );
      expect(code).toBe(0);

      expect(existsSync(join(agentPath, 'agents/renamed/agent.yaml'))).toBe(true);
      const movedYaml = readFileSync(join(agentPath, 'agents/renamed/agent.yaml'), 'utf-8');
      expect(movedYaml).toMatch(/^name: renamed$/m);

      const manifest = parseYaml(readFileSync(join(agentPath, 'fleet.yaml'), 'utf-8'));
      expect(manifest.agents).toEqual([{ id: 'renamed', path: './agents/renamed' }]);
    } finally {
      h.cleanup();
    }
  });

  test('custom --id rewrites capabilities.yaml.agent when present', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      h.write(
        'my-agent/capabilities.yaml',
        `version: 1
agent: agent://my-agent
transports:
  - kind: memory
    topics: { requests: agents.my-agent.requests }
capabilities:
  - name: do-thing
`,
      );
      const cap = captureIo();
      const code = await fleetPromote(
        { path: agentPath, apply: true, id: 'worker' },
        { io: cap.io },
      );
      expect(code).toBe(0);
      const caps = readFileSync(join(agentPath, 'agents/worker/capabilities.yaml'), 'utf-8');
      expect(caps).toMatch(/^agent: agent:\/\/worker$/m);
    } finally {
      h.cleanup();
    }
  });
});

describe('fleetPromote package.json handling', () => {
  test('rewrites existing package.json (adds workspaces, preserves name + deps)', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      h.write(
        'my-agent/package.json',
        `${JSON.stringify(
          {
            name: 'pre-existing-name',
            private: true,
            type: 'module',
            dependencies: { '@declaragent/core': '^1.2.0' },
            scripts: { test: 'bun test' },
          },
          null,
          2,
        )}\n`,
      );

      const cap = captureIo();
      const code = await fleetPromote({ path: agentPath, apply: true }, { io: cap.io });
      expect(code).toBe(0);

      const pkg = JSON.parse(readFileSync(join(agentPath, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('pre-existing-name');
      expect(pkg.workspaces).toEqual(['agents/*']);
      expect(pkg.dependencies).toEqual({ '@declaragent/core': '^1.2.0' });
      expect(pkg.scripts).toEqual({ test: 'bun test' });
    } finally {
      h.cleanup();
    }
  });

  test('creates a minimal package.json when none exists', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      // No package.json in the seeded single agent.
      expect(existsSync(join(agentPath, 'package.json'))).toBe(false);

      const cap = captureIo();
      const code = await fleetPromote({ path: agentPath, apply: true }, { io: cap.io });
      expect(code).toBe(0);

      const pkg = JSON.parse(readFileSync(join(agentPath, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe('my-agent');
      expect(pkg.private).toBe(true);
      expect(pkg.workspaces).toEqual(['agents/*']);
    } finally {
      h.cleanup();
    }
  });
});

describe('fleetPromote warnings', () => {
  test('surfaces Dockerfile + deploy YAML + workflow warnings without rewriting them', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      h.write('my-agent/Dockerfile', 'FROM node:20\n');
      h.write('my-agent/deploy.yaml', 'target: cloud-run\n');
      h.write('my-agent/.github/workflows/ci.yml', 'on: push\n');

      const cap = captureIo();
      const code = await fleetPromote({ path: agentPath, apply: true }, { io: cap.io });
      expect(code).toBe(0);

      const stdout = cap.out.join('');
      expect(stdout).toMatch(/Dockerfile.*not rewritten/);
      expect(stdout).toMatch(/deploy\.yaml.*not rewritten/);
      expect(stdout).toMatch(/ci\.yml.*not rewritten/);

      // The files are still at their original paths (not moved, not rewritten).
      expect(readFileSync(join(agentPath, 'Dockerfile'), 'utf-8')).toBe('FROM node:20\n');
      expect(readFileSync(join(agentPath, 'deploy.yaml'), 'utf-8')).toBe('target: cloud-run\n');
      expect(readFileSync(join(agentPath, '.github/workflows/ci.yml'), 'utf-8')).toBe('on: push\n');
    } finally {
      h.cleanup();
    }
  });
});

describe('fleetDemote', () => {
  test('reverses promote cleanly (fleet-of-one → single agent)', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      // Include a package.json so the round-trip exercises the full path.
      h.write(
        'my-agent/package.json',
        `${JSON.stringify(
          { name: 'my-agent', private: true, type: 'module', dependencies: {} },
          null,
          2,
        )}\n`,
      );

      const before = snapshotTree(agentPath);

      const p1 = captureIo();
      expect(await fleetPromote({ path: agentPath, apply: true }, { io: p1.io })).toBe(0);

      const p2 = captureIo();
      expect(await fleetDemote({}, { io: p2.io, fleetRoot: agentPath })).toBe(0);

      const after = snapshotTree(agentPath);

      // PROMOTED.md is OK if dangling — but we explicitly delete it on
      // demote, so the post-demote tree should match pre-promote 1-to-1.
      expect(existsSync(join(agentPath, 'PROMOTED.md'))).toBe(false);
      expect(existsSync(join(agentPath, 'fleet.yaml'))).toBe(false);
      expect(existsSync(join(agentPath, 'agents'))).toBe(false);

      // Per-agent files restored at the fleet root.
      expect(existsSync(join(agentPath, 'agent.yaml'))).toBe(true);
      expect(existsSync(join(agentPath, 'event-sources.yaml'))).toBe(true);
      expect(existsSync(join(agentPath, 'skills/hello.md'))).toBe(true);
      expect(existsSync(join(agentPath, 'README.md'))).toBe(true);

      // File set equivalence (ignoring PROMOTED.md — we already asserted
      // it's gone).
      const beforeKeys = [...before.keys()].filter((k) => k !== 'PROMOTED.md').sort();
      const afterKeys = [...after.keys()].filter((k) => k !== 'PROMOTED.md').sort();
      expect(afterKeys).toEqual(beforeKeys);

      // Agent-file contents preserved byte-for-byte.
      expect(after.get('agent.yaml')).toBe(before.get('agent.yaml'));
      expect(after.get('event-sources.yaml')).toBe(before.get('event-sources.yaml'));
      expect(after.get('skills/hello.md')).toBe(before.get('skills/hello.md'));
      expect(after.get('README.md')).toBe(before.get('README.md'));

      // package.json no longer declares workspaces.
      const pkg = JSON.parse(readFileSync(join(agentPath, 'package.json'), 'utf-8'));
      expect(Object.hasOwn(pkg, 'workspaces')).toBe(false);
      expect(pkg.name).toBe('my-agent');
    } finally {
      h.cleanup();
    }
  });

  test('refuses when fleet has more than 1 agent', async () => {
    const h = mkHarness();
    try {
      const fleetRoot = join(h.root, 'multi');
      h.write(
        'multi/fleet.yaml',
        `version: 1
name: multi
agents:
  - id: a
    path: ./agents/a
  - id: b
    path: ./agents/b
`,
      );
      h.write('multi/agents/a/agent.yaml', 'name: a\nmodel: m\nsystemPrompt: x\n');
      h.write('multi/agents/b/agent.yaml', 'name: b\nmodel: m\nsystemPrompt: x\n');

      const cap = captureIo();
      const code = await fleetDemote({}, { io: cap.io, fleetRoot });
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/only supports fleet-of-one/);
      // Fleet state untouched.
      expect(existsSync(join(fleetRoot, 'fleet.yaml'))).toBe(true);
      expect(existsSync(join(fleetRoot, 'agents/a/agent.yaml'))).toBe(true);
      expect(existsSync(join(fleetRoot, 'agents/b/agent.yaml'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('refuses when --id does not match the sole fleet member', async () => {
    const h = mkHarness();
    try {
      const agentPath = seedSingleAgent(h);
      await fleetPromote({ path: agentPath, apply: true }, { io: captureIo().io });

      const cap = captureIo();
      const code = await fleetDemote({ id: 'wrong-id' }, { io: cap.io, fleetRoot: agentPath });
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/does not match the sole fleet member/);
    } finally {
      h.cleanup();
    }
  });

  test('errors when no fleet.yaml is found (no fleetRoot, no cwd match)', async () => {
    const h = mkHarness();
    try {
      const cap = captureIo();
      const code = await fleetDemote({}, { io: cap.io, cwd: h.root });
      expect(code).toBe(1);
      expect(cap.err.join('')).toMatch(/no fleet\.yaml found/);
    } finally {
      h.cleanup();
    }
  });
});

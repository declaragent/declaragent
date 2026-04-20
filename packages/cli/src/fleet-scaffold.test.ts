import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  FleetScaffoldError,
  addAgentFromPath,
  addAgentFromTemplate,
  scaffoldFleet,
} from './fleet-scaffold.js';

interface Harness {
  root: string;
  write(relative: string, contents: string): void;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-scaffold-'));
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

function read(p: string): string {
  return readFileSync(p, 'utf-8');
}

describe('scaffoldFleet', () => {
  test('writes a minimal fleet tree', () => {
    const h = mkHarness();
    try {
      const fleetRoot = join(h.root, 'my-fleet');
      const result = scaffoldFleet({ root: fleetRoot, name: 'my-fleet' });
      const relPaths = result.written.map((p) => p.slice(fleetRoot.length + 1));
      expect(relPaths).toContain('fleet.yaml');
      expect(relPaths).toContain('package.json');
      expect(relPaths).toContain('.gitignore');
      expect(relPaths).toContain('.env.example');
      expect(relPaths).toContain('rpc-peers.yaml');
      expect(relPaths).toContain('README.md');

      const manifest = parseYaml(read(join(fleetRoot, 'fleet.yaml')));
      expect(manifest.name).toBe('my-fleet');
      expect(manifest.agents).toEqual([]);

      const pkg = JSON.parse(read(join(fleetRoot, 'package.json')));
      expect(pkg.name).toBe('my-fleet');
      expect(pkg.workspaces).toEqual(['agents/*']);
      expect(pkg.dependencies['@declaragent/core']).toMatch(/^\^/);
    } finally {
      h.cleanup();
    }
  });

  test('refuses to overwrite an existing fleet.yaml without --force', () => {
    const h = mkHarness();
    try {
      h.write('my-fleet/fleet.yaml', '# pre-existing\n');
      expect(() => scaffoldFleet({ root: join(h.root, 'my-fleet'), name: 'my-fleet' })).toThrow(
        FleetScaffoldError,
      );
      expect(read(join(h.root, 'my-fleet/fleet.yaml'))).toBe('# pre-existing\n');
    } finally {
      h.cleanup();
    }
  });

  test('--force overwrites existing files', () => {
    const h = mkHarness();
    try {
      h.write('my-fleet/fleet.yaml', '# pre-existing\n');
      const result = scaffoldFleet({
        root: join(h.root, 'my-fleet'),
        name: 'my-fleet',
        force: true,
      });
      expect(result.written.some((p) => p.endsWith('fleet.yaml'))).toBe(true);
      expect(read(join(h.root, 'my-fleet/fleet.yaml'))).not.toBe('# pre-existing\n');
    } finally {
      h.cleanup();
    }
  });

  test('rejects non-absolute roots', () => {
    expect(() => scaffoldFleet({ root: 'relative/path', name: 'n' })).toThrow(FleetScaffoldError);
  });

  test('rejects invalid fleet names', () => {
    const h = mkHarness();
    try {
      expect(() => scaffoldFleet({ root: join(h.root, 'bad'), name: '-nope' })).toThrow(
        FleetScaffoldError,
      );
    } finally {
      h.cleanup();
    }
  });
});

// ── addAgentFromTemplate ───────────────────────────────────────────────

function mkTemplatesFixture(): Harness {
  const h = mkHarness();
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
  h.write('templates/rpc-server/skills/review-pr.md', '# review-pr\n');
  h.write('templates/rpc-client/agent.yaml', 'name: concierge\nmodel: m\nsystemPrompt: hi\n');
  return h;
}

function scaffold(h: Harness, name = 'fleet'): string {
  const root = join(h.root, name);
  scaffoldFleet({ root, name });
  return root;
}

describe('addAgentFromTemplate', () => {
  test('copies the template tree + rewrites name + updates manifest', () => {
    const h = mkTemplatesFixture();
    try {
      const fleetRoot = scaffold(h);
      const result = addAgentFromTemplate({
        fleetRoot,
        template: 'rpc-server',
        templatesDir: join(h.root, 'templates'),
      });
      expect(result.agentId).toBe('pr-reviewer');
      expect(result.agentPath).toBe(join(fleetRoot, 'agents', 'pr-reviewer'));

      // The agent.yaml should be copied verbatim (name matches).
      const copied = read(join(result.agentPath, 'agent.yaml'));
      expect(copied).toContain('name: pr-reviewer');

      // capabilities.yaml should be preserved too.
      const caps = read(join(result.agentPath, 'capabilities.yaml'));
      expect(caps).toContain('agent: agent://pr-reviewer');

      // skills subdir should have been walked.
      expect(read(join(result.agentPath, 'skills/review-pr.md'))).toContain('review-pr');

      // fleet.yaml should now list the agent.
      const manifest = parseYaml(read(join(fleetRoot, 'fleet.yaml')));
      expect(manifest.agents).toHaveLength(1);
      expect(manifest.agents[0].id).toBe('pr-reviewer');
      expect(manifest.agents[0].path).toBe('./agents/pr-reviewer');
    } finally {
      h.cleanup();
    }
  });

  test('--id override rewrites agent.yaml `name:` + capabilities agent:', () => {
    const h = mkTemplatesFixture();
    try {
      const fleetRoot = scaffold(h);
      const result = addAgentFromTemplate({
        fleetRoot,
        template: 'rpc-server',
        templatesDir: join(h.root, 'templates'),
        id: 'custom-reviewer',
      });
      expect(result.agentId).toBe('custom-reviewer');
      expect(read(join(result.agentPath, 'agent.yaml'))).toContain('name: custom-reviewer');
      expect(read(join(result.agentPath, 'capabilities.yaml'))).toContain(
        'agent: agent://custom-reviewer',
      );
      const manifest = parseYaml(read(join(fleetRoot, 'fleet.yaml')));
      expect(manifest.agents[0].id).toBe('custom-reviewer');
    } finally {
      h.cleanup();
    }
  });

  test('refuses duplicate agent id', () => {
    const h = mkTemplatesFixture();
    try {
      const fleetRoot = scaffold(h);
      addAgentFromTemplate({
        fleetRoot,
        template: 'rpc-server',
        templatesDir: join(h.root, 'templates'),
        id: 'one',
      });
      expect(() =>
        addAgentFromTemplate({
          fleetRoot,
          template: 'rpc-server',
          templatesDir: join(h.root, 'templates'),
          id: 'one',
        }),
      ).toThrow(/already has an agent with id/);
    } finally {
      h.cleanup();
    }
  });

  test('refuses a target dir that already exists (no --force)', () => {
    const h = mkTemplatesFixture();
    try {
      const fleetRoot = scaffold(h);
      // Pre-create the target.
      h.write(`${fleetRoot.slice(h.root.length + 1)}/agents/pr-reviewer/pre.md`, '# pre\n');
      expect(() =>
        addAgentFromTemplate({
          fleetRoot,
          template: 'rpc-server',
          templatesDir: join(h.root, 'templates'),
        }),
      ).toThrow(/refusing to overwrite/);
    } finally {
      h.cleanup();
    }
  });

  test('errors when template does not exist', () => {
    const h = mkTemplatesFixture();
    try {
      const fleetRoot = scaffold(h);
      expect(() =>
        addAgentFromTemplate({
          fleetRoot,
          template: 'nope',
          templatesDir: join(h.root, 'templates'),
        }),
      ).toThrow(/not found/);
    } finally {
      h.cleanup();
    }
  });

  test('errors when fleet.yaml is missing', () => {
    const h = mkTemplatesFixture();
    try {
      expect(() =>
        addAgentFromTemplate({
          fleetRoot: join(h.root, 'no-such-fleet'),
          template: 'rpc-server',
          templatesDir: join(h.root, 'templates'),
        }),
      ).toThrow(/no fleet.yaml/);
    } finally {
      h.cleanup();
    }
  });

  test('second add appends a second agent without clobbering the first', () => {
    const h = mkTemplatesFixture();
    try {
      const fleetRoot = scaffold(h);
      addAgentFromTemplate({
        fleetRoot,
        template: 'rpc-server',
        templatesDir: join(h.root, 'templates'),
      });
      addAgentFromTemplate({
        fleetRoot,
        template: 'rpc-client',
        templatesDir: join(h.root, 'templates'),
      });
      const manifest = parseYaml(read(join(fleetRoot, 'fleet.yaml')));
      const ids = manifest.agents.map((a: { id: string }) => a.id);
      expect(ids).toContain('pr-reviewer');
      expect(ids).toContain('concierge');
    } finally {
      h.cleanup();
    }
  });
});

describe('addAgentFromPath', () => {
  test('copies an external agent dir + rewrites id', () => {
    const h = mkHarness();
    try {
      const fleetRoot = scaffold(h);
      // Create an external single-agent directory.
      h.write('external/agent.yaml', 'name: external-agent\nmodel: m\nsystemPrompt: hi\n');
      h.write('external/skills/hello.md', '# hello\n');

      const result = addAgentFromPath({
        fleetRoot,
        sourceDir: join(h.root, 'external'),
        id: 'onboarded',
      });
      expect(result.agentId).toBe('onboarded');
      expect(read(join(result.agentPath, 'agent.yaml'))).toContain('name: onboarded');
      expect(read(join(result.agentPath, 'skills/hello.md'))).toContain('hello');
      const manifest = parseYaml(read(join(fleetRoot, 'fleet.yaml')));
      expect(manifest.agents[0].id).toBe('onboarded');
    } finally {
      h.cleanup();
    }
  });

  test('errors when sourceDir is missing agent.yaml', () => {
    const h = mkHarness();
    try {
      const fleetRoot = scaffold(h);
      h.write('external/README.md', '# not an agent\n');
      expect(() =>
        addAgentFromPath({
          fleetRoot,
          sourceDir: join(h.root, 'external'),
          id: 'x',
        }),
      ).toThrow(/no agent.yaml/);
    } finally {
      h.cleanup();
    }
  });
});

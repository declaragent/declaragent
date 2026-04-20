import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFleetRoot, loadFleet } from './manifest-loader.js';
import { FleetManifestError } from './manifest-schema.js';
import { FleetConfigError } from './types.js';

interface Harness {
  root: string;
  /** Write a file relative to the root, creating parents. */
  write(relative: string, contents: string): string;
  cleanup(): void;
}

function mkHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-'));
  return {
    root,
    write(relative, contents) {
      const full = join(root, relative);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents, 'utf-8');
      return full;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function baseManifest(agents: string): string {
  return `version: 1
name: test-fleet
agents:
${agents}`;
}

describe('findFleetRoot', () => {
  test('returns the directory containing fleet.yaml', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', baseManifest('  - id: a\n    path: ./agents/a\n'));
      h.write('agents/a/agent.yaml', 'name: a\n');
      const found = await findFleetRoot(h.root);
      expect(found).toBe(h.root);
    } finally {
      h.cleanup();
    }
  });

  test('walks up from a nested subdirectory', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', baseManifest('  - id: a\n    path: ./agents/a\n'));
      h.write('agents/a/agent.yaml', 'name: a\n');
      h.write('agents/a/skills/greet.md', '# greet\n');
      const found = await findFleetRoot(join(h.root, 'agents/a/skills'));
      expect(found).toBe(h.root);
    } finally {
      h.cleanup();
    }
  });

  test('returns undefined when no fleet.yaml is anywhere', async () => {
    const h = mkHarness();
    try {
      // A standalone tmpdir with no fleet.yaml up the chain — walk hits
      // the filesystem root. The temp dir is always inside os.tmpdir(),
      // which in CI doesn't contain a fleet.yaml.
      const found = await findFleetRoot(h.root);
      expect(found).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe('loadFleet', () => {
  test('loads a minimal one-agent fleet', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', baseManifest('  - id: a\n    path: ./agents/a\n'));
      h.write('agents/a/agent.yaml', 'name: a\nmodel: test\nsystemPrompt: hi\n');
      const fleet = await loadFleet({ root: h.root });
      expect(fleet.manifest.name).toBe('test-fleet');
      expect(fleet.agents).toHaveLength(1);
      const a = fleet.agents[0];
      if (!a) throw new Error('expected one agent');
      expect(a.id).toBe('a');
      expect(a.name).toBe('a');
      expect(a.path).toBe(join(h.root, 'agents/a'));
      expect(a.agentYamlPath).toBe(join(h.root, 'agents/a/agent.yaml'));
      expect(a.env).toBe('default');
      expect(fleet.environments.has('default')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('rejects non-absolute root', async () => {
    await expect(loadFleet({ root: 'relative/path' })).rejects.toThrow(FleetConfigError);
  });

  test('errors when fleet.yaml is missing', async () => {
    const h = mkHarness();
    try {
      await expect(loadFleet({ root: h.root })).rejects.toThrow(FleetManifestError);
    } finally {
      h.cleanup();
    }
  });

  test('errors when agent.yaml name mismatches the manifest id', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', baseManifest('  - id: pr-reviewer\n    path: ./agents/pr-reviewer\n'));
      h.write('agents/pr-reviewer/agent.yaml', 'name: pr-viewer\n');
      await expect(loadFleet({ root: h.root })).rejects.toThrow(/agent id mismatch/);
    } finally {
      h.cleanup();
    }
  });

  test('errors when agent path does not exist', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', baseManifest('  - id: a\n    path: ./agents/missing\n'));
      await expect(loadFleet({ root: h.root })).rejects.toThrow(/path does not exist/);
    } finally {
      h.cleanup();
    }
  });

  test('errors on duplicate agent ids', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        baseManifest('  - id: a\n    path: ./agents/a\n  - id: a\n    path: ./agents/a\n'),
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      await expect(loadFleet({ root: h.root })).rejects.toThrow(/duplicate agent id/);
    } finally {
      h.cleanup();
    }
  });

  test('errors when deploy.target does not resolve', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
    deploy:
      target: gone
deploy:
  targets:
    cloud-run:
      kind: gcp-cloud-run
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      await expect(loadFleet({ root: h.root })).rejects.toThrow(/not declared in deploy.targets/);
    } finally {
      h.cleanup();
    }
  });

  test('flattens environment inherit chains', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
    env: staging
environments:
  shared:
    peersRef: ./rpc-peers.yaml
    envFiles:
      - ./.env
  staging:
    inherit: shared
    tenantsRef: ./tenants.staging.yaml
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      h.write(
        'rpc-peers.yaml',
        `version: 1
peers:
  - agent: agent://external
    transports:
      - kind: memory
        topics: { requests: x }
`,
      );
      const fleet = await loadFleet({ root: h.root });
      const staging = fleet.environments.get('staging');
      expect(staging).toBeDefined();
      expect(staging?.inheritChain).toEqual(['shared', 'staging']);
      expect(staging?.peersRef).toBe(join(h.root, 'rpc-peers.yaml'));
      expect(staging?.tenantsRef).toBe(join(h.root, 'tenants.staging.yaml'));
      expect(staging?.envFiles).toEqual([join(h.root, '.env')]);
      expect(fleet.peers?.byAgent.has('agent://external')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test('detects environment inherit cycles', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
    env: x
environments:
  x: { inherit: y }
  y: { inherit: x }
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      await expect(loadFleet({ root: h.root })).rejects.toThrow(/circular inherit/);
    } finally {
      h.cleanup();
    }
  });

  test('merges per-agent overrides into inheriting environments', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
    env: staging
environments:
  shared:
    overrides:
      a: { secretScopes: ["vault:kv/a"] }
  staging:
    inherit: shared
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      const fleet = await loadFleet({ root: h.root });
      const staging = fleet.environments.get('staging');
      expect(staging?.overrides.get('a')?.secretScopes).toEqual(['vault:kv/a']);
    } finally {
      h.cleanup();
    }
  });

  test('child environment overrides replace parent overrides wholesale (per-agent-id granularity)', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
    env: staging
environments:
  shared:
    overrides:
      a: { secretScopes: ["vault:kv/a"] }
  staging:
    inherit: shared
    overrides:
      a: { secretScopes: ["vault:kv/a-staging"] }
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      const fleet = await loadFleet({ root: h.root });
      const staging = fleet.environments.get('staging');
      expect(staging?.overrides.get('a')?.secretScopes).toEqual(['vault:kv/a-staging']);
    } finally {
      h.cleanup();
    }
  });

  test('errors when an agent references an unknown environment', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
    env: ghost
environments:
  shared: {}
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      await expect(loadFleet({ root: h.root })).rejects.toThrow(
        /unknown environment "ghost"|not declared/,
      );
    } finally {
      h.cleanup();
    }
  });

  test('loads per-agent capabilities.yaml when present', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', baseManifest('  - id: pr\n    path: ./agents/pr\n'));
      h.write('agents/pr/agent.yaml', 'name: pr\n');
      h.write(
        'agents/pr/capabilities.yaml',
        `version: 1
agent: agent://pr
transports:
  - kind: memory
    topics: { requests: agents.pr.requests }
capabilities:
  - name: review-pr
    timeoutMs: 60000
    idempotent: true
`,
      );
      const fleet = await loadFleet({ root: h.root });
      const pr = fleet.agentsById.get('pr');
      expect(pr?.capabilities?.byName.get('review-pr')?.timeoutMs).toBe(60000);
    } finally {
      h.cleanup();
    }
  });

  test('rejects a capabilities.yaml whose agent URL mismatches the id', async () => {
    const h = mkHarness();
    try {
      h.write('fleet.yaml', baseManifest('  - id: pr\n    path: ./agents/pr\n'));
      h.write('agents/pr/agent.yaml', 'name: pr\n');
      h.write(
        'agents/pr/capabilities.yaml',
        `version: 1
agent: agent://other
transports:
  - kind: memory
    topics: { requests: x }
capabilities:
  - name: review-pr
`,
      );
      await expect(loadFleet({ root: h.root })).rejects.toThrow(
        /capabilities\.yaml declares agent/,
      );
    } finally {
      h.cleanup();
    }
  });

  test('skipCapabilities + skipPeers bypass those sub-loads', async () => {
    const h = mkHarness();
    try {
      h.write(
        'fleet.yaml',
        `version: 1
name: t
agents:
  - id: a
    path: ./agents/a
    env: shared
environments:
  shared:
    peersRef: ./no-such-peers.yaml
`,
      );
      h.write('agents/a/agent.yaml', 'name: a\n');
      // Passing skipPeers true should bypass the (missing) peers file.
      const fleet = await loadFleet({ root: h.root, skipPeers: true, skipCapabilities: true });
      expect(fleet.peers).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

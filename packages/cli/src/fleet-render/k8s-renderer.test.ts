/**
 * Tests for the k8s renderer.
 *
 * Three flavors:
 *   1. Golden-file — render fleet-starter, compare byte-for-byte with
 *      `__snapshots__/fleet-starter-k8s/*`. Catches unintended drift.
 *   2. Determinism — render twice, assert the two outputs are identical
 *      as a sanity check that no timestamps / random / insertion-order
 *      bugs crept in.
 *   3. YAML + schema validity — parse each emitted doc through the
 *      `yaml` library, assert the expected `kind`s appear, and assert
 *      selector invariants (Deployment.spec.selector.matchLabels ⊆
 *      Deployment.spec.template.metadata.labels).
 *
 * §3 #9 Acceptance 1 (kubectl dry-run validation) runs in CI via the
 * `bun run test:k8s-dryrun` script (docs-site/docs/reference/fleet.mdx
 * explains the degradation when kubectl isn't available).
 */

import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { findFleetRoot, loadFleet } from '@declaragent/core';
import { parse as parseYaml } from 'yaml';
import { renderK8s } from './k8s-renderer.js';
import type { RenderedFile } from './types.js';

const FLEET_STARTER = join(__dirname, '..', '..', '..', '..', 'templates', 'fleet-starter');
const SNAPSHOT_DIR = join(__dirname, '__snapshots__', 'fleet-starter-k8s');

async function loadStarter() {
  const root = await findFleetRoot(FLEET_STARTER);
  if (!root) throw new Error(`fleet-starter not found under ${FLEET_STARTER}`);
  return loadFleet({ root, skipPeers: true });
}

async function readSnapshot(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const rel = relative(SNAPSHOT_DIR, full);
        out.set(rel.replace(/\\/g, '/'), await readFile(full, 'utf-8'));
      }
    }
  }
  await walk(SNAPSHOT_DIR);
  return out;
}

describe('k8s-renderer golden files', () => {
  test('fleet-starter matches checked-in snapshot', async () => {
    const fleet = await loadStarter();
    const files = await renderK8s(fleet);
    const snapshot = await readSnapshot();

    const rendered = new Map(files.map((f) => [f.path, f.contents]));
    // Every rendered file must exist verbatim in the snapshot.
    for (const [path, contents] of rendered) {
      const expected = snapshot.get(path);
      expect(expected, `missing snapshot for ${path}`).toBeDefined();
      expect(contents).toBe(expected as string);
    }
    // And no extra snapshot files beyond what we emit.
    for (const path of snapshot.keys()) {
      expect(rendered.has(path), `snapshot ${path} has no rendered counterpart`).toBe(true);
    }
  });
});

describe('k8s-renderer determinism', () => {
  test('two renders of the same fleet are byte-identical', async () => {
    const fleet = await loadStarter();
    const a = await renderK8s(fleet);
    const b = await renderK8s(fleet);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]?.path).toBe(b[i]?.path ?? '');
      expect(a[i]?.contents).toBe(b[i]?.contents ?? '');
    }
  });

  test('file list is lexically sorted', async () => {
    const fleet = await loadStarter();
    const files = await renderK8s(fleet);
    const sorted = [...files].sort((x, y) => x.path.localeCompare(y.path));
    expect(files.map((f) => f.path)).toEqual(sorted.map((f) => f.path));
  });
});

describe('k8s-renderer YAML validity', () => {
  function parseAllDocs(contents: string): unknown[] {
    // Renderer joins docs with `---\n`. yaml's parseAllDocuments would
    // work but we only need the simple split for tests.
    return contents
      .split(/^---\n/m)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseYaml(s));
  }

  test('every file parses as YAML', async () => {
    const fleet = await loadStarter();
    const files = await renderK8s(fleet);
    for (const f of files) {
      const docs = parseAllDocs(f.contents);
      expect(docs.length, `no YAML docs in ${f.path}`).toBeGreaterThan(0);
      for (const d of docs) {
        expect(d, `null YAML doc in ${f.path}`).toBeDefined();
      }
    }
  });

  test('namespace doc has kind=Namespace', async () => {
    const fleet = await loadStarter();
    const files = await renderK8s(fleet);
    const ns = files.find((f) => f.path === '00-namespace.yaml');
    expect(ns).toBeDefined();
    const doc = parseYaml(ns?.contents ?? '') as { kind?: string };
    expect(doc.kind).toBe('Namespace');
  });

  test('per-agent workload file contains ConfigMap, Deployment, Service', async () => {
    // ServiceMonitor lives in its own file now — see below (#31, 0.7.3).
    const fleet = await loadStarter();
    const files = await renderK8s(fleet);
    for (const agent of fleet.agents) {
      const f = files.find((x) => x.path === `agents/${agent.id}.yaml`);
      expect(f, `no rendered file for agent ${agent.id}`).toBeDefined();
      const docs = parseAllDocs(f?.contents ?? '');
      const kinds = docs.map((d) => (d as { kind?: string }).kind);
      expect(kinds).toEqual(['ConfigMap', 'Deployment', 'Service']);
    }
  });

  test('ServiceMonitor splits into its own file (#31) — default-on', async () => {
    const fleet = await loadStarter();
    const files = await renderK8s(fleet);
    for (const agent of fleet.agents) {
      const sm = files.find((x) => x.path === `agents/${agent.id}-servicemonitor.yaml`);
      expect(sm, `no ServiceMonitor file for agent ${agent.id}`).toBeDefined();
      const docs = parseAllDocs(sm?.contents ?? '');
      expect(docs.length).toBe(1);
      expect((docs[0] as { kind?: string }).kind).toBe('ServiceMonitor');
    }
  });

  test('Deployment selector.matchLabels is subset of template.metadata.labels', async () => {
    const fleet = await loadStarter();
    const files = await renderK8s(fleet);
    for (const agent of fleet.agents) {
      const f = files.find((x) => x.path === `agents/${agent.id}.yaml`);
      const docs = parseAllDocs(f?.contents ?? '');
      const dep = docs.find((d) => (d as { kind?: string }).kind === 'Deployment') as {
        spec: {
          selector: { matchLabels: Record<string, string> };
          template: { metadata: { labels: Record<string, string> } };
        };
      };
      expect(dep).toBeDefined();
      for (const [k, v] of Object.entries(dep.spec.selector.matchLabels)) {
        expect(dep.spec.template.metadata.labels[k]).toBe(v);
      }
    }
  });

  test('ServiceMonitor is omitted entirely when serviceMonitor=false', async () => {
    const fleet = await loadStarter();
    const files = await renderK8s(fleet, { serviceMonitor: false });
    for (const agent of fleet.agents) {
      const f = files.find((x) => x.path === `agents/${agent.id}.yaml`);
      const docs = parseAllDocs(f?.contents ?? '');
      const kinds = docs.map((d) => (d as { kind?: string }).kind);
      expect(kinds).toEqual(['ConfigMap', 'Deployment', 'Service']);
      // No separate ServiceMonitor file either.
      const sm = files.find((x) => x.path === `agents/${agent.id}-servicemonitor.yaml`);
      expect(sm, `ServiceMonitor file should not exist for ${agent.id}`).toBeUndefined();
    }
  });
});

describe('k8s-renderer secret handling', () => {
  test('Secret emits only keys when agent.yaml uses ${secret:…}', () => {
    // Build a synthetic fleet with a single agent that has a secret
    // ref. We don't need loadFleet's full surface — the pure renderer
    // accepts `AgentSource[]` directly.
    const fakeFleet = {
      manifest: { name: 'demo', version: 1, agents: [] },
      root: '/tmp/fake',
      manifestPath: '/tmp/fake/fleet.yaml',
      agents: [
        {
          id: 'alpha',
          path: '/tmp/fake/agents/alpha',
          agentYamlPath: '/tmp/fake/agents/alpha/agent.yaml',
          name: 'alpha',
          entry: { id: 'alpha', path: './agents/alpha' },
          env: 'default',
        },
      ],
      agentsById: new Map(),
      environments: new Map(),
    } as unknown as Parameters<typeof import('./k8s-renderer.js').renderK8sFromSources>[0];

    const sources = [
      {
        agent: fakeFleet.agents[0] as never,
        agentYaml: [
          'name: alpha',
          'model: claude-haiku-4-5',
          'channels:',
          '  slack:',
          '    token: ${secret:slack/bot_token}',
          '  github:',
          '    token: ${secret:github/repo_pat}',
        ].join('\n'),
      },
    ];

    const { renderK8sFromSources } = require('./k8s-renderer.js');
    const files: RenderedFile[] = renderK8sFromSources(fakeFleet, sources);
    const secretFile = files.find((f) => f.path === '10-secrets.yaml');
    expect(secretFile).toBeDefined();
    const contents = secretFile?.contents ?? '';
    // Keys present, values empty strings only.
    expect(contents).toContain('SLACK_BOT_TOKEN');
    expect(contents).toContain('GITHUB_REPO_PAT');
    // A literal secret value must NEVER appear — we sanity-check by
    // looking for any non-empty quoted value on a stringData line.
    const doc = parseYaml(contents) as {
      stringData: Record<string, string>;
    };
    for (const v of Object.values(doc.stringData)) {
      expect(v).toBe('');
    }
  });
});

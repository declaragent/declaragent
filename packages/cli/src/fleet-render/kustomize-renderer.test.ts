/**
 * Tests for the Kustomize renderer (#33).
 *
 * Structure mirrors k8s-renderer.test.ts:
 *   1. Golden-file — fleet-starter matches
 *      `__snapshots__/fleet-starter-kustomize/*` byte-for-byte.
 *   2. Determinism — two renders are identical.
 *   3. Structural invariants — base/ has a `kustomization.yaml` whose
 *      `resources:` list references every file under `base/`. Each
 *      overlay references `../../base`. Root `kustomization.yaml`
 *      references `./base`.
 *   4. `--config-split` golden — fleet-starter renders its own snapshot
 *      tree under `__snapshots__/fleet-starter-kustomize-config-split/`
 *      when the option is on.
 *
 * The Kustomize CLI isn't invoked directly — that runs in CI behind a
 * `scripts/validate-kustomize.sh` once the script lands. In-pure we
 * only assert deterministic, schema-valid YAML.
 */

import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { findFleetRoot, loadFleet } from '@declaragent/core';
import { parse as parseYaml } from 'yaml';
import { renderKustomize } from './kustomize-renderer.js';

const FLEET_STARTER = join(__dirname, '..', '..', '..', '..', 'templates', 'fleet-starter');
const SNAPSHOT_DIR = join(__dirname, '__snapshots__', 'fleet-starter-kustomize');
const SPLIT_SNAPSHOT_DIR = join(__dirname, '__snapshots__', 'fleet-starter-kustomize-config-split');

async function loadStarter() {
  const root = await findFleetRoot(FLEET_STARTER);
  if (!root) throw new Error(`fleet-starter not found under ${FLEET_STARTER}`);
  return loadFleet({ root, skipPeers: true });
}

async function readSnapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const rel = relative(dir, full);
        out.set(rel.replace(/\\/g, '/'), await readFile(full, 'utf-8'));
      }
    }
  }
  await walk(dir);
  return out;
}

describe('kustomize-renderer golden files', () => {
  test('fleet-starter matches checked-in kustomize snapshot', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet);
    const snapshot = await readSnapshot(SNAPSHOT_DIR);

    const rendered = new Map(files.map((f) => [f.path, f.contents]));
    for (const [path, contents] of rendered) {
      const expected = snapshot.get(path);
      expect(expected, `missing snapshot for ${path}`).toBeDefined();
      expect(contents).toBe(expected as string);
    }
    for (const path of snapshot.keys()) {
      expect(rendered.has(path), `snapshot ${path} has no rendered counterpart`).toBe(true);
    }
  });

  test('fleet-starter with --config-split matches dedicated snapshot', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet, { configSplit: true });
    const snapshot = await readSnapshot(SPLIT_SNAPSHOT_DIR);
    const rendered = new Map(files.map((f) => [f.path, f.contents]));
    for (const [path, contents] of rendered) {
      const expected = snapshot.get(path);
      expect(expected, `missing split snapshot for ${path}`).toBeDefined();
      expect(contents).toBe(expected as string);
    }
    for (const path of snapshot.keys()) {
      expect(rendered.has(path), `split snapshot ${path} has no rendered counterpart`).toBe(true);
    }
  });
});

describe('kustomize-renderer determinism', () => {
  test('two renders of the same fleet are byte-identical', async () => {
    const fleet = await loadStarter();
    const a = await renderKustomize(fleet);
    const b = await renderKustomize(fleet);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]?.path).toBe(b[i]?.path ?? '');
      expect(a[i]?.contents).toBe(b[i]?.contents ?? '');
    }
  });
});

describe('kustomize-renderer structure', () => {
  test('emits root + base + dev/staging/prod overlays', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet);
    const paths = new Set(files.map((f) => f.path));
    expect(paths.has('kustomization.yaml')).toBe(true);
    expect(paths.has('base/kustomization.yaml')).toBe(true);
    expect(paths.has('overlays/dev/kustomization.yaml')).toBe(true);
    expect(paths.has('overlays/staging/kustomization.yaml')).toBe(true);
    expect(paths.has('overlays/prod/kustomization.yaml')).toBe(true);
    expect(paths.has('base/00-namespace.yaml')).toBe(true);
    for (const agent of fleet.agents) {
      expect(paths.has(`base/agents/${agent.id}.yaml`)).toBe(true);
    }
  });

  test('root kustomization references ./base', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet);
    const root = files.find((f) => f.path === 'kustomization.yaml');
    const doc = parseYaml(root?.contents ?? '') as {
      apiVersion?: string;
      kind?: string;
      resources?: string[];
    };
    expect(doc.apiVersion).toBe('kustomize.config.k8s.io/v1beta1');
    expect(doc.kind).toBe('Kustomization');
    expect(doc.resources).toEqual(['./base']);
  });

  test('base kustomization lists every file under base/ as a resource', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet);
    const base = files.find((f) => f.path === 'base/kustomization.yaml');
    const doc = parseYaml(base?.contents ?? '') as { resources: string[] };
    // Every other file under `base/` (excluding base/kustomization.yaml
    // itself) must appear in resources.
    const expectedResources = files
      .filter((f) => f.path.startsWith('base/') && f.path !== 'base/kustomization.yaml')
      .map((f) => f.path.replace(/^base\//, ''))
      .sort();
    expect(doc.resources).toEqual(expectedResources);
  });

  test('each overlay references ../../base + a per-env namespace', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet);
    for (const env of ['dev', 'staging', 'prod'] as const) {
      const o = files.find((f) => f.path === `overlays/${env}/kustomization.yaml`);
      expect(o, `missing overlay ${env}`).toBeDefined();
      const doc = parseYaml(o?.contents ?? '') as {
        resources: string[];
        namespace: string;
        commonLabels: Record<string, string>;
      };
      expect(doc.resources).toEqual(['../../base']);
      // prod keeps the base namespace; non-prod envs suffix with -<env>.
      const expectedNs = env === 'prod' ? 'fleet-starter' : `fleet-starter-${env}`;
      expect(doc.namespace).toBe(expectedNs);
      expect(doc.commonLabels['declaragent.io/environment']).toBe(env);
    }
  });

  test('prod overlay sets replicas=3 + memory limit 2Gi per agent', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet);
    const prod = files.find((f) => f.path === 'overlays/prod/kustomization.yaml');
    const doc = parseYaml(prod?.contents ?? '') as {
      patches: Array<{ target: { name: string }; patch: string }>;
    };
    expect(doc.patches.length).toBe(fleet.agents.length);
    for (const p of doc.patches) {
      const patch = parseYaml(p.patch) as {
        spec: {
          replicas: number;
          template: {
            spec: {
              containers: Array<{ resources: { limits: { memory: string } } }>;
            };
          };
        };
      };
      expect(patch.spec.replicas).toBe(3);
      expect(patch.spec.template.spec.containers[0]?.resources.limits.memory).toBe('2Gi');
    }
  });

  test('dev overlay keeps replicas=1 + memory limit 512Mi', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet);
    const dev = files.find((f) => f.path === 'overlays/dev/kustomization.yaml');
    const doc = parseYaml(dev?.contents ?? '') as {
      patches: Array<{ patch: string }>;
    };
    for (const p of doc.patches) {
      const patch = parseYaml(p.patch) as {
        spec: {
          replicas: number;
          template: {
            spec: { containers: Array<{ resources: { limits: { memory: string } } }> };
          };
        };
      };
      expect(patch.spec.replicas).toBe(1);
      expect(patch.spec.template.spec.containers[0]?.resources.limits.memory).toBe('512Mi');
    }
  });

  test('base resources parse as valid YAML', async () => {
    const fleet = await loadStarter();
    const files = await renderKustomize(fleet);
    for (const f of files.filter(
      (x) => x.path.startsWith('base/') && x.path !== 'base/kustomization.yaml',
    )) {
      // Each base file is either a single doc or multi-doc joined by `---\n`.
      const parts = f.contents
        .split(/^---\n/m)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(parts.length, `no docs in ${f.path}`).toBeGreaterThan(0);
      for (const p of parts) {
        expect(() => parseYaml(p), `invalid YAML in ${f.path}`).not.toThrow();
      }
    }
  });
});

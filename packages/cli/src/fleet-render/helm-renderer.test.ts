/**
 * Tests for the Helm renderer.
 *
 * Mirrors the k8s test structure: golden-file snapshot + determinism +
 * validity. The stronger "helm lint passes" + "helm template renders"
 * checks (§3 #9 Acceptance 2) live behind CI scripts that require helm
 * to be installed locally — see `scripts/validate-helm.sh`. When helm
 * isn't available we still exercise chart structure invariants in-pure:
 *
 *   - Chart.yaml parses as YAML with required fields.
 *   - values.yaml parses and has the documented knobs.
 *   - templates/*.yaml are non-empty and reference only `.Values.X`
 *     paths declared in values.yaml.
 */

import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { findFleetRoot, loadFleet } from '@declaragent/core';
import { parse as parseYaml } from 'yaml';
import { renderHelm } from './helm-renderer.js';

const FLEET_STARTER = join(__dirname, '..', '..', '..', '..', 'templates', 'fleet-starter');
const SNAPSHOT_DIR = join(__dirname, '__snapshots__', 'fleet-starter-helm');

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

describe('helm-renderer golden files', () => {
  test('fleet-starter matches checked-in chart snapshot', async () => {
    const fleet = await loadStarter();
    const files = await renderHelm(fleet);
    const snapshot = await readSnapshot();

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
});

describe('helm-renderer determinism', () => {
  test('two renders of the same fleet are byte-identical', async () => {
    const fleet = await loadStarter();
    const a = await renderHelm(fleet);
    const b = await renderHelm(fleet);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i]?.path).toBe(b[i]?.path ?? '');
      expect(a[i]?.contents).toBe(b[i]?.contents ?? '');
    }
  });
});

describe('helm-renderer structure', () => {
  test('chart emits Chart.yaml, values.yaml, and per-agent templates', async () => {
    const fleet = await loadStarter();
    const files = await renderHelm(fleet);
    const paths = new Set(files.map((f) => f.path));
    expect(paths.has('Chart.yaml')).toBe(true);
    expect(paths.has('values.yaml')).toBe(true);
    expect(paths.has('templates/_helpers.tpl')).toBe(true);
    expect(paths.has('templates/namespace.yaml')).toBe(true);
    expect(paths.has('templates/secret.yaml')).toBe(true);
    for (const agent of fleet.agents) {
      expect(paths.has(`templates/agents/${agent.id}.yaml`)).toBe(true);
    }
  });

  test('Chart.yaml parses and has required fields', async () => {
    const fleet = await loadStarter();
    const files = await renderHelm(fleet);
    const chart = files.find((f) => f.path === 'Chart.yaml');
    const doc = parseYaml(chart?.contents ?? '') as {
      apiVersion?: string;
      name?: string;
      version?: string;
      type?: string;
    };
    expect(doc.apiVersion).toBe('v2');
    expect(doc.name).toBe('fleet-starter');
    expect(doc.type).toBe('application');
    expect(typeof doc.version).toBe('string');
  });

  test('values.yaml exposes the documented knobs', async () => {
    const fleet = await loadStarter();
    const files = await renderHelm(fleet);
    const values = files.find((f) => f.path === 'values.yaml');
    const doc = parseYaml(values?.contents ?? '') as Record<string, unknown>;
    expect(doc.namespace).toBe('fleet-starter');
    expect(doc.image).toBeDefined();
    expect(doc.replicas).toBeDefined();
    expect(doc.metricsPort).toBe(9464);
    expect(doc.healthProbePath).toBe('/healthz');
    expect(doc.serviceMonitor).toBeDefined();
    // `secrets` is a map (possibly empty) — never contains real values.
    expect(typeof doc.secrets).toBe('object');
  });

  test('values.yaml secrets map holds only empty values', async () => {
    const fleet = await loadStarter();
    const files = await renderHelm(fleet);
    const values = files.find((f) => f.path === 'values.yaml');
    const doc = parseYaml(values?.contents ?? '') as { secrets: Record<string, string> };
    for (const v of Object.values(doc.secrets ?? {})) {
      expect(v).toBe('');
    }
  });

  test('per-agent template references $replicas + $agentId', async () => {
    const fleet = await loadStarter();
    const files = await renderHelm(fleet);
    for (const agent of fleet.agents) {
      const f = files.find((x) => x.path === `templates/agents/${agent.id}.yaml`);
      expect(f).toBeDefined();
      const contents = f?.contents ?? '';
      expect(contents).toContain('$agentId');
      expect(contents).toContain('$replicas');
      expect(contents).toContain('.Values.image.repository');
      expect(contents).toContain('.Values.metricsPort');
    }
  });
});

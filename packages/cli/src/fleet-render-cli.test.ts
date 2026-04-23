/**
 * CLI-level tests for `declaragent fleet render`.
 *
 * Covers:
 *   - Missing / invalid `--target` is rejected with a non-zero exit.
 *   - A missing fleet.yaml prints a helpful error and exits 1.
 *   - Successful k8s render writes the expected file set under --out.
 *   - Successful helm render writes the expected chart layout.
 *   - `--json` summary lists every file the renderer produced.
 *
 * We wire the real `loadFleet` against `templates/fleet-starter/` so
 * the CLI surface is exercised end-to-end without a kubectl dependency.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetRender } from './fleet-render-cli.js';

const FLEET_STARTER = join(__dirname, '..', '..', '..', 'templates', 'fleet-starter');

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out,
    err,
  };
}

function mkTempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-render-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe('fleet render CLI', () => {
  test('rejects missing --target', async () => {
    const { io, err } = captureIo();
    const code = await fleetRender({}, { io });
    expect(code).toBe(1);
    expect(err.join('')).toContain('--target is required');
  });

  test('rejects unknown --target value', async () => {
    const { io, err } = captureIo();
    const code = await fleetRender({ target: 'kustomize' }, { io });
    expect(code).toBe(1);
    expect(err.join('')).toContain('--target is required');
  });

  test('rejects when no fleet.yaml exists', async () => {
    const { io, err } = captureIo();
    const dir = mkTempDir();
    try {
      const code = await fleetRender({ target: 'k8s' }, { io, cwd: dir.path });
      expect(code).toBe(1);
      expect(err.join('')).toContain('no fleet.yaml');
    } finally {
      dir.cleanup();
    }
  });

  test('k8s target writes expected files', async () => {
    const { io, out } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'k8s', out: outDir.path },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      expect(existsSync(join(outDir.path, '00-namespace.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'agents/concierge.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'agents/pr-reviewer.yaml'))).toBe(true);
      const concierge = readFileSync(join(outDir.path, 'agents/concierge.yaml'), 'utf-8');
      expect(concierge).toContain('kind: Deployment');
      expect(concierge).toContain('kind: ConfigMap');
      expect(concierge).toContain('kind: Service');
      expect(out.join('')).toContain('rendered k8s manifests');
    } finally {
      outDir.cleanup();
    }
  });

  test('helm target writes chart layout', async () => {
    const { io } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'helm', out: outDir.path },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      expect(existsSync(join(outDir.path, 'Chart.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'values.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'templates/_helpers.tpl'))).toBe(true);
      expect(existsSync(join(outDir.path, 'templates/namespace.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'templates/secret.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'templates/agents/concierge.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'templates/agents/pr-reviewer.yaml'))).toBe(true);
    } finally {
      outDir.cleanup();
    }
  });

  test('--json summary lists every rendered file', async () => {
    const { io, out } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'k8s', out: outDir.path, json: true },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      const payload = JSON.parse(out.join('')) as {
        target: string;
        files: string[];
        agents: string[];
      };
      expect(payload.target).toBe('k8s');
      expect(payload.agents).toEqual(['concierge', 'pr-reviewer']);
      expect(payload.files).toContain('00-namespace.yaml');
      expect(payload.files).toContain('agents/concierge.yaml');
      expect(payload.files).toContain('agents/pr-reviewer.yaml');
    } finally {
      outDir.cleanup();
    }
  });

  test('--no-servicemonitor removes ServiceMonitor docs', async () => {
    const { io } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'k8s', out: outDir.path, noServiceMonitor: true },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      const body = readFileSync(join(outDir.path, 'agents/concierge.yaml'), 'utf-8');
      expect(body).not.toContain('kind: ServiceMonitor');
      // ServiceMonitor file must NOT exist when opted out (#31).
      expect(() =>
        readFileSync(join(outDir.path, 'agents/concierge-servicemonitor.yaml'), 'utf-8'),
      ).toThrow();
    } finally {
      outDir.cleanup();
    }
  });

  test('--format=kustomize writes base + overlays (#33)', async () => {
    const { io, out } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'k8s', format: 'kustomize', out: outDir.path },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      expect(existsSync(join(outDir.path, 'kustomization.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'base/kustomization.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'base/00-namespace.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'base/agents/concierge.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'overlays/dev/kustomization.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'overlays/staging/kustomization.yaml'))).toBe(true);
      expect(existsSync(join(outDir.path, 'overlays/prod/kustomization.yaml'))).toBe(true);
      expect(out.join('')).toContain('(kustomize)');
      expect(out.join('')).toContain('kubectl apply -k');
    } finally {
      outDir.cleanup();
    }
  });

  test('--format=kustomize with --json lists format in payload (#33)', async () => {
    const { io, out } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'k8s', format: 'kustomize', out: outDir.path, json: true },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      const payload = JSON.parse(out.join('')) as {
        target: string;
        format: string;
        files: string[];
      };
      expect(payload.target).toBe('k8s');
      expect(payload.format).toBe('kustomize');
      expect(payload.files).toContain('kustomization.yaml');
      expect(payload.files).toContain('base/kustomization.yaml');
      expect(payload.files).toContain('overlays/prod/kustomization.yaml');
    } finally {
      outDir.cleanup();
    }
  });

  test('--format=helm is the default for --target k8s (#33)', async () => {
    const { io } = captureIo();
    const outDir = mkTempDir();
    try {
      // No --format; should behave exactly like 0.7.4 k8s render.
      const code = await fleetRender(
        { target: 'k8s', out: outDir.path },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      // Kustomize files must NOT exist when format defaults to helm.
      expect(existsSync(join(outDir.path, 'kustomization.yaml'))).toBe(false);
      expect(existsSync(join(outDir.path, 'base'))).toBe(false);
      // Core k8s files DO exist.
      expect(existsSync(join(outDir.path, '00-namespace.yaml'))).toBe(true);
    } finally {
      outDir.cleanup();
    }
  });

  test('--format=kustomize with --target helm is rejected (#33)', async () => {
    const { io, err } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'helm', format: 'kustomize', out: outDir.path },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(1);
      expect(err.join('')).toContain('--format=kustomize is not supported with --target helm');
    } finally {
      outDir.cleanup();
    }
  });

  test('unknown --format value is rejected (#33)', async () => {
    const { io, err } = captureIo();
    const code = await fleetRender(
      { target: 'k8s', format: 'argocd' },
      { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('unknown --format "argocd"');
  });

  test('--config-split emits per-section ConfigMaps (#32)', async () => {
    const { io } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'k8s', out: outDir.path, configSplit: true },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      const body = readFileSync(join(outDir.path, 'agents/concierge.yaml'), 'utf-8');
      // Sources ConfigMap present (fleet-starter declares event-sources).
      expect(body).toContain('name: concierge-sources-config');
      // Deployment envFrom references it.
      expect(body).toMatch(/envFrom:[\s\S]+concierge-sources-config/);
    } finally {
      outDir.cleanup();
    }
  });

  test('--config-split is off by default (#32)', async () => {
    const { io } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'k8s', out: outDir.path },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      const body = readFileSync(join(outDir.path, 'agents/concierge.yaml'), 'utf-8');
      expect(body).not.toContain('sources-config');
      expect(body).not.toContain('channels-config');
      expect(body).not.toContain('plugins-config');
    } finally {
      outDir.cleanup();
    }
  });

  test('ServiceMonitor ships in its own file by default (#31)', async () => {
    const { io } = captureIo();
    const outDir = mkTempDir();
    try {
      const code = await fleetRender(
        { target: 'k8s', out: outDir.path },
        { io, root: FLEET_STARTER, cwd: FLEET_STARTER },
      );
      expect(code).toBe(0);
      const workload = readFileSync(join(outDir.path, 'agents/concierge.yaml'), 'utf-8');
      // No ServiceMonitor bundled into the main workload manifest anymore.
      expect(workload).not.toContain('kind: ServiceMonitor');
      // Separate file exists + contains exactly one ServiceMonitor doc.
      const sm = readFileSync(join(outDir.path, 'agents/concierge-servicemonitor.yaml'), 'utf-8');
      expect(sm).toContain('kind: ServiceMonitor');
      expect(sm).toContain('apiVersion: monitoring.coreos.com/v1');
    } finally {
      outDir.cleanup();
    }
  });
});

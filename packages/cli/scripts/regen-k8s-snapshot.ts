/**
 * Regenerate every fleet-render snapshot (k8s, helm, kustomize — each
 * in default and `--config-split` flavors).
 *
 * Usage: `bun run regen-snapshots` from the `@declaragent/cli` package.
 *
 * Add a new entry to `TARGETS` when we add a new render target /
 * flavor combo.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findFleetRoot, loadFleet } from '@declaragent/core';
import { renderHelm } from '../src/fleet-render/helm-renderer.ts';
import { renderK8s } from '../src/fleet-render/k8s-renderer.ts';
import { renderKustomize } from '../src/fleet-render/kustomize-renderer.ts';
import type { RenderOptions, RenderedFile } from '../src/fleet-render/types.ts';

const FLEET_STARTER = new URL('../../../templates/fleet-starter', import.meta.url).pathname;

interface SnapTarget {
  readonly name: string;
  readonly dir: URL;
  readonly opts: RenderOptions;
  readonly render: (
    fleet: Awaited<ReturnType<typeof loadFleet>>,
    opts: RenderOptions,
  ) => Promise<RenderedFile[]>;
}

const TARGETS: readonly SnapTarget[] = [
  {
    name: 'k8s',
    dir: new URL('../src/fleet-render/__snapshots__/fleet-starter-k8s', import.meta.url),
    opts: {},
    render: (fleet, opts) => renderK8s(fleet, opts),
  },
  {
    name: 'k8s (config-split)',
    dir: new URL(
      '../src/fleet-render/__snapshots__/fleet-starter-k8s-config-split',
      import.meta.url,
    ),
    opts: { configSplit: true },
    render: (fleet, opts) => renderK8s(fleet, opts),
  },
  {
    name: 'helm',
    dir: new URL('../src/fleet-render/__snapshots__/fleet-starter-helm', import.meta.url),
    opts: {},
    render: (fleet, opts) => renderHelm(fleet, opts),
  },
  {
    name: 'helm (config-split)',
    dir: new URL(
      '../src/fleet-render/__snapshots__/fleet-starter-helm-config-split',
      import.meta.url,
    ),
    opts: { configSplit: true },
    render: (fleet, opts) => renderHelm(fleet, opts),
  },
  {
    name: 'kustomize',
    dir: new URL('../src/fleet-render/__snapshots__/fleet-starter-kustomize', import.meta.url),
    opts: {},
    render: (fleet, opts) => renderKustomize(fleet, opts),
  },
  {
    name: 'kustomize (config-split)',
    dir: new URL(
      '../src/fleet-render/__snapshots__/fleet-starter-kustomize-config-split',
      import.meta.url,
    ),
    opts: { configSplit: true },
    render: (fleet, opts) => renderKustomize(fleet, opts),
  },
];

const root = await findFleetRoot(FLEET_STARTER);
if (!root) throw new Error('no fleet-starter');
const fleet = await loadFleet({ root, skipPeers: true });

for (const t of TARGETS) {
  const files = await t.render(fleet, t.opts);
  const dirPath = t.dir.pathname;
  await rm(dirPath, { recursive: true, force: true });
  await mkdir(dirPath, { recursive: true });
  for (const f of files) {
    const full = join(dirPath, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.contents, 'utf-8');
  }
  console.log(`[${t.name}] wrote ${files.length} files to ${dirPath}`);
}

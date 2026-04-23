import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findFleetRoot, loadFleet } from '@declaragent/core';
import { renderK8s } from '../src/fleet-render/k8s-renderer.ts';

const FLEET_STARTER = new URL('../../../templates/fleet-starter', import.meta.url).pathname;
const SNAP = new URL('../src/fleet-render/__snapshots__/fleet-starter-k8s', import.meta.url)
  .pathname;

const root = await findFleetRoot(FLEET_STARTER);
if (!root) throw new Error('no fleet-starter');
const fleet = await loadFleet({ root, skipPeers: true });
const files = await renderK8s(fleet);

await rm(SNAP, { recursive: true, force: true });
await mkdir(SNAP, { recursive: true });
for (const f of files) {
  const full = join(SNAP, f.path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, f.contents, 'utf-8');
}
console.log(`wrote ${files.length} files to ${SNAP}`);
for (const f of files) console.log(`  ${f.path}`);

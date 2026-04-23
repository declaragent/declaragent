/**
 * `declaragent fleet render` — emit GitOps-friendly manifests from a
 * `fleet.yaml`.
 *
 * Usage:
 *   declaragent fleet render --target k8s  [--out <dir>] [flags]
 *   declaragent fleet render --target helm [--out <dir>] [flags]
 *
 * The command is pure: it reads `fleet.yaml` + each agent's
 * `agent.yaml`, runs the renderer, and writes every output file under
 * `--out`. No network IO, no state mutations, no `kubectl` / `helm`
 * shell-outs — the operator commits the output to their GitOps repo
 * and their Argo / Flux stack reconciles.
 *
 * Secret handling (spec §3 #9 Scope-in "Secret refs, not values"): the
 * k8s renderer emits a `Secret` manifest with keys and empty values
 * only; Helm's `values.yaml` exposes `secrets: {…}` with empty strings.
 * Operators populate real values out-of-band (Sealed Secrets, External
 * Secrets, Vault), or at `helm install --set-string secrets.X=…` time.
 *
 * @since 0.6.x (Enterprise plan item #9)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import {
  FleetConfigError,
  FleetManifestError,
  type LoadedFleet,
  findFleetRoot,
  loadFleet,
} from '@declaragent/core';
import type { FleetCliIO } from './fleet-deploy-cli.js';
import { renderHelm } from './fleet-render/helm-renderer.js';
import { renderK8s } from './fleet-render/k8s-renderer.js';
import type { RenderOptions, RenderTarget, RenderedFile } from './fleet-render/types.js';

const STDIO_IO: FleetCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface FleetRenderArgs {
  /** `k8s` or `helm`. Required. */
  target?: string;
  /** Output directory. Default `./rendered` (or `./chart` for helm). */
  out?: string;
  image?: string;
  replicas?: number;
  namespace?: string;
  /** Disable per-agent ServiceMonitor emission. Default: emit (Prom Operator assumed). */
  noServiceMonitor?: boolean;
  /** Machine-readable summary — file list as JSON. */
  json?: boolean;
}

export interface FleetRenderDeps {
  io?: FleetCliIO;
  cwd?: string;
  root?: string;
  /** Injected loader for tests — receives the resolved root. */
  load?: (root: string) => Promise<LoadedFleet>;
  /** Injected writer for tests — default writes to disk. */
  writer?: (outDir: string, files: readonly RenderedFile[]) => Promise<void>;
}

export async function fleetRender(
  args: FleetRenderArgs = {},
  deps: FleetRenderDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;

  const target = normalizeTarget(args.target);
  if (!target) {
    io.err(
      '✗ --target is required. Supported: k8s, helm.\n' +
        '  usage: declaragent fleet render --target <k8s|helm> [--out <dir>]\n',
    );
    return 1;
  }

  const root = deps.root ?? (await findFleetRoot(deps.cwd ?? process.cwd()));
  if (!root) {
    io.err(
      '✗ no fleet.yaml found in this directory or any parent. Run `declaragent init --fleet <name>` first.\n',
    );
    return 1;
  }

  let fleet: LoadedFleet;
  try {
    const loader = deps.load ?? ((r) => loadFleet({ root: r, skipPeers: true }));
    fleet = await loader(root);
  } catch (err) {
    if (err instanceof FleetManifestError || err instanceof FleetConfigError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to load fleet: ${msg}\n`);
    return 1;
  }

  if (fleet.agents.length === 0) {
    io.err('✗ fleet has no agents to render.\n');
    return 1;
  }

  const opts: RenderOptions = {
    ...(args.image !== undefined && { image: args.image }),
    ...(args.replicas !== undefined && { replicas: args.replicas }),
    ...(args.namespace !== undefined && { namespace: args.namespace }),
    ...(args.noServiceMonitor && { serviceMonitor: false }),
  };

  let files: RenderedFile[];
  try {
    files = target === 'k8s' ? await renderK8s(fleet, opts) : await renderHelm(fleet, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ render failed: ${msg}\n`);
    return 1;
  }

  const outDir = resolveOutDir(args.out, target, deps.cwd);
  try {
    const writer = deps.writer ?? defaultWriter;
    await writer(outDir, files);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to write output: ${msg}\n`);
    return 1;
  }

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          target,
          out: outDir,
          fleet: fleet.manifest.name,
          agents: fleet.agents.map((a) => a.id),
          files: files.map((f) => f.path),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.out(`✓ rendered ${target} manifests for fleet "${fleet.manifest.name}" → ${outDir}\n`);
    for (const f of files) {
      io.out(`  • ${f.path}\n`);
    }
    if (target === 'k8s') {
      io.out(
        '\nNext: commit the output, then `kubectl apply -f <dir>` (or let Argo/Flux reconcile).\n',
      );
    } else {
      io.out(
        '\nNext: `helm lint <dir>` and `helm install <release> <dir> --namespace <ns>`.\n' +
          'Secret values must be supplied via --set-string secrets.NAME=… or External Secrets.\n',
      );
    }
  }
  return 0;
}

async function defaultWriter(outDir: string, files: readonly RenderedFile[]): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const file of files) {
    const full = join(outDir, file.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, file.contents, 'utf-8');
  }
}

function normalizeTarget(raw: string | undefined): RenderTarget | undefined {
  if (raw === 'k8s' || raw === 'kubernetes') return 'k8s';
  if (raw === 'helm') return 'helm';
  return undefined;
}

function resolveOutDir(
  out: string | undefined,
  target: RenderTarget,
  cwd: string | undefined,
): string {
  const defaulted = out ?? (target === 'helm' ? './chart' : './rendered');
  const base = cwd ?? process.cwd();
  return isAbsolute(defaulted) ? defaulted : pathResolve(base, defaulted);
}

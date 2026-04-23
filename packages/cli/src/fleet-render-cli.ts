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
import { renderKustomize } from './fleet-render/kustomize-renderer.js';
import type {
  RenderFormat,
  RenderOptions,
  RenderTarget,
  RenderedFile,
} from './fleet-render/types.js';

const STDIO_IO: FleetCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface FleetRenderArgs {
  /** `k8s` or `helm`. Required. */
  target?: string;
  /**
   * Output format for the `kubernetes` / `k8s` target. `helm` (default)
   * emits a Helm chart; `kustomize` emits a Kustomize base + overlays.
   * Ignored when `--target helm` is passed (helm's own format). (#33)
   */
  format?: string;
  /** Output directory. Default `./rendered` (or `./chart` for helm). */
  out?: string;
  image?: string;
  replicas?: number;
  namespace?: string;
  /** Disable per-agent ServiceMonitor emission. Default: emit (Prom Operator assumed). */
  noServiceMonitor?: boolean;
  /**
   * Split channel / source / plugin config into dedicated ConfigMaps
   * mounted via `envFrom`. Default off at 0.7.5. (#32)
   */
  configSplit?: boolean;
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
        '  usage: declaragent fleet render --target <k8s|helm> [--format <helm|kustomize>] [--out <dir>]\n',
    );
    return 1;
  }

  const format = normalizeFormat(args.format);
  if (args.format !== undefined && !format) {
    io.err(
      `✗ unknown --format "${args.format}". Supported: helm, kustomize.\n  --format is only meaningful with --target k8s (today: helm default, kustomize opt-in).\n`,
    );
    return 1;
  }
  // `--format` on `--target helm` is meaningless (the target already
  // picks the format). Warn rather than error so scripts chaining the
  // flags don't break unexpectedly.
  if (target === 'helm' && format && format !== 'helm') {
    io.err(
      `✗ --format=${format} is not supported with --target helm. Use --target k8s --format kustomize.\n`,
    );
    return 1;
  }
  const effectiveFormat: RenderFormat = format ?? 'helm';

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
    ...(args.configSplit && { configSplit: true }),
  };

  let files: RenderedFile[];
  try {
    if (target === 'k8s' && effectiveFormat === 'kustomize') {
      files = await renderKustomize(fleet, opts);
    } else if (target === 'k8s') {
      files = await renderK8s(fleet, opts);
    } else {
      files = await renderHelm(fleet, opts);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ render failed: ${msg}\n`);
    return 1;
  }

  const outDir = resolveOutDir(args.out, target, effectiveFormat, deps.cwd);
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
          format: effectiveFormat,
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
    // Human-readable banner. `target` stays primary so scripts grep for
    // "rendered k8s manifests" / "rendered helm manifests" like they
    // did pre-0.7.5; format is appended parenthetically when it's not
    // the default (helm for k8s, helm for helm).
    const formatTag = target === 'k8s' && effectiveFormat === 'kustomize' ? ' (kustomize)' : '';
    io.out(
      `✓ rendered ${target} manifests${formatTag} for fleet "${fleet.manifest.name}" → ${outDir}\n`,
    );
    for (const f of files) {
      io.out(`  • ${f.path}\n`);
    }
    if (target === 'k8s' && effectiveFormat === 'kustomize') {
      io.out(
        '\nNext: commit the output, then `kubectl apply -k <dir>` (or `kubectl apply -k <dir>/overlays/<env>`).\n',
      );
    } else if (target === 'k8s') {
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

function normalizeFormat(raw: string | undefined): RenderFormat | undefined {
  if (raw === 'helm') return 'helm';
  if (raw === 'kustomize') return 'kustomize';
  return undefined;
}

function resolveOutDir(
  out: string | undefined,
  target: RenderTarget,
  format: RenderFormat,
  cwd: string | undefined,
): string {
  const defaulted =
    out ?? (target === 'helm' ? './chart' : format === 'kustomize' ? './kustomize' : './rendered');
  const base = cwd ?? process.cwd();
  return isAbsolute(defaulted) ? defaulted : pathResolve(base, defaulted);
}

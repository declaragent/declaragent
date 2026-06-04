/**
 * `declaragent fleet add [--template <t> | --path <p>] [--id <id>]` —
 * CLI wrapper over {@link addAgentFromTemplate} / {@link addAgentFromPath}.
 *
 * Templates live on disk at `<repo>/templates/<name>`. The CLI resolves
 * the default templates directory by walking up from this module until
 * it finds one. Tests inject an explicit `templatesDir` (and an FS shim)
 * so the default resolution doesn't matter.
 *
 * @since 1.2.0
 */

import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFleetRoot } from '@declaragent/core';
import type { AddAgentResult, FleetFS } from './fleet-scaffold.js';
import {
  DEFAULT_FLEET_FS,
  FleetScaffoldError,
  addAgentFromPath,
  addAgentFromTemplate,
} from './fleet-scaffold.js';

export interface FleetAddIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetAddIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface FleetAddArgs {
  /** One of `--template <name>` or `--path <dir>` must be provided. */
  template?: string;
  path?: string;
  id?: string;
  force?: boolean;
}

export interface FleetAddDeps {
  io?: FleetAddIO;
  fs?: FleetFS;
  cwd?: string;
  /**
   * Override the templates directory. Production callers let this
   * default to the repo's `templates/` dir; tests always inject a
   * dedicated tmpdir.
   */
  templatesDir?: string;
  /** Override fleet root discovery (tests supply an absolute path). */
  fleetRoot?: string;
}

export async function fleetAdd(args: FleetAddArgs, deps: FleetAddDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fs = deps.fs ?? DEFAULT_FLEET_FS;

  // Exactly one of --template / --path.
  const modeCount = Number(args.template !== undefined) + Number(args.path !== undefined);
  if (modeCount === 0) {
    io.err('✗ `fleet add` requires either `--template <name>` or `--path <dir>`\n');
    return 1;
  }
  if (modeCount > 1) {
    io.err('✗ `fleet add` takes either `--template` or `--path`, not both\n');
    return 1;
  }

  const fleetRoot = deps.fleetRoot ?? (await findFleetRoot(deps.cwd ?? process.cwd()));
  if (!fleetRoot) {
    io.err(
      '✗ no fleet.yaml found in this directory or any parent. Run `declaragent init --fleet <name>` first.\n',
    );
    return 1;
  }

  try {
    let result: AddAgentResult;
    if (args.template) {
      const templatesDir = deps.templatesDir ?? defaultTemplatesDir();
      result = addAgentFromTemplate(
        {
          fleetRoot,
          template: args.template,
          templatesDir,
          ...(args.id !== undefined && { id: args.id }),
          ...(args.force !== undefined && { force: args.force }),
        },
        fs,
      );
    } else {
      const sourceDir = isAbsolute(args.path as string)
        ? (args.path as string)
        : pathResolve(deps.cwd ?? process.cwd(), args.path as string);
      result = addAgentFromPath(
        {
          fleetRoot,
          sourceDir,
          ...(args.id !== undefined && { id: args.id }),
          ...(args.force !== undefined && { force: args.force }),
        },
        fs,
      );
    }

    for (const path of result.written) io.out(`  wrote ${path}\n`);
    io.out(`  updated ${result.manifestPath}\n`);
    io.out(`✓ added agent "${result.agentId}" at ${result.agentPath}\n`);
    return 0;
  } catch (err) {
    if (err instanceof FleetScaffoldError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ ${msg}\n`);
    return 1;
  }
}

/**
 * Resolve the `templates/` directory relative to this module.
 *
 * Two layouts must work:
 *  1. **Installed package** (`npm i -g @declaragent/cli`): the runtime
 *     module lives at `<pkg>/dist/...`, and `templates/` is copied to the
 *     package root (`<pkg>/templates`) by the `prepack`/`prebuild` copy
 *     step. There is NO repo root to walk up to. This is the case that
 *     used to 404 — the same root cause as the binary download.
 *  2. **Monorepo dev**: the module lives at `packages/cli/src/...` (or
 *     `packages/cli/dist/...`), and the live templates are at the repo
 *     root `<repo>/templates`. The walk-up below finds it.
 *
 * Exported (as {@link defaultTemplatesDir}) so the builder toolkit's
 * `DeclaraFleetAdd` tool can reuse the same resolver without
 * duplicating the walk logic.
 */
export function defaultTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolveTemplatesDir(here, tryIsDir);
}

/**
 * Pure resolver behind {@link defaultTemplatesDir}. Split out so the
 * candidate ordering can be unit-tested against a fake `isDir` for both
 * the npm-install layout (`<pkg>/templates`) and the monorepo-dev layout
 * (`<repo>/templates`) without touching the real filesystem.
 *
 * @param here   The directory of the running module (`<pkg>/dist` when
 *               installed, `packages/cli/src` in dev).
 * @param isDir  Predicate that returns true iff its argument is a real
 *               directory.
 */
export function resolveTemplatesDir(here: string, isDir: (path: string) => boolean): string {
  // Installed-package candidates, tried first so an npm install never
  // walks up into a repo root that doesn't exist:
  //   <pkg>/dist  → <pkg>/templates   (the prepack-copied dir)
  //   <pkg>/src   → <pkg>/templates   (dev layout if ever colocated)
  const installCandidates = [join(here, '..', 'templates'), join(here, '..', '..', 'templates')];
  for (const candidate of installCandidates) {
    if (isDir(candidate)) return candidate;
  }

  // Monorepo-dev fallback: walk up from here looking for a sibling
  // `templates/` directory (the live repo-root source).
  let dir = here;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'templates');
    if (isDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: the historical repo-root guess. Callers surface a clear
  // "template not found" error if this path is wrong.
  return join(here, '..', '..', '..', 'templates');
}

function tryIsDir(path: string): boolean {
  try {
    return DEFAULT_FLEET_FS.isDir(path);
  } catch {
    return false;
  }
}

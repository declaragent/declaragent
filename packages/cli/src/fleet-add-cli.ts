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
 * Resolve the repo's `templates/` dir relative to this module. Walks up
 * from `packages/cli/src/` until we see a `templates/` directory
 * sibling. Only used as a fallback — production deploys must supply
 * their own templates dir via `--templates-dir` (tracked for a later
 * slice once the starter pack ships as a package).
 *
 * Exported (as {@link defaultTemplatesDir}) so the builder toolkit's
 * `DeclaraFleetAdd` tool can reuse the same resolver without
 * duplicating the walk logic.
 */
export function defaultTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/cli/src → packages/cli → packages → <root>
  let dir = here;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'templates');
    if (tryIsDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(here, '..', '..', '..', 'templates');
}

function tryIsDir(path: string): boolean {
  try {
    return DEFAULT_FLEET_FS.isDir(path);
  } catch {
    return false;
  }
}

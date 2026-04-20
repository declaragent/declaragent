/**
 * `declaragent init --fleet <name>` + `declaragent fleet new <name>` —
 * thin CLI wrappers over {@link scaffoldFleet}.
 *
 * The heavy lifting is in `fleet-scaffold.ts`. This file exists so the
 * CLI entrypoint has a single-function handler per verb, and so tests
 * can drive the verb directly without spawning a process.
 *
 * @since 1.2.0
 */

import { isAbsolute, resolve as pathResolve } from 'node:path';
import type { FleetFS } from './fleet-scaffold.js';
import { DEFAULT_FLEET_FS, FleetScaffoldError, scaffoldFleet } from './fleet-scaffold.js';

export interface FleetInitIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: FleetInitIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface FleetInitArgs {
  /** Fleet name. Also used as the default output directory when `out` is omitted. */
  name: string;
  /**
   * Output directory. Defaults to `<cwd>/<name>`. An absolute path is
   * used as-is; a relative path resolves against `cwd`.
   */
  out?: string;
  force?: boolean;
  /** Skip the post-scaffold `bun install` hint. */
  quiet?: boolean;
}

export interface FleetInitDeps {
  io?: FleetInitIO;
  fs?: FleetFS;
  cwd?: string;
}

export async function fleetInit(args: FleetInitArgs, deps: FleetInitDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const cwd = deps.cwd ?? process.cwd();
  const fs = deps.fs ?? DEFAULT_FLEET_FS;

  const outRel = args.out ?? args.name;
  const root = isAbsolute(outRel) ? outRel : pathResolve(cwd, outRel);

  try {
    const result = scaffoldFleet(
      {
        root,
        name: args.name,
        ...(args.force !== undefined && { force: args.force }),
      },
      fs,
    );
    for (const path of result.written) io.out(`  wrote ${path}\n`);
    for (const path of result.skipped) io.out(`  skipped ${path} (already exists)\n`);
    io.out(`✓ fleet "${args.name}" scaffolded at ${root}\n`);
    if (!args.quiet) {
      io.out('\nnext steps:\n');
      io.out(`  cd ${root}\n`);
      io.out('  bun install\n');
      io.out('  declaragent fleet add --template rpc-server --id pr-reviewer\n');
      io.out('  declaragent fleet validate\n');
    }
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

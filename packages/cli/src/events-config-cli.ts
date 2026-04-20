import { existsSync } from 'node:fs';
import type { EventSourceAdapter } from '@declaragent/core';
import {
  EventSourcesConfigError,
  discoverAdapters,
  validateEventSourcesConfig,
} from '@declaragent/core';
import { configDir, eventSourcesConfigPath } from './paths.js';

export interface EventsConfigCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: EventsConfigCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface EventsConfigValidateArgs {
  /** Optional path; defaults to `eventSourcesConfigPath()` (`.json`) + falls back to `.yaml` / `.yml`. */
  path?: string;
}

export interface EventsConfigCliDeps {
  io?: EventsConfigCliIO;
  /**
   * Adapter map used for semantic validation. Defaults to discovering
   * installed `@declaragent/source-*` packages. Tests inject a fixed map.
   */
  adapters?: Readonly<Record<string, EventSourceAdapter<unknown>>>;
  /** Override the `process.env` that secret references resolve against. */
  env?: Record<string, string | undefined>;
}

/**
 * Find a config file. When an explicit path is provided, use it. Otherwise
 * try the default JSON path, then the YAML/YML variants in the same dir.
 */
function resolveConfigPath(explicit: string | undefined): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const jsonPath = eventSourcesConfigPath();
  if (existsSync(jsonPath)) return jsonPath;
  const yamlPath = jsonPath.replace(/\.json$/, '.yaml');
  if (existsSync(yamlPath)) return yamlPath;
  const ymlPath = jsonPath.replace(/\.json$/, '.yml');
  if (existsSync(ymlPath)) return ymlPath;
  return null;
}

/**
 * `declaragent events-config validate [path]`
 *
 * Load + validate an event-sources config (JSON or YAML). Reports
 * structural issues, unknown source types, and adapter-level validation
 * errors. Exits non-zero if anything fails so it's usable in CI.
 */
export async function eventsConfigValidate(
  args: EventsConfigValidateArgs,
  deps: EventsConfigCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const resolved = resolveConfigPath(args.path);
  if (!resolved) {
    io.err(
      `✗ no event-sources config found${args.path ? ` at "${args.path}"` : ''}.\nCreate \`event-sources.json\` / \`event-sources.yaml\` in the config dir.\n`,
    );
    return 1;
  }

  const adapters =
    deps.adapters ??
    (Object.fromEntries(
      (await discoverAdapters({ searchPaths: [process.cwd(), configDir()] })).map((a) => [
        a.type,
        a.adapter as EventSourceAdapter<unknown>,
      ]),
    ) as Readonly<Record<string, EventSourceAdapter<unknown>>>);

  try {
    const report = await validateEventSourcesConfig({
      path: resolved,
      adapters,
      ...(deps.env !== undefined && { secretResolver: { env: deps.env } }),
    });
    io.out(
      `loaded ${report.sources.length} source(s) from ${resolved} (${report.format.toUpperCase()}).\n`,
    );
    if (report.unknownTypes.length > 0) {
      io.out('\nunknown types (no adapter installed):\n');
      for (const u of report.unknownTypes) {
        io.out(`  • entry[${u.index}] type="${u.type}"\n`);
      }
    }
    if (report.errors.length > 0) {
      io.err('\nvalidation errors:\n');
      for (const e of report.errors) {
        io.err(`  ✗ entry[${e.index}] type="${e.type}": ${e.message}\n`);
      }
      return 1;
    }
    io.out('\n✓ config is valid.\n');
    return 0;
  } catch (err) {
    if (err instanceof EventSourcesConfigError) {
      io.err(`✗ ${err.message}\n`);
    } else {
      io.err(`✗ unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  }
}

import { existsSync } from 'node:fs';
import type { ChannelAdapter } from '@declaragent/core';
import {
  ChannelAdapterDiscoveryError,
  ChannelsConfigError,
  discoverChannelAdapters,
  validateChannelsConfig,
} from '@declaragent/core';
import { channelsConfigPath, configDir } from './paths.js';

export interface ChannelsCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: ChannelsCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface ChannelsCliDeps {
  io?: ChannelsCliIO;
  /** Override the scan paths — tests supply a tmpdir. */
  searchPaths?: readonly string[];
  coreVersion?: string;
  /**
   * Adapter map used for semantic validation. Defaults to discovery.
   * Tests inject a fixed map.
   */
  adapters?: Readonly<Record<string, ChannelAdapter<unknown>>>;
  /** Override the `process.env` that secret references resolve against. */
  env?: Record<string, string | undefined>;
}

// ── `channels list` ─────────────────────────────────────────────────────────

/**
 * Print each installed channel adapter package (name, version, compat
 * range, install path). Read-only: does NOT register the adapters.
 * Useful for debugging why `channels validate` says "unknown type".
 */
export async function channelsList(deps: ChannelsCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const searchPaths = deps.searchPaths ?? [process.cwd(), configDir()];
  try {
    const adapters = await discoverChannelAdapters({
      searchPaths,
      ...(deps.coreVersion !== undefined && { coreVersion: deps.coreVersion }),
    });
    if (adapters.length === 0) {
      io.out('no channel adapter packages discovered.\n');
      io.out(
        'install one with `npm install @declaragent/channel-<name>` (telegram, discord, slack, whatsapp).\n',
      );
      return 0;
    }
    io.out(`channels (${adapters.length}):\n`);
    for (const a of adapters) {
      io.out(`  ${a.type}\n`);
      io.out(`    package: ${a.packageName}@${a.packageVersion}\n`);
      if (a.agentCompat) io.out(`    agent_compat: ${a.agentCompat}\n`);
      io.out(`    path: ${a.path}\n`);
      io.out(
        `    capabilities: threads=${a.adapter.capabilities.supportsThreads} ` +
          `reactions=${a.adapter.capabilities.supportsReactions} ` +
          `buttons=${a.adapter.capabilities.supportsButtons} ` +
          `files=${a.adapter.capabilities.supportsFileUpload} ` +
          `maxLen=${a.adapter.capabilities.maxMessageLength}\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof ChannelAdapterDiscoveryError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    io.err(`✗ discovery failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// ── `channels validate [path]` ─────────────────────────────────────────────

export interface ChannelsValidateArgs {
  /**
   * Optional path. Defaults to `channelsConfigPath()` (`.json`) + falls
   * back to `.yaml` / `.yml` in the same directory.
   */
  path?: string;
}

function resolveConfigPath(explicit: string | undefined): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const jsonPath = channelsConfigPath();
  if (existsSync(jsonPath)) return jsonPath;
  const yamlPath = jsonPath.replace(/\.json$/, '.yaml');
  if (existsSync(yamlPath)) return yamlPath;
  const ymlPath = jsonPath.replace(/\.json$/, '.yml');
  if (existsSync(ymlPath)) return ymlPath;
  return null;
}

/**
 * Load + validate a channels config (JSON or YAML). Reports structural
 * issues, unknown channel types, and adapter-level validation errors.
 * Exits non-zero on any failure so it's usable in CI.
 */
export async function channelsValidate(
  args: ChannelsValidateArgs,
  deps: ChannelsCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const resolved = resolveConfigPath(args.path);
  if (!resolved) {
    io.err(
      `✗ no channels config found${args.path ? ` at "${args.path}"` : ''}.\nCreate \`channels.json\` / \`channels.yaml\` in the config dir.\n`,
    );
    return 1;
  }

  const adapters =
    deps.adapters ??
    (Object.fromEntries(
      (
        await discoverChannelAdapters({
          searchPaths: [process.cwd(), configDir()],
          ...(deps.coreVersion !== undefined && { coreVersion: deps.coreVersion }),
        })
      ).map((a) => [a.type, a.adapter as ChannelAdapter<unknown>]),
    ) as Readonly<Record<string, ChannelAdapter<unknown>>>);

  try {
    const report = await validateChannelsConfig({
      path: resolved,
      adapters,
      ...(deps.env !== undefined && { secretResolver: { env: deps.env } }),
    });
    io.out(
      `loaded ${report.channels.length} channel(s) from ${resolved} (${report.format.toUpperCase()}).\n`,
    );
    if (report.unknownTypes.length > 0) {
      io.out('\nunknown types (no adapter installed):\n');
      for (const u of report.unknownTypes) {
        io.out(`  • channels[${u.index}] id="${u.id}" type="${u.type}"\n`);
      }
    }
    if (report.errors.length > 0) {
      io.err('\nvalidation errors:\n');
      for (const e of report.errors) {
        io.err(`  ✗ channels[${e.index}] id="${e.id}" type="${e.type}": ${e.message}\n`);
      }
      return 1;
    }
    io.out('\n✓ config is valid.\n');
    return 0;
  } catch (err) {
    if (err instanceof ChannelsConfigError) {
      io.err(`✗ ${err.message}\n`);
    } else {
      io.err(`✗ unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  }
}

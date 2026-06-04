import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ConfiguredSource } from '@declaragent/core';
import { eventSourcesConfigPath } from './paths.js';

export interface AdminCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: AdminCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface SourceCliDeps {
  io?: AdminCliIO;
  /** Path to event-sources.json; defaults to `eventSourcesConfigPath()`. */
  configPath?: string;
}

function resolveConfigPath(deps: SourceCliDeps): string {
  return deps.configPath ?? eventSourcesConfigPath();
}

function loadConfig(path: string): ConfiguredSource[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${path} is not a JSON array — expected [{type, config}, ...]. Fix or delete the file, then re-add sources with \`declaragent source add\`.`,
    );
  }
  const out: ConfiguredSource[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { type?: unknown; config?: unknown };
    if (typeof e.type !== 'string') continue;
    out.push({ type: e.type, config: e.config ?? {} });
  }
  return out;
}

function saveConfig(path: string, sources: readonly ConfiguredSource[]): void {
  writeFileSync(path, `${JSON.stringify(sources, null, 2)}\n`, 'utf-8');
}

function sourceKey(s: ConfiguredSource): string {
  const id = (s.config as Record<string, unknown> | null | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? `${s.type}:${id}` : `${s.type}:?`;
}

/** `declaragent source list` — configured sources from `event-sources.json`. */
export async function sourceList(deps: SourceCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const path = resolveConfigPath(deps);
  const sources = loadConfig(path);
  if (sources.length === 0) {
    io.out(`no sources configured (looked at ${path}).\n`);
    return 0;
  }
  io.out(`sources (${sources.length}):\n`);
  for (const s of sources) {
    io.out(`  ${sourceKey(s)}\n`);
  }
  return 0;
}

export interface SourceAddArgs {
  type: string;
  id: string;
  /** Raw JSON string for the source-specific config (excluding type + id). */
  configJson?: string;
  /** Path to a JSON file containing the full config (including id). */
  configFile?: string;
}

/**
 * `declaragent source add <type> <id> [--config <json>] [--config-file <path>]`
 *
 * Non-interactive. Takes either an inline JSON config (`--config`) or a
 * path to a JSON file. The emitted config always has an `id` field set
 * to `<id>` — the daemon's reload relies on that for diff keys.
 */
export async function sourceAdd(args: SourceAddArgs, deps: SourceCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const path = resolveConfigPath(deps);

  if (!args.type || !args.id) {
    io.err('✗ --type and <id> are required\n');
    return 1;
  }

  let config: Record<string, unknown>;
  try {
    if (args.configFile) {
      const raw = readFileSync(args.configFile, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object')
        throw new Error(
          'config file must contain a JSON object of source settings (e.g. {"id": "..."})',
        );
      config = parsed as Record<string, unknown>;
    } else if (args.configJson) {
      const parsed = JSON.parse(args.configJson) as unknown;
      if (!parsed || typeof parsed !== 'object')
        throw new Error('--config must be a JSON object of source settings (e.g. {"id": "..."})');
      config = parsed as Record<string, unknown>;
    } else {
      io.err('✗ provide either --config <json> or --config-file <path>\n');
      return 1;
    }
  } catch (err) {
    io.err(`✗ bad config: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  // Ensure id matches argument — otherwise reload diffing gets confusing.
  if (typeof config.id === 'string' && config.id !== args.id) {
    io.err(`✗ config.id ("${config.id}") must match <id> argument ("${args.id}")\n`);
    return 1;
  }
  config.id = args.id;

  const sources = loadConfig(path);
  const newKey = `${args.type}:${args.id}`;
  if (sources.some((s) => sourceKey(s) === newKey)) {
    io.err(`✗ source "${newKey}" already exists in ${path}\n`);
    return 1;
  }
  sources.push({ type: args.type, config });
  saveConfig(path, sources);
  io.out(`✓ added ${newKey} to ${path}\n`);
  io.out('  run `declaragent daemon-reload` to apply.\n');
  return 0;
}

/**
 * `declaragent source remove <key>` — `<key>` is either `<type>:<id>` or
 * just `<id>` (when it's unambiguous across types).
 */
export async function sourceRemove(key: string, deps: SourceCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const path = resolveConfigPath(deps);
  const sources = loadConfig(path);
  if (sources.length === 0) {
    io.err(`✗ no sources configured (looked at ${path})\n`);
    return 1;
  }

  let matches = sources.filter((s) => sourceKey(s) === key);
  if (matches.length === 0) {
    // Fall back to id-only matching if no type prefix.
    matches = sources.filter((s) => {
      const id = (s.config as Record<string, unknown> | null | undefined)?.id;
      return id === key;
    });
  }
  if (matches.length === 0) {
    io.err(`✗ no source matches "${key}"\n`);
    return 1;
  }
  if (matches.length > 1) {
    io.err(`✗ "${key}" is ambiguous; specify as "<type>:<id>":\n`);
    for (const m of matches) io.err(`    ${sourceKey(m)}\n`);
    return 1;
  }
  const match = matches[0] as ConfiguredSource;
  const next = sources.filter((s) => s !== match);
  saveConfig(path, next);
  io.out(`✓ removed ${sourceKey(match)} from ${path}\n`);
  io.out('  run `declaragent daemon-reload` to apply.\n');
  return 0;
}

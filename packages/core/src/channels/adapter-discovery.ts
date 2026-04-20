import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { satisfies } from '../events/semver.js';
import { VERSION } from '../index.js';
import type { Logger } from '../types/logger.js';
import type { ChannelAdapter, ChannelCapabilities } from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

export const CHANNEL_ADAPTER_SCOPE = '@declaragent';
export const CHANNEL_ADAPTER_PREFIX = 'channel-';
export const CHANNEL_ADAPTER_KIND = 'channel-adapter';

/** One channel-adapter package discovered on disk. */
export interface DiscoveredChannelAdapter {
  packageName: string;
  packageVersion: string;
  /** Channel type from the `declaragent.type` marker (matches `adapter.type`). */
  type: string;
  /** Semver range declared in `declaragent.agent_compat`, if any. */
  agentCompat?: string;
  /** Absolute path to the package directory on disk. */
  path: string;
  /** The adapter instance itself (default export of the package). */
  adapter: ChannelAdapter<unknown>;
}

export interface DiscoverChannelAdaptersOptions {
  /**
   * Directories whose `node_modules/@declaragent/channel-*` are scanned.
   * Default: `[process.cwd()]`. Duplicate types across paths throw with
   * both package names.
   */
  searchPaths?: readonly string[];
  /** Core version used for `agent_compat` checks. Default: `VERSION`. */
  coreVersion?: string;
  logger?: Logger;
}

export class ChannelAdapterDiscoveryError extends Error {
  readonly code = 'ECHANNELDISCOVER';
  constructor(message: string) {
    super(message);
    this.name = 'ChannelAdapterDiscoveryError';
  }
}

interface RawPackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  declaragent?: {
    kind?: string;
    type?: string;
    agent_compat?: string;
  };
}

async function listScopedChannelPackageDirs(nodeModulesDir: string): Promise<string[]> {
  const scopeDir = join(nodeModulesDir, CHANNEL_ADAPTER_SCOPE);
  if (!existsSync(scopeDir)) return [];
  const entries = await readdir(scopeDir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(CHANNEL_ADAPTER_PREFIX)) {
      out.push(join(scopeDir, entry.name));
    }
  }
  return out.sort();
}

function entryPointFor(pkg: RawPackageJson): string {
  return pkg.main ?? pkg.module ?? 'index.js';
}

function hasChannelCapabilities(value: unknown): value is { capabilities: ChannelCapabilities } {
  if (!value || typeof value !== 'object') return false;
  const caps = (value as { capabilities?: unknown }).capabilities;
  if (!caps || typeof caps !== 'object') return false;
  const required: readonly (keyof ChannelCapabilities)[] = [
    'supportsThreads',
    'supportsReactions',
    'supportsFileUpload',
    'supportsButtons',
    'maxMessageLength',
    'maxAttachmentBytes',
  ];
  for (const key of required) {
    if (!(key in (caps as Record<string, unknown>))) return false;
  }
  return true;
}

function isChannelAdapter(value: unknown): value is ChannelAdapter<unknown> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ChannelAdapter>;
  return (
    typeof v.type === 'string' &&
    typeof v.validateConfig === 'function' &&
    typeof v.create === 'function' &&
    hasChannelCapabilities(value)
  );
}

async function loadOnePackage(
  pkgDir: string,
  coreVersion: string,
  logger: Logger,
): Promise<DiscoveredChannelAdapter | null> {
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;

  let pkg: RawPackageJson;
  try {
    pkg = JSON.parse(await readFile(pkgJsonPath, 'utf-8')) as RawPackageJson;
  } catch (err) {
    logger.warn('channel-discovery.parse.error', {
      path: pkgJsonPath,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const meta = pkg.declaragent;
  if (!meta || meta.kind !== CHANNEL_ADAPTER_KIND) {
    // Not a channel adapter — quietly skip so event-source packages + other
    // scoped packages coexist without noise.
    return null;
  }
  if (!meta.type) {
    throw new ChannelAdapterDiscoveryError(
      `channel adapter package "${pkg.name ?? pkgDir}" is missing "declaragent.type" in its package.json`,
    );
  }

  if (!satisfies(coreVersion, meta.agent_compat)) {
    throw new ChannelAdapterDiscoveryError(
      `channel adapter "${pkg.name ?? pkgDir}" requires agent_compat "${meta.agent_compat}" but core is ${coreVersion}`,
    );
  }

  const entry = join(pkgDir, entryPointFor(pkg));
  let mod: { default?: unknown } & Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(entry).href)) as typeof mod;
  } catch (err) {
    throw new ChannelAdapterDiscoveryError(
      `failed to import channel adapter "${pkg.name ?? pkgDir}" from ${entry}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const exported = mod.default ?? mod;
  if (!isChannelAdapter(exported)) {
    throw new ChannelAdapterDiscoveryError(
      `channel adapter package "${pkg.name ?? pkgDir}" did not export a ChannelAdapter (missing \`type\`, \`capabilities\`, \`validateConfig\`, or \`create\`)`,
    );
  }

  if (exported.type !== meta.type) {
    logger.warn('channel-discovery.type.mismatch', {
      package: pkg.name,
      declaredType: meta.type,
      runtimeType: exported.type,
    });
  }

  return {
    packageName: pkg.name ?? pkgDir,
    packageVersion: pkg.version ?? '0.0.0',
    type: exported.type,
    ...(meta.agent_compat !== undefined && { agentCompat: meta.agent_compat }),
    path: pkgDir,
    adapter: exported,
  };
}

/**
 * Walk each search path's `node_modules/@declaragent/channel-*` and
 * return every package that self-identifies as a channel adapter and
 * is compatible with `coreVersion`.
 *
 * Throws on: duplicate type claims across packages, mismatched
 * `agent_compat`, missing `type`, import failures, malformed exports.
 * Skips silently: packages without the `declaragent` marker, broken
 * `package.json` files (logged), packages whose `declaragent.kind` isn't
 * `channel-adapter`.
 */
export async function discoverChannelAdapters(
  options: DiscoverChannelAdaptersOptions = {},
): Promise<DiscoveredChannelAdapter[]> {
  const coreVersion = options.coreVersion ?? VERSION;
  const logger = options.logger ?? NOOP_LOGGER;
  const searchPaths = options.searchPaths ?? [process.cwd()];

  const byType = new Map<string, DiscoveredChannelAdapter>();

  for (const searchPath of searchPaths) {
    const nodeModulesDir = join(searchPath, 'node_modules');
    if (!existsSync(nodeModulesDir)) continue;
    const pkgDirs = await listScopedChannelPackageDirs(nodeModulesDir);
    for (const pkgDir of pkgDirs) {
      const result = await loadOnePackage(pkgDir, coreVersion, logger);
      if (!result) continue;
      const prior = byType.get(result.type);
      if (prior) {
        throw new ChannelAdapterDiscoveryError(
          `channel type "${result.type}" is claimed by two packages: ` +
            `"${prior.packageName}" (${prior.path}) and "${result.packageName}" (${result.path})`,
        );
      }
      byType.set(result.type, result);
    }
  }

  return [...byType.values()];
}

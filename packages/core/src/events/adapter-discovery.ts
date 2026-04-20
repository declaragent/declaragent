import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionRegistry, ExtensionSource } from '../extension/types.js';
import { VERSION } from '../index.js';
import type { Logger } from '../types/logger.js';
import { satisfies } from './semver.js';
import { adapterExtension } from './source.js';
import type { EventSourceAdapter } from './types.js';

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

export const ADAPTER_SCOPE = '@declaragent';
export const ADAPTER_PREFIX = 'source-';

/** One adapter package discovered on disk. */
export interface DiscoveredAdapter {
  packageName: string;
  packageVersion: string;
  /** Adapter type from the `declaragent.type` marker (normally matches `adapter.type`). */
  type: string;
  /** Semver range declared in the package's `declaragent.agent_compat`, if any. */
  agentCompat?: string;
  /** Absolute path to the package directory on disk. */
  path: string;
  /** The adapter instance itself (default export of the package). */
  adapter: EventSourceAdapter<unknown>;
}

export interface DiscoverAdaptersOptions {
  /**
   * Directories whose `node_modules/@declaragent/source-*` are scanned.
   * Later paths do NOT override earlier ones; duplicate types across
   * paths throw with both package names. Default: `[process.cwd()]`.
   */
  searchPaths?: readonly string[];
  /** Core version used for `agent_compat` checks. Default: `VERSION`. */
  coreVersion?: string;
  logger?: Logger;
}

export class AdapterDiscoveryError extends Error {
  readonly code = 'EADAPTERDISCOVER';
  constructor(message: string) {
    super(message);
    this.name = 'AdapterDiscoveryError';
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

async function listScopedSourcePackageDirs(nodeModulesDir: string): Promise<string[]> {
  const scopeDir = join(nodeModulesDir, ADAPTER_SCOPE);
  if (!existsSync(scopeDir)) return [];
  const entries = await readdir(scopeDir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(ADAPTER_PREFIX)) {
      out.push(join(scopeDir, entry.name));
    }
  }
  return out.sort();
}

function entryPointFor(pkg: RawPackageJson): string {
  // Bun resolves `exports` natively, but we support plain `main` too for
  // older adapter packages. Order: `main` > `module` > `index.js`.
  return pkg.main ?? pkg.module ?? 'index.js';
}

function isEventSourceAdapter(value: unknown): value is EventSourceAdapter<unknown> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<EventSourceAdapter>;
  return (
    typeof v.type === 'string' &&
    typeof v.validateConfig === 'function' &&
    typeof v.create === 'function'
  );
}

async function loadOnePackage(
  pkgDir: string,
  coreVersion: string,
  logger: Logger,
): Promise<DiscoveredAdapter | null> {
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;

  let pkg: RawPackageJson;
  try {
    pkg = JSON.parse(await readFile(pkgJsonPath, 'utf-8')) as RawPackageJson;
  } catch (err) {
    logger.warn('adapter-discovery.parse.error', {
      path: pkgJsonPath,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const meta = pkg.declaragent;
  if (!meta || meta.kind !== 'event-source-adapter') {
    // Not ours — quietly skip. Plugins from other projects (or this
    // project's non-adapter packages) can coexist in the same scope.
    return null;
  }
  if (!meta.type) {
    throw new AdapterDiscoveryError(
      `adapter package "${pkg.name ?? pkgDir}" is missing "declaragent.type" in its package.json`,
    );
  }

  if (!satisfies(coreVersion, meta.agent_compat)) {
    throw new AdapterDiscoveryError(
      `adapter "${pkg.name ?? pkgDir}" requires agent_compat "${meta.agent_compat}" but core is ${coreVersion}`,
    );
  }

  const entry = join(pkgDir, entryPointFor(pkg));
  let mod: { default?: unknown } & Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(entry).href)) as typeof mod;
  } catch (err) {
    throw new AdapterDiscoveryError(
      `failed to import adapter "${pkg.name ?? pkgDir}" from ${entry}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const exported = mod.default ?? mod;
  if (!isEventSourceAdapter(exported)) {
    throw new AdapterDiscoveryError(
      `adapter package "${pkg.name ?? pkgDir}" did not export an EventSourceAdapter (missing \`type\`, \`validateConfig\`, or \`create\`)`,
    );
  }

  if (exported.type !== meta.type) {
    logger.warn('adapter-discovery.type.mismatch', {
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
 * Walk each search path's `node_modules/@declaragent/source-*` and
 * return every package that self-identifies as an event-source adapter
 * and is compatible with `coreVersion`.
 *
 * Throws on: duplicate type claims across packages, mismatched
 * `agent_compat`, missing `type`, import failures, malformed exports.
 * Skips silently: packages without the `declaragent` marker, broken
 * package.json files (logged), packages whose `declaragent.kind` isn't
 * `event-source-adapter`.
 */
export async function discoverAdapters(
  options: DiscoverAdaptersOptions = {},
): Promise<DiscoveredAdapter[]> {
  const coreVersion = options.coreVersion ?? VERSION;
  const logger = options.logger ?? NOOP_LOGGER;
  const searchPaths = options.searchPaths ?? [process.cwd()];

  const byType = new Map<string, DiscoveredAdapter>();

  for (const searchPath of searchPaths) {
    const nodeModulesDir = join(searchPath, 'node_modules');
    if (!existsSync(nodeModulesDir)) continue;
    const pkgDirs = await listScopedSourcePackageDirs(nodeModulesDir);
    for (const pkgDir of pkgDirs) {
      const result = await loadOnePackage(pkgDir, coreVersion, logger);
      if (!result) continue;
      const prior = byType.get(result.type);
      if (prior) {
        throw new AdapterDiscoveryError(
          `adapter type "${result.type}" is claimed by two packages: ` +
            `"${prior.packageName}" (${prior.path}) and "${result.packageName}" (${result.path})`,
        );
      }
      byType.set(result.type, result);
    }
  }

  return [...byType.values()];
}

/**
 * Register every discovered adapter as an `Extension<'event-source-adapter'>`
 * in the given registry. Descriptor id is `event-source-adapter:<type>`.
 * Source is `{ type: 'plugin', pluginId: packageName, pluginVersion }`
 * so downstream code can attribute where an adapter came from.
 */
export async function registerDiscoveredAdapters(
  registry: ExtensionRegistry,
  adapters: readonly DiscoveredAdapter[],
): Promise<void> {
  for (const d of adapters) {
    const source: ExtensionSource = {
      type: 'plugin',
      pluginId: d.packageName,
      pluginVersion: d.packageVersion,
    };
    await registry.register(adapterExtension(d.adapter, { source }));
  }
}

import { resolve } from 'node:path';
import {
  type PluginManifest,
  PluginManifestError,
  type PluginStore,
  createPluginStore,
  loadPluginManifest,
} from '@declaragent/core';
import { pluginStorePath } from './paths.js';

export interface PluginCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: PluginCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

interface PluginCliOptions {
  io?: PluginCliIO;
  store?: PluginStore;
  /** ISO timestamp factory; tests pin this for deterministic `installedAt`. */
  now?: () => string;
  /**
   * Consent decision. Returns `true` to approve, `false` to reject.
   * Default: render the Ink consent UI (interactive). The CLI passes a
   * tautological `() => true` shim when `--yes` is supplied; tests pass
   * their own resolver to drive both paths without TTY.
   */
  consent?: (manifest: PluginManifest, pluginDir: string) => Promise<boolean>;
}

function getStore(options: PluginCliOptions): PluginStore {
  return options.store ?? createPluginStore(pluginStorePath());
}

/**
 * `declaragent plugin install <path>` — local-path install for v0.3.
 * Reads + validates the manifest, then writes a store entry pointing
 * at the absolute source path. (Slice 8 will add the consent UI between
 * validation and persistence; npm/git sources land in Phase 3.)
 */
export async function pluginInstall(
  pathArg: string,
  options: PluginCliOptions = {},
): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const store = getStore(options);
  const now = options.now ?? (() => new Date().toISOString());

  const dir = resolve(pathArg);
  let manifest: PluginManifest;
  try {
    manifest = await loadPluginManifest(dir);
  } catch (err) {
    if (err instanceof PluginManifestError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const consent = options.consent ?? requireConsent;
  const approved = await consent(manifest, dir);
  if (!approved) {
    io.err(`✗ install cancelled — ${manifest.name} was not added\n`);
    return 1;
  }

  const timestamp = now();
  await store.add({
    name: manifest.name,
    version: manifest.version,
    dir,
    installedAt: timestamp,
    ...(manifest.permissions.length > 0
      ? { consentedPermissions: [...manifest.permissions], consentedAt: timestamp }
      : {}),
  });
  io.out(`✓ installed ${manifest.name}@${manifest.version} from ${dir}\n`);
  if (manifest.permissions.length > 0) {
    io.out('  consented permissions:\n');
    for (const p of manifest.permissions) io.out(`    - ${p}\n`);
  }
  return 0;
}

/**
 * Default consent resolver — refuses non-interactively. The CLI replaces
 * this with the Ink consent UI (`runPluginConsentUI`) or a `() => true`
 * shim when `--yes` is supplied. Importing the Ink component eagerly
 * here would pull React into pure-CLI test paths.
 */
async function requireConsent(): Promise<boolean> {
  return false;
}

/** `declaragent plugin list` — prints id, version, dir, install timestamp. */
export async function pluginList(options: PluginCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const store = getStore(options);
  const entries = await store.list();
  if (entries.length === 0) {
    io.out('no plugins installed.\n');
    return 0;
  }
  io.out(`installed plugins (${entries.length}):\n`);
  for (const e of entries) {
    io.out(`  ${e.name}@${e.version}\n`);
    io.out(`    dir: ${e.dir}\n`);
    io.out(`    installed: ${e.installedAt}\n`);
    if (e.consentedAt) {
      io.out(`    consented: ${e.consentedAt}\n`);
    }
  }
  return 0;
}

/** `declaragent plugin info <id>` — shows manifest contributions. */
export async function pluginInfo(
  pluginId: string,
  options: PluginCliOptions = {},
): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const store = getStore(options);
  const entry = await store.get(pluginId);
  if (!entry) {
    io.err(`✗ plugin "${pluginId}" not installed\n`);
    return 1;
  }
  let manifest: PluginManifest;
  try {
    manifest = await loadPluginManifest(entry.dir);
  } catch (err) {
    io.err(`✗ failed to read manifest at ${entry.dir}: ${(err as Error).message}\n`);
    return 1;
  }
  io.out(`${manifest.name}@${manifest.version}\n`);
  if (manifest.description) io.out(`  ${manifest.description}\n`);
  io.out(`  dir: ${entry.dir}\n`);
  io.out(`  installed: ${entry.installedAt}\n`);
  io.out('  contributes:\n');
  io.out(`    tools:      ${manifest.contributes.tools.length}\n`);
  io.out(`    skills:     ${manifest.contributes.skills.length}\n`);
  io.out(`    mcpServers: ${manifest.contributes.mcpServers.length}`);
  if (manifest.contributes.mcpServers.length > 0) {
    io.out(` (${manifest.contributes.mcpServers.map((s) => s.name).join(', ')})`);
  }
  io.out('\n');
  io.out(`    hooks:      ${manifest.contributes.hooks.length}\n`);
  io.out(`    commands:   ${manifest.contributes.commands.length}\n`);
  if (manifest.permissions.length > 0) {
    io.out('  permissions:\n');
    for (const p of manifest.permissions) io.out(`    - ${p}\n`);
  }
  return 0;
}

/** `declaragent plugin remove <id>` — removes from the store. */
export async function pluginRemove(
  pluginId: string,
  options: PluginCliOptions = {},
): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const store = getStore(options);
  const removed = await store.remove(pluginId);
  if (!removed) {
    io.err(`✗ plugin "${pluginId}" not installed\n`);
    return 1;
  }
  io.out(`✓ removed ${pluginId}\n`);
  return 0;
}

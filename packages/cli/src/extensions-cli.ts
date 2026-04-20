import { resolve } from 'node:path';
import {
  type PluginManifest,
  type PluginStore,
  createPluginStore,
  loadPluginManifest,
  loadSkills,
} from '@declaragent/core';
import { type MCPConfigStore, createMCPConfigStore } from './mcp-config.js';
import { mcpConfigPath, pluginStorePath, teamSkillsDir, userSkillsDir } from './paths.js';

export interface ExtensionsCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: ExtensionsCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

interface ExtensionsCliOptions {
  io?: ExtensionsCliIO;
  pluginStore?: PluginStore;
  mcpStore?: MCPConfigStore;
  userDir?: string;
  teamDir?: string;
}

/**
 * `declaragent extensions` — synthetic view of *configured* extensions
 * across every kind. Doesn't activate plugins or spawn MCP clients
 * (live status would require a running REPL).
 *
 * For live state inside a session, the in-REPL `/extensions` slash command
 * (added once the REPL wires plugin loading at boot) reflects the actual
 * `ExtensionRegistry`.
 */
export async function extensionsList(options: ExtensionsCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const pluginStore = options.pluginStore ?? createPluginStore(pluginStorePath());
  const mcpStore = options.mcpStore ?? createMCPConfigStore(mcpConfigPath());

  const installed = await pluginStore.list();
  const manifests = await Promise.all(
    installed.map(async (e) => {
      try {
        return { entry: e, manifest: await loadPluginManifest(e.dir) };
      } catch {
        return { entry: e, manifest: undefined };
      }
    }),
  );

  const skillSources: Array<Parameters<typeof loadSkills>[0]['sources'][number]> = [
    { tier: { type: 'user' }, dir: options.userDir ?? userSkillsDir() },
    {
      tier: { type: 'team', path: options.teamDir ?? teamSkillsDir() },
      dir: options.teamDir ?? teamSkillsDir(),
    },
  ];
  for (const { entry, manifest } of manifests) {
    if (!manifest) continue;
    for (const skillsDir of manifest.contributes.skills) {
      skillSources.push({
        tier: {
          type: 'plugin',
          pluginId: manifest.name,
          pluginVersion: manifest.version,
        },
        dir: resolve(entry.dir, skillsDir),
      });
    }
  }
  const skillResult = await loadSkills({ sources: skillSources });

  // ── Plugins ───────────────────────────────────────────────────────────
  io.out(`plugins (${installed.length}):\n`);
  if (installed.length === 0) io.out('  (none)\n');
  for (const e of installed) io.out(`  ${e.name}@${e.version}\n`);

  // ── MCP servers (user-configured + plugin-contributed) ────────────────
  const userMcp = await mcpStore.list();
  const pluginMcp: Array<{ name: string; pluginId: string }> = [];
  for (const { manifest } of manifests) {
    if (!manifest) continue;
    for (const s of manifest.contributes.mcpServers) {
      pluginMcp.push({ name: s.name, pluginId: manifest.name });
    }
  }
  io.out(`\nmcp servers (${userMcp.length + pluginMcp.length}):\n`);
  for (const s of userMcp) io.out(`  ${s.name}  [user]\n`);
  for (const s of pluginMcp) io.out(`  ${s.name}  [plugin ${s.pluginId}]\n`);
  if (userMcp.length + pluginMcp.length === 0) io.out('  (none)\n');

  // ── Skills (with precedence already resolved by loadSkills) ───────────
  io.out(`\nskills (${skillResult.skills.length}):\n`);
  if (skillResult.skills.length === 0) io.out('  (none)\n');
  for (const s of skillResult.skills) {
    io.out(`  ${s.lookupName}  [${s.tier.type}]\n`);
  }

  // ── Hooks/Commands (declared by plugins; counts only) ─────────────────
  let hookCount = 0;
  let commandCount = 0;
  for (const { manifest } of manifests) {
    if (!manifest) continue;
    hookCount += manifest.contributes.hooks.length;
    commandCount += manifest.contributes.commands.length;
  }
  io.out(`\nhook modules declared by plugins: ${hookCount}\n`);
  io.out(`command modules declared by plugins: ${commandCount}\n`);

  return 0;
}

/** Helper for unit tests / `info` commands that need the loaded manifests. */
export type LoadedPlugin = {
  entry: Awaited<ReturnType<PluginStore['list']>>[number];
  manifest: PluginManifest | undefined;
};

import { resolve } from 'node:path';
import {
  type PluginManifest,
  type PluginStore,
  type Skill,
  type SkillSourceLocation,
  createPluginStore,
  loadPluginManifest,
  loadSkills,
} from '@declaragent/core';
import { pluginStorePath, teamSkillsDir, userSkillsDir } from './paths.js';

export interface SkillCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: SkillCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

interface SkillCliOptions {
  io?: SkillCliIO;
  store?: PluginStore;
  /** Override search paths (used by tests). */
  userDir?: string;
  teamDir?: string;
}

/**
 * `declaragent skill list` — walks user, team, and every installed
 * plugin's skill dirs and prints what was found, marking the precedence
 * winner when names collide. Read-only: doesn't activate plugins or
 * spawn MCP clients.
 */
export async function skillList(options: SkillCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const store = options.store ?? createPluginStore(pluginStorePath());
  const sources = await buildSources(store, options);
  const result = await loadSkills({ sources });

  if (result.skills.length === 0 && result.errors.length === 0) {
    io.out('no skills found.\n');
    io.out(`  searched: ${sources.map((s) => s.dir).join(', ')}\n`);
    return 0;
  }

  io.out(`skills (${result.skills.length}):\n`);
  for (const s of result.skills) {
    io.out(`  ${s.lookupName}  (${formatTier(s)})\n`);
    io.out(`    ${s.frontmatter.description}\n`);
    io.out(`    ← ${s.filePath}\n`);
  }
  if (result.conflicts.length > 0) {
    io.out(`\nconflicts (${result.conflicts.length}):\n`);
    for (const c of result.conflicts) {
      io.out(`  ${c.lookupName} → ${c.chosen}\n`);
      for (const sh of c.shadowed) io.out(`    shadowed: ${sh}\n`);
    }
  }
  if (result.errors.length > 0) {
    io.out(`\nload errors (${result.errors.length}):\n`);
    for (const e of result.errors) {
      io.out(`  ${e.filePath}: ${e.error.message}\n`);
    }
  }
  return 0;
}

async function buildSources(
  store: PluginStore,
  options: SkillCliOptions,
): Promise<SkillSourceLocation[]> {
  const sources: SkillSourceLocation[] = [
    { tier: { type: 'user' }, dir: options.userDir ?? userSkillsDir() },
    {
      tier: { type: 'team', path: options.teamDir ?? teamSkillsDir() },
      dir: options.teamDir ?? teamSkillsDir(),
    },
  ];
  const installed = await store.list();
  for (const entry of installed) {
    let manifest: PluginManifest;
    try {
      manifest = await loadPluginManifest(entry.dir);
    } catch {
      continue;
    }
    for (const skillsDir of manifest.contributes.skills) {
      sources.push({
        tier: {
          type: 'plugin',
          pluginId: manifest.name,
          pluginVersion: manifest.version,
        },
        dir: resolve(entry.dir, skillsDir),
      });
    }
  }
  return sources;
}

function formatTier(s: Skill): string {
  switch (s.tier.type) {
    case 'user':
      return 'user';
    case 'team':
      return 'team';
    case 'plugin':
      return `plugin ${s.tier.pluginId}@${s.tier.pluginVersion}`;
    case 'built-in':
      return 'built-in';
  }
}

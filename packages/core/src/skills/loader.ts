import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ExtensionDescriptor } from '../extension/types.js';
import type { Logger } from '../types/logger.js';
import { parseSkillFrontmatter } from './frontmatter.js';
import type { Skill, SkillSourceLocation, SkillTier } from './types.js';

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

export interface LoadSkillsOptions {
  /**
   * Source locations in precedence order — highest first. The loader walks
   * each in turn; the first entry that defines a given lookup name wins,
   * subsequent definitions are recorded as conflicts.
   *
   * Recommended order: user → team → built-in. Plugin tiers can appear
   * anywhere — plugin skills are namespaced (`<plugin>:name`) so they
   * never shadow unqualified user/team skills.
   */
  sources: readonly SkillSourceLocation[];
  logger?: Logger;
}

export interface SkillLoadResult {
  skills: readonly Skill[];
  /** Per-file load errors (bad YAML, missing fields). Loader continues past these. */
  errors: ReadonlyArray<{ filePath: string; error: Error }>;
  /** Lookup-name collisions; the chosen skill wins, others are shadowed. */
  conflicts: ReadonlyArray<{ lookupName: string; chosen: string; shadowed: readonly string[] }>;
}

/**
 * Walk every source dir for `*.md` files, parse each one, and resolve
 * lookup-name collisions. Plugin skills are namespaced so they only
 * conflict with other plugins of the same id.
 */
export async function loadSkills(options: LoadSkillsOptions): Promise<SkillLoadResult> {
  const logger = options.logger ?? NOOP_LOGGER;
  const all: Skill[] = [];
  const errors: Array<{ filePath: string; error: Error }> = [];
  for (const source of options.sources) {
    const entries = await readSkillFiles(source.dir);
    for (const filePath of entries) {
      try {
        const skill = await loadOneSkill(filePath, source.tier);
        all.push(skill);
      } catch (err) {
        errors.push({ filePath, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
  }

  const byLookup = new Map<string, Skill[]>();
  for (const s of all) {
    const arr = byLookup.get(s.lookupName) ?? [];
    arr.push(s);
    byLookup.set(s.lookupName, arr);
  }

  const skills: Skill[] = [];
  const conflicts: Array<{ lookupName: string; chosen: string; shadowed: readonly string[] }> = [];
  for (const [lookupName, group] of byLookup) {
    if (group.length === 1 && group[0]) {
      skills.push(group[0]);
      continue;
    }
    const chosen = group[0];
    if (!chosen) continue;
    skills.push(chosen);
    const shadowed = group.slice(1).map((s) => s.filePath);
    conflicts.push({ lookupName, chosen: chosen.filePath, shadowed });
    logger.warn('skill.conflict', {
      lookupName,
      chosen: chosen.filePath,
      shadowed,
    });
  }

  return { skills, errors, conflicts };
}

async function readSkillFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Missing directories are not fatal — common when a tier hasn't been
    // populated yet (e.g. fresh install with no team skills).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out.sort();
}

async function loadOneSkill(filePath: string, tier: SkillTier): Promise<Skill> {
  const raw = await fs.readFile(filePath, 'utf-8');
  const { frontmatter, body } = parseSkillFrontmatter(raw, filePath);
  const lookupName = computeLookupName(frontmatter.name, tier);
  const descriptor: ExtensionDescriptor & { kind: 'skill' } = {
    id: computeDescriptorId(frontmatter.name, tier),
    kind: 'skill',
    source: tierToSource(tier),
  };
  return {
    descriptor,
    lookupName,
    tier,
    frontmatter,
    prompt: body,
    filePath,
  };
}

function computeLookupName(name: string, tier: SkillTier): string {
  if (tier.type === 'plugin') return `${tier.pluginId}:${name}`;
  return name;
}

function computeDescriptorId(name: string, tier: SkillTier): string {
  switch (tier.type) {
    case 'user':
      return `skill:user:${name}`;
    case 'team':
      return `skill:team:${name}`;
    case 'plugin':
      return `skill:plugin:${tier.pluginId}:${name}`;
    case 'built-in':
      return `skill:built-in:${name}`;
  }
}

function tierToSource(tier: SkillTier): ExtensionDescriptor['source'] {
  switch (tier.type) {
    case 'user':
      return { type: 'user' };
    case 'team':
      return { type: 'team', path: tier.path };
    case 'plugin':
      return { type: 'plugin', pluginId: tier.pluginId, pluginVersion: tier.pluginVersion };
    case 'built-in':
      return { type: 'built-in' };
  }
}

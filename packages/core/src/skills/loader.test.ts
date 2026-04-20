import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSkills } from './loader.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'declaragent-skills-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeSkill(dir: string, file: string, body: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const fp = path.join(dir, file);
  await fs.writeFile(fp, body, 'utf-8');
  return fp;
}

describe('loadSkills', () => {
  test('loads every *.md skill in each source dir', async () => {
    const userDir = path.join(tmpRoot, 'user');
    await writeSkill(userDir, 'a.md', '---\nname: a\ndescription: A\n---\nbody-a');
    await writeSkill(userDir, 'b.md', '---\nname: b\ndescription: B\n---\nbody-b');
    const result = await loadSkills({ sources: [{ tier: { type: 'user' }, dir: userDir }] });
    expect(result.skills.map((s) => s.frontmatter.name).sort()).toEqual(['a', 'b']);
    expect(result.skills.every((s) => s.tier.type === 'user')).toBe(true);
  });

  test('user beats team beats built-in for the same lookup name', async () => {
    const userDir = path.join(tmpRoot, 'user');
    const teamDir = path.join(tmpRoot, 'team');
    const biDir = path.join(tmpRoot, 'bi');
    const userPath = await writeSkill(
      userDir,
      'pr.md',
      '---\nname: pr-review\ndescription: user\n---\nuser-prompt',
    );
    const teamPath = await writeSkill(
      teamDir,
      'pr.md',
      '---\nname: pr-review\ndescription: team\n---\nteam-prompt',
    );
    const biPath = await writeSkill(
      biDir,
      'pr.md',
      '---\nname: pr-review\ndescription: built-in\n---\nbi-prompt',
    );

    const result = await loadSkills({
      sources: [
        { tier: { type: 'user' }, dir: userDir },
        { tier: { type: 'team', path: teamDir }, dir: teamDir },
        { tier: { type: 'built-in' }, dir: biDir },
      ],
    });

    expect(result.skills).toHaveLength(1);
    const winner = result.skills[0];
    expect(winner?.filePath).toBe(userPath);
    expect(winner?.frontmatter.description).toBe('user');

    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict?.lookupName).toBe('pr-review');
    expect(conflict?.chosen).toBe(userPath);
    expect(conflict?.shadowed).toEqual([teamPath, biPath]);
  });

  test('plugin skills are namespaced as <plugin-id>:<name> and never conflict with user/team', async () => {
    const userDir = path.join(tmpRoot, 'user');
    const pluginDir = path.join(tmpRoot, 'plugin');
    await writeSkill(userDir, 'pr.md', '---\nname: pr-review\ndescription: user\n---\nu');
    await writeSkill(pluginDir, 'pr.md', '---\nname: pr-review\ndescription: plug\n---\np');

    const result = await loadSkills({
      sources: [
        { tier: { type: 'user' }, dir: userDir },
        {
          tier: { type: 'plugin', pluginId: 'plugin-github', pluginVersion: '1.0.0' },
          dir: pluginDir,
        },
      ],
    });

    expect(result.skills).toHaveLength(2);
    const lookupNames = result.skills.map((s) => s.lookupName).sort();
    expect(lookupNames).toEqual(['plugin-github:pr-review', 'pr-review']);
    expect(result.conflicts).toEqual([]);
  });

  test('two plugins exporting the same name DO conflict (each ID is unique)', async () => {
    const aDir = path.join(tmpRoot, 'a');
    const bDir = path.join(tmpRoot, 'b');
    const aPath = await writeSkill(aDir, 'pr.md', '---\nname: pr-review\ndescription: a\n---\na');
    const bPath = await writeSkill(bDir, 'pr.md', '---\nname: pr-review\ndescription: b\n---\nb');

    const result = await loadSkills({
      sources: [
        { tier: { type: 'plugin', pluginId: 'plug-a', pluginVersion: '1.0.0' }, dir: aDir },
        { tier: { type: 'plugin', pluginId: 'plug-b', pluginVersion: '1.0.0' }, dir: bDir },
      ],
    });

    // Different lookup names — no conflict.
    expect(result.skills.map((s) => s.lookupName).sort()).toEqual([
      'plug-a:pr-review',
      'plug-b:pr-review',
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.skills.find((s) => s.lookupName === 'plug-a:pr-review')?.filePath).toBe(aPath);
    expect(result.skills.find((s) => s.lookupName === 'plug-b:pr-review')?.filePath).toBe(bPath);
  });

  test('missing source dir is not fatal', async () => {
    const result = await loadSkills({
      sources: [{ tier: { type: 'user' }, dir: path.join(tmpRoot, 'does-not-exist') }],
    });
    expect(result.skills).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('per-file parse errors are collected, other files still load', async () => {
    const userDir = path.join(tmpRoot, 'user');
    await writeSkill(userDir, 'good.md', '---\nname: g\ndescription: G\n---\nbody');
    await writeSkill(userDir, 'bad.md', 'no frontmatter');
    const result = await loadSkills({ sources: [{ tier: { type: 'user' }, dir: userDir }] });
    expect(result.skills.map((s) => s.frontmatter.name)).toEqual(['g']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.filePath.endsWith('bad.md')).toBe(true);
  });

  test('descriptor ids encode tier + name', async () => {
    const userDir = path.join(tmpRoot, 'user');
    await writeSkill(userDir, 'p.md', '---\nname: p\ndescription: D\n---\nb');
    const result = await loadSkills({ sources: [{ tier: { type: 'user' }, dir: userDir }] });
    expect(result.skills[0]?.descriptor.id).toBe('skill:user:p');
    expect(result.skills[0]?.descriptor.kind).toBe('skill');
    expect(result.skills[0]?.descriptor.source).toEqual({ type: 'user' });
  });
});

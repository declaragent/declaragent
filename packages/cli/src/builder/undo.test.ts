import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureHead, runGitRaw } from './git.js';
import { ProposalRegistry } from './proposals.js';
import { runUndo } from './undo.js';

async function initRepoWithSeed(root: string, file: string, contents: string): Promise<string> {
  writeFileSync(join(root, file), contents);
  await runGitRaw(root, ['init', '-b', 'main']);
  await runGitRaw(root, ['config', 'user.email', 'test@example.com']);
  await runGitRaw(root, ['config', 'user.name', 'Test']);
  // Disable commit signing for this throwaway repo. A host with a global
  // `commit.gpgsign=true` (but no usable key, or a key whose agent blocks
  // on a passphrase prompt) would otherwise either fail the commit — so
  // captureHead returns undefined — or hang past the test timeout. Mirrors
  // the `-c commit.gpgsign=false` the production `initRepo` already uses.
  await runGitRaw(root, ['config', 'commit.gpgsign', 'false']);
  await runGitRaw(root, ['add', '-A']);
  const commit = await runGitRaw(root, ['commit', '-m', 'seed', '--no-verify']);
  const head = await captureHead(root);
  if (!head) {
    throw new Error(
      `failed to capture head (commit exit ${commit.code}: ${commit.stderr.trim() || commit.stdout.trim()})`,
    );
  }
  return head;
}

async function canSpawnGit(): Promise<boolean> {
  const r = await runGitRaw(tmpdir(), ['--version']);
  return r.code === 0;
}

let GIT = false;

describe('runUndo', () => {
  let root: string;

  beforeEach(async () => {
    GIT = await canSpawnGit();
    root = mkdtempSync(join(tmpdir(), 'declara-undo-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns ok:false when no apply has landed', async () => {
    const reg = new ProposalRegistry();
    const res = await runUndo({ registry: reg, scopeRoot: root });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('nothing to undo');
  });

  test('returns ok:false when tree is not a git repo', async () => {
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({
      summary: 'x',
      steps: [{ kind: 'addSkill', description: 'x', payload: {} }],
    });
    reg.confirm(proposal.id);
    reg.markApplied(proposal.id, {
      gitHeadBefore: 'deadbeef',
      writes: [join(root, 'x.txt')],
      appliedAt: 1,
    });
    const res = await runUndo({ registry: reg, scopeRoot: root });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not a git repo');
  });

  test('returns ok:false when gitHeadBefore is undefined', async () => {
    if (!GIT) return;
    await initRepoWithSeed(root, 'seed.txt', 'v1\n');
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({
      summary: 'x',
      steps: [{ kind: 'addSkill', description: 'x', payload: {} }],
    });
    reg.confirm(proposal.id);
    reg.markApplied(proposal.id, {
      gitHeadBefore: undefined,
      writes: [join(root, 'seed.txt')],
      appliedAt: 1,
    });
    const res = await runUndo({ registry: reg, scopeRoot: root });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('no git HEAD');
  });

  // Spawns ~8 sequential git subprocesses (seed + checkout + a second
  // no-op undo). On a cold/slow CI runner that can edge past bun's 5s
  // default; give it explicit headroom so a slow spawn isn't read as a
  // hang. The gpgsign-disable in initRepoWithSeed removes the real hang.
  test('happy path: reverts file + clears lastApplied', async () => {
    if (!GIT) return;
    const head = await initRepoWithSeed(root, 'f.txt', 'original\n');
    writeFileSync(join(root, 'f.txt'), 'mutated\n');
    expect(readFileSync(join(root, 'f.txt'), 'utf-8')).toBe('mutated\n');

    const reg = new ProposalRegistry();
    const { proposal } = reg.register({
      summary: 'x',
      steps: [{ kind: 'addSkill', description: 'x', payload: {} }],
    });
    reg.confirm(proposal.id);
    reg.markApplied(proposal.id, {
      gitHeadBefore: head,
      writes: [join(root, 'f.txt')],
      appliedAt: 1,
    });

    const res = await runUndo({ registry: reg, scopeRoot: root });
    expect(res.ok).toBe(true);
    expect(res.reverted).toHaveLength(1);
    expect(readFileSync(join(root, 'f.txt'), 'utf-8')).toBe('original\n');
    // lastApplied cleared — a second undo must not walk further back.
    expect(reg.lastApplied()).toBeUndefined();
    const res2 = await runUndo({ registry: reg, scopeRoot: root });
    expect(res2.ok).toBe(false);
    expect(res2.message).toContain('nothing to undo');
  }, 20_000);

  test('ok:true but no revert when the apply had zero writes', async () => {
    if (!GIT) return;
    await initRepoWithSeed(root, 'f.txt', 'v1\n');
    const reg = new ProposalRegistry();
    const { proposal } = reg.register({
      summary: 'x',
      steps: [{ kind: 'addSkill', description: 'x', payload: {} }],
    });
    reg.confirm(proposal.id);
    reg.markApplied(proposal.id, { gitHeadBefore: 'whatever', writes: [], appliedAt: 1 });
    const res = await runUndo({ registry: reg, scopeRoot: root });
    expect(res.ok).toBe(true);
    expect(res.reverted).toEqual([]);
    expect(res.message).toContain('no writes');
  });
});

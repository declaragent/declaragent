import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureHead, initRepo, isGitRepo, revertPaths, runGitRaw } from './git.js';

async function canSpawnGit(): Promise<boolean> {
  const r = await runGitRaw(tmpdir(), ['--version']);
  return r.code === 0;
}

let GIT_AVAILABLE = false;
// Bun's test runner lets us do async top-level work in a `beforeAll`-ish
// way via the first beforeEach. We just cache the probe once.
async function ensureProbe(): Promise<void> {
  GIT_AVAILABLE = await canSpawnGit();
}

describe('isGitRepo', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-git-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns false for a fresh temp dir', () => {
    expect(isGitRepo(dir)).toBe(false);
  });

  test('returns true when .git exists in cwd', () => {
    mkdirSync(join(dir, '.git'));
    expect(isGitRepo(dir)).toBe(true);
  });

  test('returns true from a nested directory', () => {
    mkdirSync(join(dir, '.git'));
    const nested = join(dir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(isGitRepo(nested)).toBe(true);
  });
});

describe('captureHead / initRepo / revertPaths', () => {
  let dir: string;

  beforeEach(async () => {
    await ensureProbe();
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-git-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('captureHead returns undefined when not a git repo', async () => {
    expect(await captureHead(dir)).toBeUndefined();
  });

  test('initRepo creates a repo and captureHead returns a sha', async () => {
    if (!GIT_AVAILABLE) return;
    writeFileSync(join(dir, 'seed.txt'), 'hi\n');
    // Git requires a committer identity; supply one just for this tmp
    // repo so the test is independent of the dev's global config.
    await runGitRaw(dir, ['init', '-b', 'main']);
    await runGitRaw(dir, ['config', 'user.email', 'test@example.com']);
    await runGitRaw(dir, ['config', 'user.name', 'Test']);
    // Re-run initRepo to exercise the "already a repo" early-exit — it
    // should be a no-op and not throw.
    await initRepo(dir);
    // Commit manually so captureHead has something to return.
    await runGitRaw(dir, ['add', '-A']);
    await runGitRaw(dir, ['commit', '-m', 'seed', '--no-verify']);
    const head = await captureHead(dir);
    expect(head).toBeDefined();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  test('initRepo from a fresh dir creates repo + initial commit', async () => {
    if (!GIT_AVAILABLE) return;
    writeFileSync(join(dir, 'seed.txt'), 'hi\n');
    // Set committer identity via env so initRepo's inner commit works
    // regardless of the host's global git config.
    const prevName = process.env.GIT_AUTHOR_NAME;
    const prevEmail = process.env.GIT_AUTHOR_EMAIL;
    const prevCommitName = process.env.GIT_COMMITTER_NAME;
    const prevCommitEmail = process.env.GIT_COMMITTER_EMAIL;
    process.env.GIT_AUTHOR_NAME = 'Test';
    process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
    process.env.GIT_COMMITTER_NAME = 'Test';
    process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
    try {
      await initRepo(dir);
    } finally {
      process.env.GIT_AUTHOR_NAME = prevName;
      process.env.GIT_AUTHOR_EMAIL = prevEmail;
      process.env.GIT_COMMITTER_NAME = prevCommitName;
      process.env.GIT_COMMITTER_EMAIL = prevCommitEmail;
    }
    expect(isGitRepo(dir)).toBe(true);
    const head = await captureHead(dir);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  test('revertPaths restores a file to the captured head', async () => {
    if (!GIT_AVAILABLE) return;
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'original\n');
    await runGitRaw(dir, ['init', '-b', 'main']);
    await runGitRaw(dir, ['config', 'user.email', 'test@example.com']);
    await runGitRaw(dir, ['config', 'user.name', 'Test']);
    await runGitRaw(dir, ['add', '-A']);
    await runGitRaw(dir, ['commit', '-m', 'seed', '--no-verify']);
    const head = await captureHead(dir);
    expect(head).toBeDefined();

    writeFileSync(file, 'mutated\n');
    expect(readFileSync(file, 'utf-8')).toBe('mutated\n');

    // biome-ignore lint/style/noNonNullAssertion: guarded above
    await revertPaths(dir, head!, [file]);
    expect(readFileSync(file, 'utf-8')).toBe('original\n');
  });

  test('revertPaths is a no-op when paths is empty', async () => {
    if (!GIT_AVAILABLE) return;
    // No repo required — the early return short-circuits before any
    // git process is spawned.
    await revertPaths(dir, 'deadbeef', []);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});

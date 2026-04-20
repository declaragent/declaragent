/**
 * Git helpers used by the builder for HEAD-capture + scoped undo.
 *
 * Design per BUILDER_PLAN §5.3:
 *   - Capture `HEAD` before every `DeclaraApplyChange`.
 *   - `/undo` runs `git checkout <head> -- <scoped-paths>`.
 *   - If the working tree isn't a git repo, the builder offers to
 *     `git init` + create an initial snapshot. Users who decline get
 *     read-only builder tools until they change their mind.
 *
 * No `--force` / `reset --hard` / `push` here — the builder never
 * performs destructive git ops (§5.4).
 *
 * @since 0.2.0
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BuilderError } from './types.js';

export class GitUnavailableError extends BuilderError {
  constructor(detail: string) {
    super('E_BUILDER_GIT', `git operation failed: ${detail}`);
    this.name = 'GitUnavailableError';
  }
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * True iff any ancestor of `cwd` (or `cwd` itself) contains a `.git`
 * entry. We don't run `git rev-parse --is-inside-work-tree` — a plain
 * stat is faster and sufficient for our use.
 */
export function isGitRepo(cwd: string): boolean {
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitRunResult> {
  return new Promise((resolveFn) => {
    let stdout = '';
    let stderr = '';
    try {
      const child = spawn('git', args as string[], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on('close', (code) => {
        resolveFn({ stdout, stderr, code: code ?? 0 });
      });
      child.on('error', (err) => {
        resolveFn({ stdout, stderr: stderr + (err.message ?? String(err)), code: 127 });
      });
    } catch (err) {
      resolveFn({ stdout, stderr: err instanceof Error ? err.message : String(err), code: 127 });
    }
  });
}

/** Exposed for tests + the proposal flow. */
export async function runGitRaw(cwd: string, args: readonly string[]): Promise<GitRunResult> {
  return runGit(cwd, args);
}

/**
 * Resolve the current HEAD sha. Returns `undefined` when the directory
 * isn't a git repo yet OR when the repo has no commits (freshly-
 * initialised tree). Callers treat `undefined` as "no undo point yet."
 */
export async function captureHead(cwd: string): Promise<string | undefined> {
  if (!isGitRepo(cwd)) return undefined;
  const r = await runGit(cwd, ['rev-parse', 'HEAD']);
  if (r.code !== 0) return undefined;
  const sha = r.stdout.trim();
  return sha.length === 0 ? undefined : sha;
}

export interface InitRepoOptions {
  message?: string;
  /** Branch to create with `init -b`. Default "main" per modern git. */
  branch?: string;
}

/**
 * `git init` + `add -A` + initial commit. Idempotent — if the tree is
 * already a repo, returns without touching anything. If there is
 * nothing to commit (empty tree), skips the commit step. Throws
 * {@link GitUnavailableError} when git is missing or returns non-zero.
 */
export async function initRepo(cwd: string, options: InitRepoOptions = {}): Promise<void> {
  if (isGitRepo(cwd)) return;

  const branch = options.branch ?? 'main';
  const message = options.message ?? 'declaragent: initial snapshot before builder actions';

  const init = await runGit(cwd, ['init', '-b', branch]);
  if (init.code !== 0) {
    throw new GitUnavailableError(`git init failed: ${init.stderr.trim() || init.stdout.trim()}`);
  }

  const add = await runGit(cwd, ['add', '-A']);
  if (add.code !== 0) {
    throw new GitUnavailableError(`git add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }

  // Skip the commit when there's nothing staged — a common case when
  // the user invokes the builder in an empty scaffold directory.
  const status = await runGit(cwd, ['status', '--porcelain']);
  if (status.stdout.trim().length === 0) return;

  const commit = await runGit(cwd, [
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    message,
    '--no-verify',
  ]);
  if (commit.code !== 0) {
    throw new GitUnavailableError(
      `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    );
  }
}

/**
 * Revert `paths` to their contents at `head`. Scoped — only the listed
 * paths are touched; unrelated files keep their working-tree state.
 * No-op when `paths` is empty. Caller is responsible for passing
 * absolute paths (or paths relative to `cwd`).
 */
export async function revertPaths(
  cwd: string,
  head: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  const r = await runGit(cwd, ['checkout', head, '--', ...paths]);
  if (r.code !== 0) {
    throw new GitUnavailableError(
      `git checkout ${head} failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

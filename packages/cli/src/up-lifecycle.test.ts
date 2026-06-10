import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type UpState,
  clearUpState,
  drainWithDeadline,
  isAlive,
  openAgentLog,
  readUpState,
  reapStaleState,
  resolveDetachInvocation,
  resolveDrainDeadlineMs,
  rotatedAgentLogPath,
  upLogPath,
  upPidPath,
  upStatePath,
  writeUpState,
} from './up-lifecycle.js';

describe('resolveDrainDeadlineMs', () => {
  test('defaults to 15s when unset', () => {
    expect(resolveDrainDeadlineMs({})).toBe(15_000);
  });
  test('honors a valid override', () => {
    expect(resolveDrainDeadlineMs({ DECLARAGENT_DRAIN_DEADLINE_MS: '30000' })).toBe(30_000);
  });
  test('0 disables draining', () => {
    expect(resolveDrainDeadlineMs({ DECLARAGENT_DRAIN_DEADLINE_MS: '0' })).toBe(0);
  });
  test('invalid / negative → default', () => {
    expect(resolveDrainDeadlineMs({ DECLARAGENT_DRAIN_DEADLINE_MS: 'abc' })).toBe(15_000);
    expect(resolveDrainDeadlineMs({ DECLARAGENT_DRAIN_DEADLINE_MS: '-5' })).toBe(15_000);
  });
});

describe('drainWithDeadline', () => {
  test('returns "drained" when drain completes in time', async () => {
    const r = await drainWithDeadline(async () => {}, 1000);
    expect(r).toBe('drained');
  });
  test('returns "timeout" when drain exceeds the deadline', async () => {
    const r = await drainWithDeadline(() => new Promise<void>(() => {}), 20);
    expect(r).toBe('timeout');
  });
  test('returns "skipped" when deadline is 0 (draining disabled)', async () => {
    let ran = false;
    const r = await drainWithDeadline(async () => {
      ran = true;
    }, 0);
    expect(r).toBe('skipped');
    expect(ran).toBe(false);
  });
});

describe('resolveDetachInvocation', () => {
  test('interpreter launcher (bun) prepends the entry script', () => {
    const inv = resolveDetachInvocation({
      execPath: '/usr/local/bin/bun',
      argv: ['/usr/local/bin/bun', '/app/dist/index.js', 'up', '-d'],
      bunMain: '/app/dist/index.js',
    });
    expect(inv.launcher).toBe('/usr/local/bin/bun');
    expect(inv.scriptArgs).toEqual(['/app/dist/index.js']);
  });

  test('node interpreter also prepends the entry script', () => {
    const inv = resolveDetachInvocation({
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/app/dist/index.js', 'up'],
      bunMain: undefined,
    });
    expect(inv.scriptArgs).toEqual(['/app/dist/index.js']);
  });

  test('compiled binary launcher takes the subcommand directly (no script prefix)', () => {
    const inv = resolveDetachInvocation({
      execPath: '/usr/local/bin/declaragent',
      argv: ['/usr/local/bin/declaragent', 'up', '-d'],
      bunMain: '/somewhere/embedded',
    });
    expect(inv.launcher).toBe('/usr/local/bin/declaragent');
    expect(inv.scriptArgs).toEqual([]);
  });

  test('bun on Windows (bun.exe) is detected as an interpreter', () => {
    const inv = resolveDetachInvocation({
      execPath: 'C:\\tools\\bun.exe',
      argv: ['C:\\tools\\bun.exe', 'C:\\app\\index.js', 'up'],
      bunMain: 'C:\\app\\index.js',
    });
    expect(inv.scriptArgs).toEqual(['C:\\app\\index.js']);
  });
});

describe('up-lifecycle state R/W', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-up-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('readUpState returns null when no state file exists', () => {
    expect(readUpState(dir)).toBeNull();
  });

  test('writeUpState persists both state.json and up.pid', () => {
    const state: UpState = {
      version: 1,
      pid: 12345,
      startedAt: '2026-04-21T00:00:00.000Z',
      manifestPath: '/tmp/manifest.yaml',
      agents: [
        {
          id: 'pr-reviewer',
          path: '/tmp/pr-reviewer',
          sources: [{ type: 'webhook', id: 'inbox', summary: 'webhook /webhook/pr' }],
        },
      ],
    };
    writeUpState(state, dir);
    const raw = JSON.parse(readFileSync(upStatePath(dir), 'utf8')) as UpState;
    expect(raw.pid).toBe(12345);
    expect(raw.agents).toHaveLength(1);
    expect(readFileSync(upPidPath(dir), 'utf8').trim()).toBe('12345');
  });

  test('readUpState round-trips', () => {
    const state: UpState = {
      version: 1,
      pid: 999,
      startedAt: '2026-04-21T12:00:00.000Z',
      manifestPath: '/tmp/m.yaml',
      agents: [],
    };
    writeUpState(state, dir);
    expect(readUpState(dir)).toEqual(state);
  });

  test('clearUpState removes both files', () => {
    writeUpState(
      {
        version: 1,
        pid: 42,
        startedAt: '2026-04-21T00:00:00.000Z',
        manifestPath: '/x',
        agents: [],
      },
      dir,
    );
    clearUpState(dir);
    expect(readUpState(dir)).toBeNull();
  });

  test('reads a corrupt state file as null (vs throwing)', () => {
    writeFileSync(upStatePath(dir), '{ not json', 'utf8');
    expect(readUpState(dir)).toBeNull();
  });

  test('rejects a state file from a future version', () => {
    writeFileSync(upStatePath(dir), JSON.stringify({ version: 99, pid: 1 }), 'utf8');
    expect(readUpState(dir)).toBeNull();
  });

  // #44 — cliVersion threading. State files written pre-0.7.2 never
  // carried the field; readUpState MUST still accept them, and
  // writeUpState round-trips the new optional property.
  test('cliVersion round-trips when supplied (#44)', () => {
    const state: UpState = {
      version: 1,
      pid: 4242,
      cliVersion: '0.7.2-test',
      startedAt: '2026-04-23T00:00:00.000Z',
      manifestPath: '/tmp/m.yaml',
      agents: [],
    };
    writeUpState(state, dir);
    const read = readUpState(dir);
    expect(read?.cliVersion).toBe('0.7.2-test');
  });

  test('readUpState accepts legacy state files without cliVersion (#44)', () => {
    // Pre-0.7.2 `up` writers don't stamp cliVersion. The field is
    // optional so forward-compat reads must succeed.
    writeFileSync(
      upStatePath(dir),
      JSON.stringify({
        version: 1,
        pid: 7777,
        startedAt: '2026-04-20T00:00:00.000Z',
        manifestPath: '/tmp/m.yaml',
        agents: [],
      }),
      'utf8',
    );
    const state = readUpState(dir);
    expect(state?.pid).toBe(7777);
    expect(state?.cliVersion).toBeUndefined();
  });
});

describe('isAlive', () => {
  test('our own pid is alive', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test('a clearly-dead pid is not alive', () => {
    // pid 1 is init — always alive. Pick a large number well outside
    // the typical pid range, though macOS recycles so this is a
    // best-effort check. A loop would be flaky; one shot is fine.
    expect(isAlive(987654321)).toBe(false);
  });
});

describe('reapStaleState', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-up-reap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('keeps state when the recorded pid is still alive', () => {
    const state: UpState = {
      version: 1,
      pid: process.pid,
      startedAt: '2026-04-21T00:00:00.000Z',
      manifestPath: '/x',
      agents: [],
    };
    writeUpState(state, dir);
    const kept = reapStaleState(dir);
    expect(kept?.pid).toBe(process.pid);
  });

  test('clears state when the recorded pid is dead', () => {
    const state: UpState = {
      version: 1,
      pid: 987654321,
      startedAt: '2026-04-21T00:00:00.000Z',
      manifestPath: '/x',
      agents: [],
    };
    writeUpState(state, dir);
    const out = reapStaleState(dir);
    expect(out).toBeNull();
    expect(readUpState(dir)).toBeNull();
  });

  test('returns null + no-op when no state exists', () => {
    expect(reapStaleState(dir)).toBeNull();
  });
});

describe('openAgentLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-up-logs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes newline-delimited JSON and flushes on close', async () => {
    const logger = openAgentLog('pr-reviewer', dir);
    logger.write({ kind: 'webhook.received', path: '/webhook/pr' });
    logger.write({ kind: 'skill.dispatched', skill: 'review-pr' });
    logger.close();
    // Give the stream a tick to flush.
    await new Promise((r) => setTimeout(r, 20));
    const raw = readFileSync(upLogPath('pr-reviewer', dir), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(2);
    const first = JSON.parse(raw[0] ?? '{}') as {
      ts: string;
      agent: string;
      kind: string;
    };
    expect(first.agent).toBe('pr-reviewer');
    expect(first.kind).toBe('webhook.received');
    // Timestamp is ISO.
    expect(first.ts).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('sanitises unusual agent ids into a filesystem-safe filename', () => {
    const logger = openAgentLog('ACME/Weird Id', dir);
    logger.write({ kind: 'x' });
    logger.close();
    const path = upLogPath('ACME/Weird Id', dir);
    expect(path.endsWith('ACME_Weird_Id.log')).toBe(true);
  });

  test('write after close is a silent no-op', async () => {
    const logger = openAgentLog('x', dir);
    // `createWriteStream` opens the file asynchronously. Before we
    // close + rmSync the dir, spin-wait until the fd is actually open
    // (file exists on disk). A blind sleep was flaky on loaded CI
    // runners — see f648e96 (first attempt: 20ms) which still flaked
    // on PR #28's CI. Spinning to 1s covers even the slowest runner
    // while remaining fast on healthy boxes.
    const file = upLogPath('x', dir);
    const deadline = Date.now() + 1000;
    while (!existsSync(file) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    logger.close();
    // Should not throw.
    logger.write({ kind: 'late' });
    // Tiny tail tick so `end()` propagates before afterEach.
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('openAgentLog rotate() — POST_ENTERPRISE_BACKLOG.md #22', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-up-logs-rotate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function listLogFiles(agentId: string): string[] {
    const logsDir = join(dir, 'logs');
    if (!existsSync(logsDir)) return [];
    return readdirSync(logsDir)
      .filter((name) => name.startsWith(agentId))
      .sort();
  }

  test('rotatedAgentLogPath encodes ISO timestamp with `:` → `-`', () => {
    const path = rotatedAgentLogPath('a', new Date('2026-04-23T10:20:30.000Z'), dir);
    expect(path).toContain('a-2026-04-23T10-20-30.000Z.log');
    // Must live under the logs dir.
    expect(path.startsWith(join(dir, 'logs'))).toBe(true);
  });

  test('rotate() produces an archive + fresh active file', async () => {
    const agent = 'rotater';
    const logger = openAgentLog(agent, dir);
    logger.write({ kind: 'pre', n: 1 });
    logger.write({ kind: 'pre', n: 2 });
    // Settle the stream before rename (bun's createWriteStream opens async).
    const active = upLogPath(agent, dir);
    const deadline = Date.now() + 1000;
    while (!existsSync(active) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = await logger.rotate();
    expect(result.activePath).toBe(active);
    expect(result.archivedPath).not.toBe(active);
    expect(result.archivedPath).toContain(agent);
    expect(result.archivedPath).toMatch(/\.log$/);
    // Both files exist.
    expect(existsSync(result.archivedPath)).toBe(true);
    expect(existsSync(result.activePath)).toBe(true);
    // Archive holds the pre-rotation lines.
    const archiveContent = readFileSync(result.archivedPath, 'utf8').trim().split('\n');
    expect(archiveContent.length).toBe(2);
    // Fresh file starts empty (or only has post-rotate content).
    logger.write({ kind: 'post', n: 3 });
    logger.close();
    await new Promise((r) => setTimeout(r, 30));
    const active2 = readFileSync(active, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(active2.length).toBe(1);
    const parsed = JSON.parse(active2[0] ?? '{}') as { kind?: string; n?: number };
    expect(parsed.kind).toBe('post');
    expect(parsed.n).toBe(3);
    // Listing shows two files.
    const names = listLogFiles(agent);
    expect(names.length).toBe(2);
  });

  test('tail across rotation: reading the active file post-rotate sees post-rotate writes', async () => {
    const agent = 'tailer';
    const logger = openAgentLog(agent, dir);
    logger.write({ kind: 'pre' });
    const active = upLogPath(agent, dir);
    const deadline = Date.now() + 1000;
    while (!existsSync(active) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await logger.rotate();
    logger.write({ kind: 'post' });
    logger.close();
    await new Promise((r) => setTimeout(r, 30));
    const raw = readFileSync(active, 'utf8').trim();
    expect(raw).toContain('"post"');
    expect(raw).not.toContain('"pre"');
  });

  test('writes issued during rotation are buffered + flushed, not dropped', async () => {
    const agent = 'buffered';
    const logger = openAgentLog(agent, dir);
    logger.write({ kind: 'pre' });
    const active = upLogPath(agent, dir);
    const deadline = Date.now() + 1000;
    while (!existsSync(active) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Kick off rotation; before awaiting, issue writes from the same
    // microtask turn so they land while `rotating === true`.
    const rotatePromise = logger.rotate();
    logger.write({ kind: 'mid', n: 1 });
    logger.write({ kind: 'mid', n: 2 });
    const result = await rotatePromise;
    logger.close();
    await new Promise((r) => setTimeout(r, 30));
    const activeContent = readFileSync(result.activePath, 'utf8').trim().split('\n');
    // Both mid-rotation writes are present on the new file.
    expect(activeContent.length).toBe(2);
    const kinds = activeContent.map((l) => (JSON.parse(l) as { kind?: string }).kind);
    expect(kinds).toEqual(['mid', 'mid']);
    // Pre-rotation write lives on the archive.
    const archiveContent = readFileSync(result.archivedPath, 'utf8').trim().split('\n');
    expect(archiveContent.length).toBe(1);
    expect((JSON.parse(archiveContent[0] ?? '{}') as { kind?: string }).kind).toBe('pre');
  });

  test('rotate() throws when the logger is already closed', async () => {
    const logger = openAgentLog('closed', dir);
    const active = upLogPath('closed', dir);
    const deadline = Date.now() + 1000;
    while (!existsSync(active) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    logger.close();
    await new Promise((r) => setTimeout(r, 10));
    await expect(logger.rotate()).rejects.toThrow(/already closed/);
  });
});

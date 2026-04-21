import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type UpState,
  clearUpState,
  isAlive,
  openAgentLog,
  readUpState,
  reapStaleState,
  upLogPath,
  upPidPath,
  upStatePath,
  writeUpState,
} from './up-lifecycle.js';

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

  test('write after close is a silent no-op', () => {
    const logger = openAgentLog('x', dir);
    logger.close();
    // Should not throw.
    logger.write({ kind: 'late' });
  });
});

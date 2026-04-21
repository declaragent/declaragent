import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { down } from './down-cli.js';
import { logs } from './logs-cli.js';
import { ps } from './ps-cli.js';
import {
  type UpState,
  clearUpState,
  readUpState,
  upLogPath,
  writeUpState,
} from './up-lifecycle.js';

function captureIo(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

let homeOverride: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'declara-up-verbs-'));
  homeOverride = process.env.HOME;
  process.env.HOME = tmpHome;
});
afterEach(() => {
  if (homeOverride !== undefined) process.env.HOME = homeOverride;
  clearUpState();
  rmSync(tmpHome, { recursive: true, force: true });
});

function aliveState(overrides: Partial<UpState> = {}): UpState {
  return {
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    manifestPath: '/tmp/m.yaml',
    agents: [
      {
        id: 'pr-reviewer',
        path: '/tmp/pr-reviewer',
        sources: [{ type: 'webhook', id: 'inbox', summary: 'webhook /webhook/pr' }],
      },
    ],
    ...overrides,
  };
}

describe('down', () => {
  test('prints "nothing up" when no state is present', async () => {
    const cap = captureIo();
    const code = await down({ io: cap.io });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('nothing up');
  });

  test('reaps stale state when the recorded pid is dead', async () => {
    writeUpState(aliveState({ pid: 987654321 }));
    const cap = captureIo();
    const code = await down({ io: cap.io });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('nothing up');
    expect(readUpState()).toBeNull();
  });

  test('escalates to SIGKILL when SIGTERM is ignored + always clears state', async () => {
    // Use process.pid so reapStaleState() keeps the state (it's alive).
    // Mock kill so the real process isn't actually signaled.
    writeUpState(aliveState({ pid: process.pid }));
    const sent: Array<{ pid: number; signal: string }> = [];
    const code = await down({
      io: captureIo().io,
      kill: (pid, signal) => {
        sent.push({ pid, signal: String(signal) });
        // Do nothing — simulate a process that refuses SIGTERM so the
        // grace loop times out and escalates to SIGKILL.
      },
      pollIntervalMs: 5,
      graceMs: 30,
    });
    expect(code).toBe(0);
    expect(sent[0]?.signal).toBe('SIGTERM');
    expect(sent[1]?.signal).toBe('SIGKILL');
    expect(readUpState()).toBeNull();
  });
});

describe('ps', () => {
  test('prints "nothing up" when no state is present', async () => {
    const cap = captureIo();
    const code = await ps({ io: cap.io });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('nothing up');
  });

  test('renders a table of bound agents + sources', async () => {
    writeUpState(aliveState());
    const cap = captureIo();
    const code = await ps({ io: cap.io });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toContain('pr-reviewer');
    expect(text).toContain('webhook /webhook/pr');
    expect(text).toContain(`pid ${process.pid}`);
  });

  test('reaps stale state and shows "nothing up"', async () => {
    writeUpState(aliveState({ pid: 987654321 }));
    const cap = captureIo();
    const code = await ps({ io: cap.io });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('nothing up');
  });
});

describe('logs', () => {
  // Note: `os.homedir()` caches at process start, so overriding
  // `process.env.HOME` in `beforeEach` doesn't isolate these tests
  // from the real `~/.declaragent/logs/`. The assertions below use
  // unique agent ids + state snapshots that can coexist with whatever
  // else is on disk. A proper DI refactor (accept a config-dir
  // override on every up/down/ps/logs verb) is the long-term fix.

  test('tails the log file for every bound agent when no id supplied', async () => {
    writeUpState(aliveState());
    // Seed a log file so the tail has something to print.
    const logPath = upLogPath('pr-reviewer');
    appendFileSync(
      logPath,
      '{"ts":"2026-04-21T00:00:00.000Z","agent":"pr-reviewer","kind":"webhook.received"}\n',
    );
    const cap = captureIo();
    const code = await logs({}, { io: cap.io });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toContain('── pr-reviewer ──');
    expect(text).toContain('webhook.received');
  });

  test('errors when the supplied agent id has no log file on disk', async () => {
    writeUpState(aliveState());
    const cap = captureIo();
    const code = await logs({ agentId: 'no-such' }, { io: cap.io });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('no log file for "no-such"');
  });

  test('reads log files after `down` (post-mortem case)', async () => {
    // No state is present, but a log file exists on disk — logs
    // should still tail it so the user can diagnose post-shutdown.
    const logPath = upLogPath('archived-agent');
    appendFileSync(
      logPath,
      '{"ts":"2026-04-21T00:00:00.000Z","agent":"archived-agent","kind":"webhook.received"}\n',
    );
    const cap = captureIo();
    const code = await logs({ agentId: 'archived-agent' }, { io: cap.io });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('── archived-agent ──');
    expect(cap.out.join('')).toContain('webhook.received');
  });

  test('filters to the supplied agent id', async () => {
    const stateWithTwo = aliveState({
      agents: [
        {
          id: 'a',
          path: '/tmp/a',
          sources: [],
        },
        {
          id: 'b',
          path: '/tmp/b',
          sources: [],
        },
      ],
    });
    writeUpState(stateWithTwo);
    appendFileSync(upLogPath('a'), '{"ts":"t","agent":"a","kind":"k1"}\n');
    appendFileSync(upLogPath('b'), '{"ts":"t","agent":"b","kind":"k2"}\n');
    const cap = captureIo();
    const code = await logs({ agentId: 'b' }, { io: cap.io });
    expect(code).toBe(0);
    const text = cap.out.join('');
    expect(text).toContain('── b ──');
    expect(text).not.toContain('── a ──');
    expect(text).toContain('k2');
    expect(text).not.toContain('k1');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  StartAgentSourcesOptions,
  StartAgentSourcesResult,
  startAgentSources,
} from './run-agent-sources.js';
import { up } from './up-cli.js';

type StartSourcesFn = typeof startAgentSources;

interface SourcesStub {
  fn: StartSourcesFn;
  starts: Array<{ configPath: string }>;
  stopCount: () => number;
}

function stubSources(started: StartAgentSourcesResult['started'] = []): SourcesStub {
  const starts: Array<{ configPath: string }> = [];
  let stops = 0;
  const fn: StartSourcesFn = async (opts: StartAgentSourcesOptions) => {
    starts.push({ configPath: opts.configPath });
    return {
      started,
      unknownTypes: [],
      validationErrors: [],
      stop: async () => {
        stops += 1;
      },
    };
  };
  return { fn, starts, stopCount: () => stops };
}

function captureIo(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

/**
 * Wire a fake signal installer that trips the shutdown callback
 * immediately — the up-loop then returns cleanly without waiting for
 * a real SIGINT / SIGTERM.
 */
function immediateShutdown(): (onShutdown: () => Promise<void>) => () => void {
  return (onShutdown) => {
    void onShutdown();
    return () => {};
  };
}

const AGENT_YAML = `
name: test-up-agent
systemPrompt: |
  You are a test agent.
skills: []
`;

const EVENT_SOURCES = `- type: cron
  config:
    id: every-minute
    schedule: "* * * * *"
    target: { type: skill, name: say-hi }
`;

describe('up verb — single agent', () => {
  let dir: string;
  let configOverride: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-up-test-'));
    writeFileSync(join(dir, 'agent.yaml'), AGENT_YAML);
    // Redirect XDG_CONFIG-like paths so the tests don't write into
    // the user's real ~/.declaragent dir. Tests rely on configDir()
    // falling back to HOME; override via an env var.
    configOverride = process.env.HOME;
    process.env.HOME = dir;
  });
  afterEach(() => {
    if (configOverride !== undefined) process.env.HOME = configOverride;
    rmSync(dir, { recursive: true, force: true });
  });

  test('refuses when no manifest is in cwd', async () => {
    const other = mkdtempSync(join(tmpdir(), 'declara-up-empty-'));
    try {
      const cap = captureIo();
      const code = await up({}, { io: cap.io, cwd: other, installSignals: immediateShutdown() });
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no agent.yaml or fleet.yaml');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('brings up a skill-only agent (no event-sources.yaml) without calling startSources', async () => {
    const stub = stubSources();
    const cap = captureIo();
    const code = await up(
      {},
      {
        io: cap.io,
        cwd: dir,
        startSources: stub.fn,
        installSignals: immediateShutdown(),
      },
    );
    expect(code).toBe(0);
    expect(stub.starts).toHaveLength(0);
    const text = cap.out.join('');
    expect(text).toContain('test-up-agent');
    expect(text).toContain('skill-only');
    expect(text).toContain('✓ up');
    expect(text).toContain('✓ down');
  });

  test('starts event-sources when event-sources.yaml is present', async () => {
    writeFileSync(join(dir, 'event-sources.yaml'), EVENT_SOURCES);
    const stub = stubSources([{ type: 'cron', id: 'every-minute', summary: 'cron "* * * * *"' }]);
    const cap = captureIo();
    const code = await up(
      {},
      {
        io: cap.io,
        cwd: dir,
        startSources: stub.fn,
        installSignals: immediateShutdown(),
      },
    );
    expect(code).toBe(0);
    expect(stub.starts).toHaveLength(1);
    expect(stub.starts[0]?.configPath).toBe(join(dir, 'event-sources.yaml'));
    const text = cap.out.join('');
    expect(text).toContain('cron "* * * * *"');
    expect(text).toContain('1 agent bound');
  });

  test('invokes sources.stop() on shutdown', async () => {
    writeFileSync(join(dir, 'event-sources.yaml'), EVENT_SOURCES);
    const stub = stubSources([{ type: 'cron', id: 'every-minute', summary: 'cron "* * * * *"' }]);
    const cap = captureIo();
    await up(
      {},
      {
        io: cap.io,
        cwd: dir,
        startSources: stub.fn,
        installSignals: immediateShutdown(),
      },
    );
    expect(stub.stopCount()).toBe(1);
  });

  test('bails out cleanly when agent.yaml is invalid', async () => {
    // Write a broken schema.
    writeFileSync(join(dir, 'agent.yaml'), 'name: "unclosed-string\n');
    const cap = captureIo();
    const code = await up({}, { io: cap.io, cwd: dir, installSignals: immediateShutdown() });
    expect(code).toBe(1);
    expect(cap.err.join('')).not.toBe('');
  });

  test('respects an explicit -f manifest override', async () => {
    // Put the agent in a sibling dir so cwd has nothing.
    const altDir = mkdtempSync(join(tmpdir(), 'declara-up-alt-'));
    try {
      mkdirSync(join(altDir, 'agents/x'), { recursive: true });
      writeFileSync(join(altDir, 'agents/x/agent.yaml'), AGENT_YAML);
      const other = mkdtempSync(join(tmpdir(), 'declara-up-empty2-'));
      try {
        const cap = captureIo();
        const code = await up(
          { manifestPath: join(altDir, 'agents/x/agent.yaml') },
          {
            io: cap.io,
            cwd: other,
            startSources: stubSources().fn,
            installSignals: immediateShutdown(),
          },
        );
        expect(code).toBe(0);
        expect(cap.out.join('')).toContain('test-up-agent');
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from './run-agent-cli.js';
import type {
  StartAgentSourcesOptions,
  StartAgentSourcesResult,
  startAgentSources,
} from './run-agent-sources.js';

type StartSourcesFn = typeof startAgentSources;

interface Stub {
  fn: StartSourcesFn;
  calls: Array<{ configPath: string }>;
  stopCalls: () => number;
}

function stubStartSources(
  started: StartAgentSourcesResult['started'] = [],
  unknownTypes: StartAgentSourcesResult['unknownTypes'] = [],
): Stub {
  const calls: Array<{ configPath: string }> = [];
  let stops = 0;
  const fn: StartSourcesFn = async (opts: StartAgentSourcesOptions) => {
    calls.push({ configPath: opts.configPath });
    return {
      started,
      unknownTypes,
      validationErrors: [],
      stop: async () => {
        stops += 1;
      },
    };
  };
  return { fn, calls, stopCalls: () => stops };
}

function captureIo(): {
  out: string[];
  err: string[];
  cap: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, cap: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

const AGENT_YAML = `
name: acme-bot
model: claude-sonnet-4-5
systemPrompt: |
  You are Acme's assistant.
skills:
  - skills/hello.md
tools:
  defaults:
    - Read
`;

const SKILL = `---
name: hello
description: Say hello.
---
Greet the user.
`;

describe('runAgent', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-run-agent-'));
    writeFileSync(join(dir, 'agent.yaml'), AGENT_YAML);
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'skills', 'hello.md'), SKILL);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('loads the agent + prints a status banner on stdout', async () => {
    const io = captureIo();
    const code = await runAgent({ dir }, io.cap);
    expect(code).toBe(0);
    const text = io.out.join('');
    expect(text).toContain('running acme-bot');
    expect(text).toContain(`from ${dir}`);
    expect(text).toContain('model:  claude-sonnet-4-5');
    expect(text).toContain('skills: 1 loaded (hello)');
    expect(text).toContain('tools:  declared defaults = Read');
  });

  test('errors cleanly when the dir does not exist', async () => {
    const io = captureIo();
    const code = await runAgent({ dir: '/tmp/definitely-not-there-xyz' }, io.cap);
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('no directory at');
  });

  test('errors cleanly when agent.yaml is missing', async () => {
    rmSync(join(dir, 'agent.yaml'));
    const io = captureIo();
    const code = await runAgent({ dir }, io.cap);
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('no agent.yaml');
  });

  test('invokes the injected renderRepl with composed agentSpec', async () => {
    const io = captureIo();
    let receivedSpec: unknown;
    let receivedLabel: string | undefined;
    await runAgent(
      { dir },
      {
        ...io.cap,
        renderRepl: (props) => {
          receivedSpec = props.agentSpec;
          receivedLabel = props.agentLabel;
        },
      },
    );
    expect(receivedLabel).toBe('acme-bot');
    const spec = receivedSpec as { name: string; systemPrompt: string };
    expect(spec.name).toBe('acme-bot');
    // Skill body should have been appended into the system prompt.
    expect(spec.systemPrompt).toContain('# Available skills');
    expect(spec.systemPrompt).toContain('Greet the user.');
  });

  test('ignores event-sources.yaml when --no-sources is set', async () => {
    writeFileSync(
      join(dir, 'event-sources.yaml'),
      '- type: cron\n  config:\n    id: x\n    schedule: "0 9 * * *"\n    target: { kind: skill, name: y }\n',
    );
    const io = captureIo();
    const stub = stubStartSources();
    await runAgent({ dir, noSources: true }, { ...io.cap, startSources: stub.fn });
    expect(stub.calls).toHaveLength(0);
    expect(io.out.join('')).toContain('sources: disabled (--no-sources)');
  });

  test('starts sources when event-sources.yaml is present', async () => {
    const eventsPath = join(dir, 'event-sources.yaml');
    writeFileSync(
      eventsPath,
      '- type: cron\n  config:\n    id: ping\n    schedule: "0 9 * * *"\n    target: { kind: skill, name: hello }\n',
    );
    const io = captureIo();
    const stub = stubStartSources([{ type: 'cron', id: 'ping', summary: 'cron "0 9 * * *"' }]);
    await runAgent({ dir }, { ...io.cap, startSources: stub.fn });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.configPath).toBe(eventsPath);
    const text = io.out.join('');
    expect(text).toContain('sources: 1 active');
    expect(text).toContain('cron "0 9 * * *"');
  });

  test('reports "no event-sources.yaml" when the file is absent', async () => {
    const io = captureIo();
    const stub = stubStartSources();
    await runAgent({ dir }, { ...io.cap, startSources: stub.fn });
    expect(stub.calls).toHaveLength(0);
    expect(io.out.join('')).toContain('no event-sources.yaml at the scope root');
  });

  test('stops sources after renderRepl returns', async () => {
    writeFileSync(
      join(dir, 'event-sources.yaml'),
      '- type: cron\n  config:\n    id: x\n    schedule: "0 9 * * *"\n    target: { kind: skill, name: y }\n',
    );
    const io = captureIo();
    const stub = stubStartSources([{ type: 'cron', id: 'x', summary: 'cron "0 9 * * *"' }]);
    await runAgent(
      { dir },
      {
        ...io.cap,
        startSources: stub.fn,
        renderRepl: async () => {
          // simulate a quick REPL session
        },
      },
    );
    expect(stub.stopCalls()).toBe(1);
  });

  test('bails with exit code 1 when source startup throws', async () => {
    writeFileSync(
      join(dir, 'event-sources.yaml'),
      '- type: cron\n  config:\n    id: x\n    schedule: "0 9 * * *"\n    target: { kind: skill, name: y }\n',
    );
    const io = captureIo();
    const boom: StartSourcesFn = async () => {
      throw new Error('port 7777 already bound');
    };
    const code = await runAgent({ dir }, { ...io.cap, startSources: boom as StartSourcesFn });
    expect(code).toBe(1);
    expect(io.err.join('')).toContain('could not start event sources');
    expect(io.err.join('')).toContain('port 7777');
  });

  test('defaults dir to cwd when omitted', async () => {
    // Use injected cwd rather than real chdir — macOS /var/folders
    // vs /private/var/folders symlink resolution breaks exact path
    // comparison, but the deps.cwd path is symlink-agnostic.
    const io = captureIo();
    const code = await runAgent({}, { ...io.cap, cwd: dir });
    expect(code).toBe(0);
    expect(io.out.join('')).toContain('running acme-bot');
  });
});

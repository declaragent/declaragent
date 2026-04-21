import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from './run-agent-cli.js';

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

  test('honours --no-sources flag by suppressing the "not wired" hint', async () => {
    const io = captureIo();
    await runAgent({ dir, noSources: true }, io.cap);
    expect(io.out.join('')).not.toContain('not wired in this release');
  });

  test('prints a deprecation-style hint when sources are declared but not wired', async () => {
    const io = captureIo();
    await runAgent({ dir }, io.cap);
    expect(io.out.join('')).toContain('event-sources.yaml is not wired');
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

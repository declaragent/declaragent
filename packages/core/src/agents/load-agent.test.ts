import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentConfigError, composeSystemPromptWithSkills, loadAgent } from './load-agent.js';

const AGENT_YAML = `
name: acme-bot
model: claude-sonnet-4-5
temperature: 0.2
maxTokens: 2048
subagentDepthCap: 2
systemPrompt: |
  You are Acme's assistant.
skills:
  - skills/hello.md
tools:
  defaults:
    - Read
    - Grep
`;

const SKILL_FILE = `---
name: hello
description: Say hello.
---
Greet the user warmly.
`;

describe('loadAgent', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-load-agent-'));
    writeFileSync(join(dir, 'agent.yaml'), AGENT_YAML);
    mkdirSync(join(dir, 'skills'));
    writeFileSync(join(dir, 'skills', 'hello.md'), SKILL_FILE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('loads a valid agent + skill', async () => {
    const loaded = await loadAgent({ agentDir: dir });
    expect(loaded.spec.name).toBe('acme-bot');
    expect(loaded.spec.model).toBe('claude-sonnet-4-5');
    expect(loaded.spec.temperature).toBe(0.2);
    expect(loaded.spec.maxTokens).toBe(2048);
    expect(loaded.spec.subagentDepthCap).toBe(2);
    expect(loaded.spec.systemPrompt).toContain("Acme's assistant");
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0]?.lookupName).toBe('hello');
    expect(loaded.toolNames).toEqual(['Read', 'Grep']);
    expect(loaded.agentDir).toBe(dir);
    expect(loaded.skillConflicts).toEqual([]);
  });

  test('returns an empty skills array when skills/ is empty or missing', async () => {
    rmSync(join(dir, 'skills'), { recursive: true });
    const loaded = await loadAgent({ agentDir: dir });
    expect(loaded.skills).toEqual([]);
  });

  test('rejects when agent.yaml is missing', async () => {
    rmSync(join(dir, 'agent.yaml'));
    await expect(loadAgent({ agentDir: dir })).rejects.toBeInstanceOf(AgentConfigError);
    await expect(loadAgent({ agentDir: dir })).rejects.toThrow(/no agent\.yaml/);
  });

  test('rejects on malformed yaml', async () => {
    writeFileSync(join(dir, 'agent.yaml'), ':\nnot: valid:\n  - also:: bad\n');
    await expect(loadAgent({ agentDir: dir })).rejects.toBeInstanceOf(AgentConfigError);
  });

  test('rejects when required fields are missing', async () => {
    writeFileSync(join(dir, 'agent.yaml'), 'name: x\nmodel: y\n');
    await expect(loadAgent({ agentDir: dir })).rejects.toThrow(/systemPrompt/);
  });

  test('passthrough keeps forward-compat keys without erroring', async () => {
    writeFileSync(
      join(dir, 'agent.yaml'),
      `${AGENT_YAML}\nchannels:\n  - slack\nsources:\n  - webhook\nfutureKey:\n  someValue: 42\n`,
    );
    const loaded = await loadAgent({ agentDir: dir });
    expect(loaded.spec.name).toBe('acme-bot');
  });

  test('propagates skill frontmatter errors with the file path', async () => {
    writeFileSync(join(dir, 'skills', 'broken.md'), '---\nno-required-fields: true\n---\nbody\n');
    await expect(loadAgent({ agentDir: dir })).rejects.toThrow(/broken\.md/);
  });

  test('accepts a relative agentDir, resolves to absolute', async () => {
    // cd into parent of `dir` and pass the basename. macOS /var/folders
    // symlinks to /private/var/folders, so `realpath` both sides for
    // the equality check.
    const { realpathSync } = await import('node:fs');
    const parent = dir.substring(0, dir.lastIndexOf('/'));
    const base = dir.substring(dir.lastIndexOf('/') + 1);
    const prevCwd = process.cwd();
    process.chdir(parent);
    try {
      const loaded = await loadAgent({ agentDir: base });
      expect(realpathSync(loaded.agentDir)).toBe(realpathSync(dir));
    } finally {
      process.chdir(prevCwd);
    }
  });

  test('toolNames is empty when tools.defaults is absent', async () => {
    writeFileSync(join(dir, 'agent.yaml'), 'name: x\nmodel: y\nsystemPrompt: z\n');
    const loaded = await loadAgent({ agentDir: dir });
    expect(loaded.toolNames).toEqual([]);
  });
});

describe('composeSystemPromptWithSkills', () => {
  test('returns prompt unchanged when no skills', () => {
    expect(composeSystemPromptWithSkills('base', [])).toBe('base');
  });

  test('appends skills in an "# Available skills" section', () => {
    const out = composeSystemPromptWithSkills('Base prompt.', [
      {
        descriptor: { kind: 'skill', source: 'user', id: 'hello' } as never,
        lookupName: 'hello',
        tier: { type: 'user' } as never,
        frontmatter: { name: 'hello', description: 'Say hi.' } as never,
        prompt: 'Greet warmly.',
        filePath: '/x/skills/hello.md',
      },
      {
        descriptor: { kind: 'skill', source: 'user', id: 'bye' } as never,
        lookupName: 'bye',
        tier: { type: 'user' } as never,
        frontmatter: { name: 'bye', description: 'Say goodbye.' } as never,
        prompt: 'End politely.',
        filePath: '/x/skills/bye.md',
      },
    ]);
    expect(out).toContain('# Available skills');
    expect(out).toContain('## hello');
    expect(out).toContain('Say hi.');
    expect(out).toContain('Greet warmly.');
    expect(out).toContain('## bye');
  });
});

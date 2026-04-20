import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFrontmatter } from '@declaragent/core';
import { appendSkillToAgentYaml, createAddSkillTool, runAddSkill } from './add-skill.js';
import {
  BuilderConflictError,
  BuilderScopeError,
  BuilderSecretLeakError,
  BuilderValidationError,
} from './types.js';

const AGENT_YAML = `# concierge agent — keep questions short
name: concierge
model: claude-sonnet-4-5
systemPrompt: |
  You are a concierge.
skills:
  - skills/intro.md
tools:
  defaults:
    - Read
    - Grep
`;

describe('runAddSkill', () => {
  let dir: string;
  let agentRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-add-skill-'));
    agentRoot = dir;
    writeFileSync(join(agentRoot, 'agent.yaml'), AGENT_YAML);
    mkdirSync(join(agentRoot, 'skills'));
    writeFileSync(
      join(agentRoot, 'skills', 'intro.md'),
      '---\nname: intro\ndescription: say hi\n---\n\nHi.\n',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes a new skill file with valid frontmatter', async () => {
    const out = await runAddSkill(
      {
        name: 'pr-review',
        description: 'Review a PR given a URL.',
        body: 'Review the PR at {{url}} and report blockers.',
      },
      { scopeRoot: agentRoot },
    );
    expect(out.ok).toBe(true);
    expect(out.skillPath).toBe(join(agentRoot, 'skills', 'pr-review.md'));

    const written = readFileSync(out.skillPath, 'utf-8');
    const parsed = parseSkillFrontmatter(written, out.skillPath);
    expect(parsed.frontmatter.name).toBe('pr-review');
    expect(parsed.frontmatter.description).toBe('Review a PR given a URL.');
    expect(parsed.body).toContain('Review the PR at {{url}}');
  });

  test('appends the skill ref to agent.yaml preserving comments', async () => {
    await runAddSkill(
      {
        name: 'pr-review',
        description: 'Review a PR.',
        body: 'body',
      },
      { scopeRoot: agentRoot },
    );
    const updated = readFileSync(join(agentRoot, 'agent.yaml'), 'utf-8');
    expect(updated).toContain('# concierge agent — keep questions short');
    expect(updated).toContain('- skills/intro.md');
    expect(updated).toContain('- skills/pr-review.md');
    // The tools block + its contents must survive.
    expect(updated).toMatch(/tools:\s*\n\s+defaults:/);
  });

  test('reports agentYamlUpdated false when addToAgentYaml is false', async () => {
    const out = await runAddSkill(
      {
        name: 'pr-review',
        description: 'Review a PR.',
        body: 'body',
        addToAgentYaml: false,
      },
      { scopeRoot: agentRoot },
    );
    expect(out.agentYamlUpdated).toBe(false);
    expect(out.writes).toHaveLength(1);
    const updated = readFileSync(join(agentRoot, 'agent.yaml'), 'utf-8');
    expect(updated).not.toContain('pr-review');
  });

  test('is idempotent on the agent.yaml side when the ref already exists', async () => {
    // Pre-write the skill file so only the yaml edit is exercised.
    writeFileSync(
      join(agentRoot, 'skills', 'pr-review.md'),
      '---\nname: pr-review\ndescription: x\n---\n\nbody\n',
    );
    // Pre-add the ref to agent.yaml.
    const before = readFileSync(join(agentRoot, 'agent.yaml'), 'utf-8').replace(
      '- skills/intro.md',
      '- skills/intro.md\n  - skills/pr-review.md',
    );
    writeFileSync(join(agentRoot, 'agent.yaml'), before);

    const res = await appendSkillToAgentYaml(join(agentRoot, 'agent.yaml'), 'skills/pr-review.md');
    expect(res.changed).toBe(false);
  });

  test('rejects a duplicate skill file', async () => {
    writeFileSync(
      join(agentRoot, 'skills', 'pr-review.md'),
      '---\nname: pr-review\ndescription: x\n---\n\nbody\n',
    );
    await expect(
      runAddSkill({ name: 'pr-review', description: 'x', body: 'body' }, { scopeRoot: agentRoot }),
    ).rejects.toBeInstanceOf(BuilderConflictError);
  });

  test('rejects a body that contains a GitHub PAT', async () => {
    await expect(
      runAddSkill(
        {
          name: 'leaky',
          description: 'x',
          body: `Use this token: ghp_${'a'.repeat(36)}`,
        },
        { scopeRoot: agentRoot },
      ),
    ).rejects.toBeInstanceOf(BuilderSecretLeakError);
  });

  test('rejects a body that contains a Slack token', async () => {
    await expect(
      runAddSkill(
        {
          name: 'leaky',
          description: 'x',
          body: `xoxb-${'1234567890-'.repeat(3)}abcdefgh`,
        },
        { scopeRoot: agentRoot },
      ),
    ).rejects.toBeInstanceOf(BuilderSecretLeakError);
  });

  test('rejects when agentPath has no agent.yaml', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'declara-empty-agent-'));
    try {
      await expect(
        runAddSkill({ name: 'x', description: 'x', body: 'body' }, { scopeRoot: empty }),
      ).rejects.toBeInstanceOf(BuilderValidationError);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('refuses an agentPath outside the scope without confirmOutsideScope', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'declara-sibling-'));
    try {
      writeFileSync(join(sibling, 'agent.yaml'), 'name: s\n');
      await expect(
        runAddSkill(
          {
            name: 'x',
            description: 'x',
            body: 'body',
            agentPath: sibling,
          },
          { scopeRoot: agentRoot },
        ),
      ).rejects.toBeInstanceOf(BuilderScopeError);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('permits an out-of-scope agentPath with confirmOutsideScope: true', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'declara-sibling-ok-'));
    try {
      writeFileSync(join(sibling, 'agent.yaml'), 'name: s\nskills: []\n');
      mkdirSync(join(sibling, 'skills'));
      const out = await runAddSkill(
        {
          name: 'x',
          description: 'x',
          body: 'body',
          agentPath: sibling,
          confirmOutsideScope: true,
        },
        { scopeRoot: agentRoot },
      );
      expect(out.skillPath).toBe(join(sibling, 'skills', 'x.md'));
      expect(existsSync(out.skillPath)).toBe(true);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('creates a skills/ directory when it is missing', async () => {
    // Fresh agent dir without a pre-existing skills/ folder.
    const fresh = mkdtempSync(join(tmpdir(), 'declara-fresh-'));
    try {
      writeFileSync(join(fresh, 'agent.yaml'), 'name: f\n');
      const out = await runAddSkill(
        { name: 'hello', description: 'd', body: 'b' },
        { scopeRoot: fresh },
      );
      expect(existsSync(join(fresh, 'skills'))).toBe(true);
      expect(existsSync(out.skillPath)).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('adds a skills: key to agent.yaml when none was present', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'declara-fresh-yaml-'));
    try {
      writeFileSync(join(fresh, 'agent.yaml'), 'name: f\nmodel: claude-sonnet-4-5\n');
      await runAddSkill({ name: 'hello', description: 'd', body: 'b' }, { scopeRoot: fresh });
      const updated = readFileSync(join(fresh, 'agent.yaml'), 'utf-8');
      expect(updated).toContain('skills:');
      expect(updated).toContain('- skills/hello.md');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('throws BuilderValidationError when agent.yaml skills is not a list', async () => {
    writeFileSync(join(agentRoot, 'agent.yaml'), 'name: x\nskills: not-a-list\n');
    await expect(
      runAddSkill({ name: 'hello', description: 'd', body: 'b' }, { scopeRoot: agentRoot }),
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });
});

describe('createAddSkillTool', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-tool-'));
    writeFileSync(join(dir, 'agent.yaml'), 'name: t\nskills: []\n');
    mkdirSync(join(dir, 'skills'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('exposes the expected Tool metadata', () => {
    const tool = createAddSkillTool({ scopeRoot: dir });
    expect(tool.name).toBe('DeclaraAddSkill');
    expect(tool.readonly).toBe(false);
    expect(tool.inputSchema.type).toBe('object');
  });

  test('permissionKey uses scope-relative path + skill name', () => {
    const tool = createAddSkillTool({ scopeRoot: dir });
    expect(tool.permissionKey({ name: 'x', description: 'd', body: 'b' })).toBe('.:x');
    expect(
      tool.permissionKey({
        name: 'pr-review',
        description: 'd',
        body: 'b',
        agentPath: dir,
      }),
    ).toBe('.:pr-review');
  });

  test('execute yields a result event on the happy path', async () => {
    const tool = createAddSkillTool({ scopeRoot: dir });
    const ctx = {
      session: {} as never,
      permissions: {} as never,
      abortSignal: new AbortController().signal,
      depth: 0,
      runAgent: (async () => ({}) as never) as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      } as never,
    };
    const events: unknown[] = [];
    for await (const ev of tool.execute({ name: 'hello', description: 'd', body: 'body' }, ctx)) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('result');
  });

  test('execute yields a validation error for a bad name', async () => {
    const tool = createAddSkillTool({ scopeRoot: dir });
    const ctx = {
      session: {} as never,
      permissions: {} as never,
      abortSignal: new AbortController().signal,
      depth: 0,
      runAgent: (async () => ({}) as never) as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      } as never,
    };
    const events: unknown[] = [];
    for await (const ev of tool.execute(
      { name: 'Not Lower Case', description: 'd', body: 'body' },
      ctx,
    )) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; error?: { code?: string } };
    expect(ev.type).toBe('error');
    expect(ev.error?.code).toBe('E_BUILDER_VALIDATION');
  });
});

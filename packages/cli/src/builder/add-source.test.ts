import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { appendSourceEntry, runAddSource } from './add-source.js';
import { BuilderConflictError, BuilderScopeError, BuilderValidationError } from './types.js';

const AGENT_YAML = `name: inbox-bot
systemPrompt: |
  You are the inbox triage assistant.
skills:
  - skills/summarise.md
`;

describe('runAddSource', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-add-source-'));
    writeFileSync(join(dir, 'agent.yaml'), AGENT_YAML);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates event-sources.yaml with a valid webhook entry when none exists', async () => {
    const out = await runAddSource(
      {
        type: 'webhook',
        id: 'pr-inbox',
        config: {
          path: '/webhook/pr',
          port: 7777,
          target: { type: 'skill', name: 'summarise' },
        },
      },
      { scopeRoot: dir },
    );
    expect(out.ok).toBe(true);
    expect(out.external).toBe(false);
    expect(out.eventSourcesPath).toBe(join(dir, 'event-sources.yaml'));
    expect(existsSync(out.eventSourcesPath)).toBe(true);

    const parsed = parseYaml(readFileSync(out.eventSourcesPath, 'utf8')) as Array<{
      type: string;
      config: { id: string };
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe('webhook');
    expect(parsed[0]?.config.id).toBe('pr-inbox');
  });

  test('appends to an existing YAML file + preserves comments', async () => {
    const path = join(dir, 'event-sources.yaml');
    writeFileSync(
      path,
      `# hand-authored cron\n- type: cron\n  config:\n    id: morning\n    schedule: "0 9 * * *"\n    target: { type: skill, name: summarise }\n`,
    );
    await runAddSource(
      {
        type: 'webhook',
        id: 'pr-inbox',
        config: { path: '/webhook/pr', target: { type: 'skill', name: 'summarise' } },
      },
      { scopeRoot: dir },
    );
    const out = readFileSync(path, 'utf8');
    // Comment must survive the round-trip.
    expect(out).toContain('# hand-authored cron');
    const parsed = parseYaml(out) as Array<{ type: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.type)).toEqual(['cron', 'webhook']);
  });

  test('rejects a duplicate { type, id } entry', async () => {
    await runAddSource(
      {
        type: 'webhook',
        id: 'pr-inbox',
        config: { path: '/x', target: { type: 'skill', name: 'summarise' } },
      },
      { scopeRoot: dir },
    );
    await expect(
      runAddSource(
        {
          type: 'webhook',
          id: 'pr-inbox',
          config: { path: '/y', target: { type: 'skill', name: 'summarise' } },
        },
        { scopeRoot: dir },
      ),
    ).rejects.toThrow(BuilderConflictError);
  });

  test('rolls back on adapter-level validation failure (invalid cron schedule)', async () => {
    const path = join(dir, 'event-sources.yaml');
    writeFileSync(
      path,
      '- type: webhook\n  config:\n    id: pre-existing\n    path: /already\n    target: { type: skill, name: summarise }\n',
    );
    const before = readFileSync(path, 'utf8');
    await expect(
      runAddSource(
        {
          type: 'cron',
          id: 'bad',
          config: { schedule: 'definitely-not-a-cron', target: { type: 'skill', name: 'x' } },
        },
        { scopeRoot: dir },
      ),
    ).rejects.toThrow(BuilderValidationError);
    // File must match the prior state byte-for-byte.
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('deletes a freshly-created file when validation fails', async () => {
    const path = join(dir, 'event-sources.yaml');
    await expect(
      runAddSource(
        {
          type: 'cron',
          id: 'bad',
          config: { schedule: 'not-a-schedule', target: { type: 'skill', name: 'x' } },
        },
        { scopeRoot: dir },
      ),
    ).rejects.toThrow(BuilderValidationError);
    expect(existsSync(path)).toBe(false);
  });

  test('sets `external: true` for broker types without in-process adapters', async () => {
    const out = await runAddSource(
      {
        type: 'kafka',
        id: 'orders',
        config: {
          brokers: ['broker-1:9092'],
          topics: ['orders'],
          groupId: 'declaragent',
          target: { type: 'skill', name: 'summarise' },
        },
      },
      { scopeRoot: dir },
    );
    expect(out.external).toBe(true);
  });

  test('errors cleanly when agent.yaml is missing', async () => {
    rmSync(join(dir, 'agent.yaml'));
    await expect(
      runAddSource(
        {
          type: 'webhook',
          id: 'x',
          config: { path: '/x', target: { type: 'skill', name: 'summarise' } },
        },
        { scopeRoot: dir },
      ),
    ).rejects.toThrow(BuilderValidationError);
  });

  test('refuses to write outside scope without confirmOutsideScope', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'declara-other-'));
    try {
      writeFileSync(join(outside, 'agent.yaml'), AGENT_YAML);
      await expect(
        runAddSource(
          {
            type: 'webhook',
            id: 'x',
            config: { path: '/x', target: { type: 'skill', name: 'summarise' } },
            agentPath: outside,
          },
          { scopeRoot: dir },
        ),
      ).rejects.toThrow(BuilderScopeError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('JSON prior is preserved as JSON on append', async () => {
    const path = join(dir, 'event-sources.json');
    writeFileSync(
      path,
      JSON.stringify(
        [
          {
            type: 'webhook',
            config: {
              id: 'first',
              path: '/a',
              target: { type: 'skill', name: 'summarise' },
            },
          },
        ],
        null,
        2,
      ),
    );
    const out = await runAddSource(
      {
        type: 'webhook',
        id: 'second',
        config: { path: '/b', target: { type: 'skill', name: 'summarise' } },
      },
      { scopeRoot: dir },
    );
    expect(out.eventSourcesPath).toBe(path);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Array<unknown>;
    expect(parsed).toHaveLength(2);
  });
});

describe('appendSourceEntry (pure)', () => {
  test('synthesises a fresh YAML file when prior is undefined', () => {
    const { nextYaml, isNew } = appendSourceEntry(undefined, {
      type: 'cron',
      id: 'tick',
      config: { id: 'tick', schedule: '*/5 * * * *' },
    });
    expect(isNew).toBe(true);
    const parsed = parseYaml(nextYaml) as Array<{ type: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe('cron');
  });

  test('rejects malformed YAML upstream', () => {
    expect(() =>
      appendSourceEntry('- type: [[broken', {
        type: 'webhook',
        id: 'x',
        config: { id: 'x', path: '/x', target: { type: 'skill', name: 'y' } },
      }),
    ).toThrow(BuilderValidationError);
  });
});

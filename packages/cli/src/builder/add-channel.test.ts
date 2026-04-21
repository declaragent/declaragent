import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAddChannel } from './add-channel.js';
import { BuilderConflictError, BuilderValidationError } from './types.js';

describe('runAddChannel', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-add-channel-'));
    configPath = join(dir, 'channels.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates a fresh channels.json with the canonical shape', async () => {
    const out = await runAddChannel(
      {
        type: 'slack',
        id: 'acme-support',
        config: { token: '${env:SLACK_TOKEN}', signingSecret: '${env:SLACK_SIGNING_SECRET}' },
      },
      { configPath },
    );
    expect(out.ok).toBe(true);
    expect(out.channelsPath).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);

    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      version: number;
      channels: Array<{ type: string; id: string; token: string }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.channels).toHaveLength(1);
    expect(raw.channels[0]?.type).toBe('slack');
    expect(raw.channels[0]?.id).toBe('acme-support');
    expect(raw.channels[0]?.token).toBe('${env:SLACK_TOKEN}');
    expect(out.hint).toContain('user-global');
    expect(out.hint).toContain('slack');
  });

  test('appends to an existing canonical file', async () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: 1,
          channels: [{ type: 'telegram', id: 'news', botToken: '${env:TG}' }],
        },
        null,
        2,
      ),
    );
    await runAddChannel(
      {
        type: 'slack',
        id: 'acme-support',
        config: { token: '${env:SLACK_TOKEN}', signingSecret: '${env:SLACK_SS}' },
      },
      { configPath },
    );
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      channels: Array<{ type: string; id: string }>;
    };
    expect(raw.channels).toHaveLength(2);
    expect(raw.channels.map((c) => c.id)).toEqual(['news', 'acme-support']);
  });

  test('upgrades a bare-array (phase-4 terse) file to the canonical shape', async () => {
    writeFileSync(
      configPath,
      JSON.stringify([{ type: 'telegram', id: 'legacy', botToken: '${env:TG}' }], null, 2),
    );
    await runAddChannel(
      {
        type: 'slack',
        id: 'modern',
        config: { token: '${env:SLACK_TOKEN}', signingSecret: '${env:SLACK_SS}' },
      },
      { configPath },
    );
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      version: number;
      channels: Array<{ id: string }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.channels.map((c) => c.id)).toEqual(['legacy', 'modern']);
  });

  test('rejects duplicate ids', async () => {
    await runAddChannel(
      {
        type: 'slack',
        id: 'acme-support',
        config: { token: '${env:SLACK_TOKEN}', signingSecret: '${env:SLACK_SS}' },
      },
      { configPath },
    );
    await expect(
      runAddChannel(
        {
          type: 'telegram',
          id: 'acme-support',
          config: { botToken: '${env:TG}' },
        },
        { configPath },
      ),
    ).rejects.toThrow(BuilderConflictError);
  });

  test('rolls back on invalid prior-file JSON', async () => {
    writeFileSync(configPath, '{ not json');
    await expect(
      runAddChannel(
        {
          type: 'slack',
          id: 'x',
          config: { token: 'y', signingSecret: 'z' },
        },
        { configPath },
      ),
    ).rejects.toThrow(BuilderValidationError);
    expect(readFileSync(configPath, 'utf8')).toBe('{ not json');
  });

  test('input.config.id cannot override the stated id', async () => {
    await runAddChannel(
      {
        type: 'slack',
        id: 'authoritative',
        config: { id: 'smuggled', token: 'x', signingSecret: 'y' },
      },
      { configPath },
    );
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      channels: Array<{ id: string }>;
    };
    expect(raw.channels[0]?.id).toBe('authoritative');
  });
});

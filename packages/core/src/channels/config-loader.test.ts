import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelsConfigError,
  loadChannelsConfig,
  validateChannelsConfig,
} from './config-loader.js';

function tmp(): { root: string; write(name: string, contents: string): string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'declaragent-channels-config-'));
  return {
    root,
    write(name, contents) {
      const path = join(root, name);
      writeFileSync(path, contents, 'utf-8');
      return path;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('loadChannelsConfig', () => {
  test('loads canonical { version, channels: [...] } YAML', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `version: 1
channels:
  - id: telegram-main
    type: telegram
    transport:
      mode: long-polling
      botToken: hardcoded
`,
      );
      const result = await loadChannelsConfig({ path });
      expect(result.format).toBe('yaml');
      expect(result.channels).toHaveLength(1);
      expect(result.channels[0]?.type).toBe('telegram');
      expect(result.channels[0]?.config.id).toBe('telegram-main');
      expect(result.channels[0]?.config.transport).toEqual({
        mode: 'long-polling',
        botToken: 'hardcoded',
      });
    } finally {
      t.cleanup();
    }
  });

  test('loads plain-array JSON form', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.json',
        JSON.stringify([
          { type: 'telegram', config: { id: 'tg-1', transport: { mode: 'webhook' } } },
        ]),
      );
      const result = await loadChannelsConfig({ path });
      expect(result.format).toBe('json');
      expect(result.channels[0]?.config.id).toBe('tg-1');
    } finally {
      t.cleanup();
    }
  });

  test('expands env refs via the default secret resolver', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `channels:
  - id: slack-prod
    type: slack
    transport:
      botToken: \${env:SLACK_TOKEN}
`,
      );
      const result = await loadChannelsConfig({
        path,
        secretResolver: { env: { SLACK_TOKEN: 'xoxb-abc' } },
      });
      expect((result.channels[0]?.config.transport as { botToken: string }).botToken).toBe(
        'xoxb-abc',
      );
    } finally {
      t.cleanup();
    }
  });

  test('preserves ${channel:conversationSessionId} pseudo-variables', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `channels:
  - id: slack-prod
    type: slack
    routing:
      targetSelector:
        type: session
        sessionIdFrom: \${channel:conversationSessionId}
        action: inject
`,
      );
      const result = await loadChannelsConfig({ path });
      const routing = result.channels[0]?.config.routing as {
        targetSelector: { sessionIdFrom: string };
      };
      expect(routing.targetSelector.sessionIdFrom).toBe('${channel:conversationSessionId}');
    } finally {
      t.cleanup();
    }
  });

  test('pseudo-variables coexist with env refs in the same string', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `channels:
  - id: test
    type: test
    mix: "\${env:PREFIX}-\${channel:conversationSessionId}-suffix"
`,
      );
      const result = await loadChannelsConfig({
        path,
        secretResolver: { env: { PREFIX: 'abc' } },
      });
      expect(result.channels[0]?.config.mix).toBe('abc-${channel:conversationSessionId}-suffix');
    } finally {
      t.cleanup();
    }
  });

  test('rejects duplicate ids in the canonical form', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `channels:
  - id: dup
    type: telegram
  - id: dup
    type: slack
`,
      );
      await expect(loadChannelsConfig({ path })).rejects.toThrow(/is duplicated/);
    } finally {
      t.cleanup();
    }
  });

  test('rejects malformed YAML', async () => {
    const t = tmp();
    try {
      const path = t.write('channels.yaml', 'channels: [\n  { ');
      await expect(loadChannelsConfig({ path })).rejects.toBeInstanceOf(ChannelsConfigError);
    } finally {
      t.cleanup();
    }
  });

  test('rejects missing type', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `channels:
  - id: untyped
    transport: {}
`,
      );
      await expect(loadChannelsConfig({ path })).rejects.toThrow(/type must be a non-empty string/);
    } finally {
      t.cleanup();
    }
  });

  test('rejects entries whose config is not an object (terse form)', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.json',
        JSON.stringify([{ type: 'telegram', config: 'not-an-object' }]),
      );
      await expect(loadChannelsConfig({ path })).rejects.toThrow(/config must be an object/);
    } finally {
      t.cleanup();
    }
  });

  test('rejects top-level non-array / non-object', async () => {
    const t = tmp();
    try {
      const path = t.write('channels.json', '"just a string"');
      await expect(loadChannelsConfig({ path })).rejects.toThrow(
        /array of channels or an object with a "channels" array/,
      );
    } finally {
      t.cleanup();
    }
  });

  test('file-path errors surface with the offending channel id', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `channels:
  - id: tg-bad
    type: telegram
    transport:
      botToken: \${env:UNSET_VAR}
`,
      );
      await expect(loadChannelsConfig({ path })).rejects.toThrow(
        /channels\[0\].*id="tg-bad".*UNSET_VAR/,
      );
    } finally {
      t.cleanup();
    }
  });
});

describe('validateChannelsConfig', () => {
  test('runs adapter.validateConfig on each entry', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `channels:
  - id: good
    type: telegram
  - id: bad
    type: telegram
`,
      );
      const adapters = {
        telegram: {
          validateConfig(cfg: unknown) {
            const c = cfg as { id: string };
            if (c.id === 'bad') throw new Error('bad id');
          },
        },
      };
      const report = await validateChannelsConfig({ path, adapters });
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]?.id).toBe('bad');
      expect(report.unknownTypes).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  test('reports unknown types as warnings (not errors)', async () => {
    const t = tmp();
    try {
      const path = t.write(
        'channels.yaml',
        `channels:
  - id: x
    type: not-installed
`,
      );
      const report = await validateChannelsConfig({ path, adapters: {} });
      expect(report.unknownTypes).toHaveLength(1);
      expect(report.errors).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});

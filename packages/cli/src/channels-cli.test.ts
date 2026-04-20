import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelAdapter } from '@declaragent/core';
import { channelsList, channelsValidate } from './channels-cli.js';

function captureIO(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
  };
}

const MINIMAL_CAPABILITIES = `{
  supportsThreads: false,
  supportsReactions: false,
  supportsTypingIndicator: false,
  supportsFileUpload: false,
  supportsVoice: false,
  supportsButtons: false,
  supportsEditMessage: false,
  supportsDeleteMessage: false,
  supportsPresence: false,
  supportsSlashCommands: false,
  supportsDMs: true,
  supportsGroupChats: false,
  supportsVoiceChannels: false,
  maxMessageLength: 4096,
  maxAttachmentBytes: 10485760,
}`;

function installPackage(root: string, name: string, type: string): string {
  const dir = join(root, 'node_modules', '@declaragent', `channel-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@declaragent/channel-${name}`,
      version: '0.2.0',
      main: 'index.js',
      type: 'module',
      declaragent: { kind: 'channel-adapter', type, agent_compat: '*' },
    }),
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export default {
  type: ${JSON.stringify(type)},
  capabilities: ${MINIMAL_CAPABILITIES},
  validateConfig() {},
  async create() {
    return {
      id: 'x', type: ${JSON.stringify(type)},
      capabilities: ${MINIMAL_CAPABILITIES},
      async start(){}, async stop(){}, async pause(){}, async resume(){},
      async health(){ return { status: 'healthy' }; },
      metrics(){ return { eventsPublished: 0, lastEventAt: null }; },
      async send() { return { id: 'x', conversation: { channelId: 'x', conversationId: 'c' } }; },
    };
  },
};
`,
  );
  return dir;
}

function tmpRoot(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-cli-channels-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe('channelsList', () => {
  test('prints "no channel adapter packages" when nothing is installed', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      const { out, io } = captureIO();
      const code = await channelsList({ io, searchPaths: [path], coreVersion: '0.9.0' });
      expect(code).toBe(0);
      expect(out.join('')).toContain('no channel adapter packages');
    } finally {
      cleanup();
    }
  });

  test('lists installed channels with package + capability info', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installPackage(path, 'telegram', 'telegram');
      installPackage(path, 'slack', 'slack');
      const { out, io } = captureIO();
      const code = await channelsList({ io, searchPaths: [path], coreVersion: '0.9.0' });
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('channels (2)');
      expect(text).toContain('telegram');
      expect(text).toContain('slack');
      expect(text).toContain('@declaragent/channel-telegram@0.2.0');
      expect(text).toContain('maxLen=4096');
    } finally {
      cleanup();
    }
  });

  test('returns 1 with error on discovery failure (duplicate types)', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installPackage(path, 'tg-a', 'telegram');
      installPackage(path, 'tg-b', 'telegram');
      const { err, io } = captureIO();
      const code = await channelsList({ io, searchPaths: [path], coreVersion: '0.9.0' });
      expect(code).toBe(1);
      expect(err.join('')).toContain('claimed by two packages');
    } finally {
      cleanup();
    }
  });
});

describe('channelsValidate', () => {
  test('returns 1 when no path is given and no default exists', async () => {
    const { err, io } = captureIO();
    const code = await channelsValidate(
      { path: '/nonexistent/path/channels.yaml' },
      { io, adapters: {} },
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('no channels config found');
  });

  test('validates a well-formed channels.yaml', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      const configPath = join(path, 'channels.yaml');
      writeFileSync(
        configPath,
        `version: 1
channels:
  - id: tg-main
    type: telegram
    transport:
      mode: long-polling
`,
      );
      const adapters: Record<string, ChannelAdapter<unknown>> = {
        telegram: {
          type: 'telegram',
          capabilities: {
            supportsThreads: false,
            supportsReactions: false,
            supportsTypingIndicator: false,
            supportsFileUpload: false,
            supportsVoice: false,
            supportsButtons: false,
            supportsEditMessage: false,
            supportsDeleteMessage: false,
            supportsPresence: false,
            supportsSlashCommands: false,
            supportsDMs: true,
            supportsGroupChats: false,
            supportsVoiceChannels: false,
            maxMessageLength: 4096,
            maxAttachmentBytes: 10485760,
          },
          validateConfig() {},
          async create() {
            throw new Error('not used in this test');
          },
        },
      };
      const { out, io } = captureIO();
      const code = await channelsValidate({ path: configPath }, { io, adapters });
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('loaded 1 channel');
      expect(text).toContain('config is valid');
    } finally {
      cleanup();
    }
  });

  test('reports adapter-level errors with non-zero exit', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      const configPath = join(path, 'channels.yaml');
      writeFileSync(
        configPath,
        `channels:
  - id: tg-bad
    type: telegram
`,
      );
      const adapters: Record<string, ChannelAdapter<unknown>> = {
        telegram: {
          type: 'telegram',
          capabilities: {
            supportsThreads: false,
            supportsReactions: false,
            supportsTypingIndicator: false,
            supportsFileUpload: false,
            supportsVoice: false,
            supportsButtons: false,
            supportsEditMessage: false,
            supportsDeleteMessage: false,
            supportsPresence: false,
            supportsSlashCommands: false,
            supportsDMs: true,
            supportsGroupChats: false,
            supportsVoiceChannels: false,
            maxMessageLength: 4096,
            maxAttachmentBytes: 10485760,
          },
          validateConfig() {
            throw new Error('missing transport');
          },
          async create() {
            throw new Error('not used');
          },
        },
      };
      const { err, io } = captureIO();
      const code = await channelsValidate({ path: configPath }, { io, adapters });
      expect(code).toBe(1);
      const errText = err.join('');
      expect(errText).toContain('missing transport');
      expect(errText).toContain('id="tg-bad"');
    } finally {
      cleanup();
    }
  });

  test('reports unknown types as warnings but exits 0', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      const configPath = join(path, 'channels.yaml');
      writeFileSync(
        configPath,
        `channels:
  - id: uninstalled
    type: novel-channel
`,
      );
      const { out, io } = captureIO();
      const code = await channelsValidate({ path: configPath }, { io, adapters: {} });
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('unknown types');
      expect(text).toContain('type="novel-channel"');
      expect(text).toContain('config is valid');
    } finally {
      cleanup();
    }
  });

  test('surfaces loader errors (malformed YAML) with non-zero exit', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      const configPath = join(path, 'channels.yaml');
      writeFileSync(configPath, 'channels: [\n  { ');
      const { err, io } = captureIO();
      const code = await channelsValidate({ path: configPath }, { io, adapters: {} });
      expect(code).toBe(1);
      expect(err.join('')).toContain('malformed YAML');
    } finally {
      cleanup();
    }
  });
});

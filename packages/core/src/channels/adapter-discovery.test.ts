import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../types/logger.js';
import {
  CHANNEL_ADAPTER_KIND,
  ChannelAdapterDiscoveryError,
  discoverChannelAdapters,
} from './adapter-discovery.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface FakePackageOpts {
  root: string;
  name: string;
  version?: string;
  declaragent?: {
    kind?: string;
    type?: string;
    agent_compat?: string;
  };
  moduleSource?: string;
  main?: string;
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

function installFakePackage(opts: FakePackageOpts): string {
  const pkgDir = join(opts.root, 'node_modules', '@declaragent', `channel-${opts.name}`);
  mkdirSync(pkgDir, { recursive: true });
  const main = opts.main ?? 'index.js';
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: `@declaragent/channel-${opts.name}`,
        version: opts.version ?? '0.1.0',
        main,
        type: 'module',
        declaragent: opts.declaragent ?? {
          kind: CHANNEL_ADAPTER_KIND,
          type: opts.name,
          agent_compat: '*',
        },
      },
      null,
      2,
    ),
  );
  const runtimeType = opts.declaragent?.type ?? opts.name;
  const defaultModule = `
export default {
  type: ${JSON.stringify(runtimeType)},
  agentCompat: '*',
  capabilities: ${MINIMAL_CAPABILITIES},
  validateConfig(c) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string') {
      throw new Error('${opts.name} requires string id');
    }
  },
  async create(config, _deps) {
    return {
      id: config.id,
      type: ${JSON.stringify(runtimeType)},
      capabilities: ${MINIMAL_CAPABILITIES},
      async start() {},
      async stop() {},
      async pause() {},
      async resume() {},
      async health() { return { status: 'healthy' }; },
      metrics() { return { eventsPublished: 0, lastEventAt: null }; },
      async send() { return { id: 'x', conversation: { channelId: config.id, conversationId: 'c' } }; },
    };
  },
};
`;
  writeFileSync(join(pkgDir, main), opts.moduleSource ?? defaultModule);
  return pkgDir;
}

function tmpRoot(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-channel-discovery-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe('discoverChannelAdapters', () => {
  test('missing node_modules returns empty', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      const out = await discoverChannelAdapters({
        searchPaths: [path],
        coreVersion: '0.9.0',
        logger: NOOP_LOGGER,
      });
      expect(out).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('discovers a compatible channel package', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({ root: path, name: 'telegram' });
      const out = await discoverChannelAdapters({
        searchPaths: [path],
        coreVersion: '0.9.0',
        logger: NOOP_LOGGER,
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.type).toBe('telegram');
      expect(out[0]?.packageName).toBe('@declaragent/channel-telegram');
      expect(out[0]?.adapter.capabilities.maxMessageLength).toBe(4096);
    } finally {
      cleanup();
    }
  });

  test('skips packages without the declaragent marker', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'tagless',
        declaragent: { type: 'tagless', agent_compat: '*' },
      });
      const out = await discoverChannelAdapters({
        searchPaths: [path],
        coreVersion: '0.9.0',
        logger: NOOP_LOGGER,
      });
      expect(out).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('skips packages whose kind is not channel-adapter', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'source-shaped',
        declaragent: { kind: 'event-source-adapter', type: 'source-shaped', agent_compat: '*' },
      });
      const out = await discoverChannelAdapters({
        searchPaths: [path],
        coreVersion: '0.9.0',
        logger: NOOP_LOGGER,
      });
      expect(out).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('rejects mismatched agent_compat', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'telegram',
        declaragent: { kind: CHANNEL_ADAPTER_KIND, type: 'telegram', agent_compat: '>=2.0.0' },
      });
      await expect(
        discoverChannelAdapters({
          searchPaths: [path],
          coreVersion: '0.9.0',
          logger: NOOP_LOGGER,
        }),
      ).rejects.toBeInstanceOf(ChannelAdapterDiscoveryError);
    } finally {
      cleanup();
    }
  });

  test('rejects missing declaragent.type', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'notype',
        declaragent: { kind: CHANNEL_ADAPTER_KIND, agent_compat: '*' },
      });
      await expect(
        discoverChannelAdapters({
          searchPaths: [path],
          coreVersion: '0.9.0',
          logger: NOOP_LOGGER,
        }),
      ).rejects.toThrow(/missing "declaragent.type"/);
    } finally {
      cleanup();
    }
  });

  test('rejects duplicate type claims across packages', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({ root: path, name: 'telegram' });
      installFakePackage({
        root: path,
        name: 'telegram-alt',
        declaragent: { kind: CHANNEL_ADAPTER_KIND, type: 'telegram', agent_compat: '*' },
      });
      await expect(
        discoverChannelAdapters({
          searchPaths: [path],
          coreVersion: '0.9.0',
          logger: NOOP_LOGGER,
        }),
      ).rejects.toThrow(/claimed by two packages/);
    } finally {
      cleanup();
    }
  });

  test('rejects a default export that is not a ChannelAdapter', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'broken',
        moduleSource: 'export default { hello: "world" };',
      });
      await expect(
        discoverChannelAdapters({
          searchPaths: [path],
          coreVersion: '0.9.0',
          logger: NOOP_LOGGER,
        }),
      ).rejects.toThrow(/did not export a ChannelAdapter/);
    } finally {
      cleanup();
    }
  });

  test('rejects an adapter missing ChannelCapabilities', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installFakePackage({
        root: path,
        name: 'capless',
        moduleSource: `
          export default {
            type: 'capless',
            validateConfig() {},
            async create() { return {}; },
          };
        `,
      });
      await expect(
        discoverChannelAdapters({
          searchPaths: [path],
          coreVersion: '0.9.0',
          logger: NOOP_LOGGER,
        }),
      ).rejects.toThrow(/did not export a ChannelAdapter/);
    } finally {
      cleanup();
    }
  });

  test('scans multiple search paths and merges results', async () => {
    const a = tmpRoot();
    const b = tmpRoot();
    try {
      installFakePackage({ root: a.path, name: 'telegram' });
      installFakePackage({ root: b.path, name: 'slack' });
      const out = await discoverChannelAdapters({
        searchPaths: [a.path, b.path],
        coreVersion: '0.9.0',
        logger: NOOP_LOGGER,
      });
      const types = out.map((d) => d.type).sort();
      expect(types).toEqual(['slack', 'telegram']);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

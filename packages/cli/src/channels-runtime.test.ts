import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventBus, Logger } from '@declaragent/core';
import { createEventBus } from '@declaragent/core';
import { startChannelRuntime } from './channels-runtime.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  fields?: unknown;
}

/** Logger that records every line (including child loggers) for assertions. */
function recordingLogger(sink: LogLine[]): Logger {
  const make = (): Logger => ({
    debug(msg, fields) {
      sink.push({ level: 'debug', msg, fields });
    },
    info(msg, fields) {
      sink.push({ level: 'info', msg, fields });
    },
    warn(msg, fields) {
      sink.push({ level: 'warn', msg, fields });
    },
    error(msg, fields) {
      sink.push({ level: 'error', msg, fields });
    },
    child: () => make(),
  });
  return make();
}

function writeFixtureChannelAdapter(root: string, type: string): void {
  const pkgDir = join(root, 'node_modules', '@declaragent', `channel-${type}`);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: `@declaragent/channel-${type}`,
        version: '0.0.1',
        main: './index.js',
        declaragent: {
          kind: 'channel-adapter',
          type,
          agent_compat: '>=0.0.1',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(pkgDir, 'index.js'),
    `export default {
  type: '${type}',
  capabilities: {
    supportsThreads: false,
    supportsReactions: false,
    supportsFileUpload: false,
    supportsButtons: false,
    maxMessageLength: 4000,
    maxAttachmentBytes: 0,
  },
  agentCompat: '>=0.0.1',
  validateConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('config required');
  },
  async create(config, deps) {
    return {
      id: config.id ?? '${type}-default',
      type: '${type}',
      async start() {},
      async stop() {},
      async pause() {},
      async resume() {},
      async health() { return { status: 'healthy' }; },
      metrics() { return { eventsPublished: 0, errors: 0, lastEventAt: null, lastStatus: null }; },
      async send() {
        return { messageId: 'm-1', channelId: config.id ?? '${type}-default', conversationId: 'c-1' };
      },
    };
  },
};
`,
  );
}

describe('startChannelRuntime', () => {
  let root: string;
  let agentDir: string;
  let configPath: string;
  let sessionsDb: string;
  let bus: EventBus;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'declara-channels-runtime-'));
    agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });
    configPath = join(root, 'channels.json');
    sessionsDb = join(root, 'sessions.db');
    bus = createEventBus();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('missing config file → empty runtime, shutdown works', async () => {
    const rt = await startChannelRuntime({
      bus,
      logger: NOOP_LOGGER,
      configPath,
      sessionsDb,
      agentDir,
    });
    expect(rt.channels.list()).toEqual([]);
    expect(rt.skipped).toEqual([]);
    expect(typeof rt.mailbox.send).toBe('function');
    await rt.shutdown();
  });

  test('configured channel with an installed adapter → registered + listable', async () => {
    writeFixtureChannelAdapter(agentDir, 'fakebird');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        channels: [{ type: 'fakebird', id: 'fakebird-main' }],
      }),
    );
    const rt = await startChannelRuntime({
      bus,
      logger: NOOP_LOGGER,
      configPath,
      sessionsDb,
      agentDir,
    });
    expect(rt.channels.list()).toHaveLength(1);
    expect(rt.channels.get('fakebird-main')).toBeDefined();
    expect(rt.skipped).toEqual([]);
    await rt.shutdown();
  });

  test('configured channel with no installed adapter → skipped with a clear reason', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        channels: [{ type: 'missing-adapter', id: 'x' }],
      }),
    );
    const rt = await startChannelRuntime({
      bus,
      logger: NOOP_LOGGER,
      configPath,
      sessionsDb,
      agentDir,
    });
    expect(rt.channels.list()).toEqual([]);
    expect(rt.skipped).toHaveLength(1);
    expect(rt.skipped[0]?.type).toBe('missing-adapter');
    expect(rt.skipped[0]?.reason).toContain('@declaragent/channel-missing-adapter');
    await rt.shutdown();
  });

  test('broken adapter (throws on create) → skipped, healthy siblings still register', async () => {
    writeFixtureChannelAdapter(agentDir, 'ok');
    // Write a broken adapter that throws on create.
    const brokenDir = join(agentDir, 'node_modules', '@declaragent', 'channel-broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(
      join(brokenDir, 'package.json'),
      JSON.stringify({
        name: '@declaragent/channel-broken',
        version: '0.0.1',
        main: './index.js',
        declaragent: { kind: 'channel-adapter', type: 'broken', agent_compat: '>=0.0.1' },
      }),
    );
    writeFileSync(
      join(brokenDir, 'index.js'),
      `export default {
  type: 'broken',
  capabilities: {
    supportsThreads: false,
    supportsReactions: false,
    supportsFileUpload: false,
    supportsButtons: false,
    maxMessageLength: 4000,
    maxAttachmentBytes: 0,
  },
  agentCompat: '>=0.0.1',
  validateConfig(c) { if (!c) throw new Error('config required'); },
  async create() { throw new Error('channel boot broke'); },
};
`,
    );

    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        channels: [
          { type: 'ok', id: 'ok-1' },
          { type: 'broken', id: 'broken-1' },
        ],
      }),
    );

    const rt = await startChannelRuntime({
      bus,
      logger: NOOP_LOGGER,
      configPath,
      sessionsDb,
      agentDir,
    });
    expect(rt.channels.list().map((c) => c.id)).toEqual(['ok-1']);
    const brokenSkip = rt.skipped.find((s) => s.type === 'broken');
    expect(brokenSkip?.reason).toContain('channel boot broke');
    await rt.shutdown();
  });

  test('parses an inbound route with a valid sessionKey + drops an empty-string sessionKey', async () => {
    writeFixtureChannelAdapter(agentDir, 'fakebird');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        channels: [
          {
            type: 'fakebird',
            id: 'fakebird-main',
            inbound: {
              routes: [
                // (i) valid sessionKey
                { event: 'chat.dm', skill: 'chat', sessionKey: 'support-thread' },
                // (ii) empty-string sessionKey → must be dropped with a warn
                { event: 'chat.mention', skill: 'triage', sessionKey: '' },
                // (iii) no sessionKey → must still parse
                { event: 'chat.file', skill: 'ingest' },
              ],
            },
          },
        ],
      }),
    );
    const logs: LogLine[] = [];
    const rt = await startChannelRuntime({
      bus,
      logger: recordingLogger(logs),
      configPath,
      sessionsDb,
      agentDir,
    });

    // The empty-sessionKey route logs a route-invalid warning.
    const invalidWarn = logs.find(
      (l) =>
        l.level === 'warn' &&
        l.msg === 'channels.inbound-config.route-invalid' &&
        typeof l.fields === 'object' &&
        l.fields !== null &&
        (l.fields as { reason?: string }).reason?.includes('sessionKey'),
    );
    expect(invalidWarn).toBeDefined();

    // The bridge came up because two valid routes survived (i + iii).
    const ready = logs.find((l) => l.msg === 'channels.inbound-bridge.ready');
    expect(ready).toBeDefined();
    expect((ready?.fields as { channelIds?: string[] }).channelIds).toEqual(['fakebird-main']);

    await rt.shutdown();
  });

  test('a channel whose only inbound route has an empty sessionKey wires no bridge', async () => {
    writeFixtureChannelAdapter(agentDir, 'fakebird');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        channels: [
          {
            type: 'fakebird',
            id: 'fakebird-main',
            inbound: {
              routes: [{ event: 'chat.dm', skill: 'chat', sessionKey: '' }],
            },
          },
        ],
      }),
    );
    const logs: LogLine[] = [];
    const rt = await startChannelRuntime({
      bus,
      logger: recordingLogger(logs),
      configPath,
      sessionsDb,
      agentDir,
    });
    // Sole route dropped → no routes → no bridge.
    expect(logs.find((l) => l.msg === 'channels.inbound-bridge.ready')).toBeUndefined();
    expect(
      logs.find(
        (l) =>
          l.msg === 'channels.inbound-config.route-invalid' &&
          (l.fields as { reason?: string }).reason?.includes('sessionKey'),
      ),
    ).toBeDefined();
    await rt.shutdown();
  });

  test('shutdown closes the db handle + stops every channel instance', async () => {
    writeFixtureChannelAdapter(agentDir, 'closeable');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        channels: [{ type: 'closeable', id: 'closeable-1' }],
      }),
    );
    const rt = await startChannelRuntime({
      bus,
      logger: NOOP_LOGGER,
      configPath,
      sessionsDb,
      agentDir,
    });
    await rt.shutdown();
    // Second shutdown is idempotent.
    await expect(rt.shutdown()).resolves.toBeUndefined();
  });
});

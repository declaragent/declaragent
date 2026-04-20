import { describe, expect, test } from 'bun:test';
import {
  type AgentEvent,
  type ChannelDependencies,
  type Logger,
  createChannelRegistry,
  createEventBus,
} from '@declaragent/core';
import { createDiscordAdapter } from './adapter.js';
import {
  DiscordApiError,
  type DiscordClient,
  type DiscordCreateFollowupMessageParams,
  type DiscordCreateInteractionResponseParams,
  type DiscordCreateReactionParams,
  type DiscordDeleteMessageParams,
  type DiscordEditMessageParams,
  type DiscordRegisterGlobalCommandsParams,
  type DiscordSendMessageParams,
  type DiscordTriggerTypingParams,
  type DiscordUnarchiveThreadParams,
  type GatewayEventHandler,
  type GatewayTransport,
} from './client.js';
import type { DiscordChannelConfig } from './config.js';
import type {
  DiscordChannel,
  DiscordGatewayPayload,
  DiscordInteraction,
  DiscordMessage,
  DiscordUser,
} from './discord-api.js';
import { DiscordChannelInstance } from './instance.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface StubCalls {
  sendMessage: DiscordSendMessageParams[];
  editMessage: DiscordEditMessageParams[];
  deleteMessage: DiscordDeleteMessageParams[];
  createReaction: DiscordCreateReactionParams[];
  triggerTyping: DiscordTriggerTypingParams[];
  unarchiveThread: DiscordUnarchiveThreadParams[];
  registerCommands: DiscordRegisterGlobalCommandsParams[];
  createInteractionResponse: DiscordCreateInteractionResponseParams[];
  createFollowupMessage: DiscordCreateFollowupMessageParams[];
  getChannel: string[];
  getCurrentUser: number;
  getGatewayBotInfo: number;
  gatewayConnect: number;
  gatewayClose: number;
}

interface StubOptions {
  botUser?: Partial<DiscordUser>;
  channels?: Map<string, DiscordChannel>;
  sendMessageError?: () => unknown;
  unarchiveError?: () => unknown;
}

interface StubResult {
  client: DiscordClient;
  calls: StubCalls;
  pushGatewayEvent: (payload: DiscordGatewayPayload) => Promise<void>;
}

function makeStubClient(opts: StubOptions = {}): StubResult {
  const calls: StubCalls = {
    sendMessage: [],
    editMessage: [],
    deleteMessage: [],
    createReaction: [],
    triggerTyping: [],
    unarchiveThread: [],
    registerCommands: [],
    createInteractionResponse: [],
    createFollowupMessage: [],
    getChannel: [],
    getCurrentUser: 0,
    getGatewayBotInfo: 0,
    gatewayConnect: 0,
    gatewayClose: 0,
  };
  let gatewayHandlers: GatewayEventHandler[] = [];

  const transport: GatewayTransport = {
    async connect() {
      calls.gatewayConnect += 1;
    },
    onEvent(handler) {
      gatewayHandlers.push(handler);
    },
    async close() {
      calls.gatewayClose += 1;
      gatewayHandlers = [];
    },
  };

  const pushGatewayEvent = async (payload: DiscordGatewayPayload): Promise<void> => {
    for (const h of gatewayHandlers) await h(payload);
  };

  const channels = opts.channels ?? new Map<string, DiscordChannel>();

  const nextMessage = (channelId: string, id: string): DiscordMessage => ({
    id,
    channel_id: channelId,
    author: { id: 'bot-1', username: 'agentbot', bot: true },
    content: '',
    timestamp: new Date().toISOString(),
  });

  const client: DiscordClient = {
    getCurrentUser: async () => {
      calls.getCurrentUser += 1;
      return {
        id: 'bot-1',
        username: 'agentbot',
        bot: true,
        ...opts.botUser,
      };
    },
    getGatewayBotInfo: async () => {
      calls.getGatewayBotInfo += 1;
      return {
        url: 'wss://example',
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: 999,
          reset_after: 0,
          max_concurrency: 1,
        },
      };
    },
    getChannel: async (id) => {
      calls.getChannel.push(id);
      const found = channels.get(id);
      if (!found) return { id, type: 0 };
      return found;
    },
    sendMessage: async (p) => {
      if (opts.sendMessageError) throw opts.sendMessageError();
      calls.sendMessage.push(p);
      return nextMessage(p.channelId, `msg-${calls.sendMessage.length}`);
    },
    editMessage: async (p) => {
      calls.editMessage.push(p);
      return nextMessage(p.channelId, p.messageId);
    },
    deleteMessage: async (p) => {
      calls.deleteMessage.push(p);
    },
    createReaction: async (p) => {
      calls.createReaction.push(p);
    },
    triggerTypingIndicator: async (p) => {
      calls.triggerTyping.push(p);
    },
    unarchiveThread: async (p) => {
      if (opts.unarchiveError) throw opts.unarchiveError();
      calls.unarchiveThread.push(p);
    },
    registerGlobalCommands: async (p) => {
      calls.registerCommands.push(p);
      return [];
    },
    createInteractionResponse: async (p) => {
      calls.createInteractionResponse.push(p);
    },
    createFollowupMessage: async (p) => {
      calls.createFollowupMessage.push(p);
      return nextMessage('interaction', `fm-${calls.createFollowupMessage.length}`);
    },
    createGatewayTransport: () => transport,
  };

  return { client, calls, pushGatewayEvent };
}

function baseConfig(overrides: Partial<DiscordChannelConfig> = {}): DiscordChannelConfig {
  return {
    id: 'discord-main',
    transport: {
      botToken: 'test-token',
      applicationId: 'app-1',
      intents: ['Guilds', 'GuildMessages', 'DirectMessages'],
    },
    routing: {
      format: 'json',
      kindSelector: { const: 'chat.message' },
      targetSelector: { type: 'broadcast' },
    },
    delivery: {
      mode: 'at-least-once',
      ackStrategy: 'after-publish',
      maxRetries: 1,
      retryBackoff: { initialMs: 1, maxMs: 10, jitter: false },
      idempotency: { strategy: 'content-hash', ttlMs: 60_000, store: 'memory' },
    },
    limits: { concurrency: 4, maxInflight: 10 },
    ...overrides,
  };
}

function deps(
  bus: ReturnType<typeof createEventBus> = createEventBus(),
  logger: Logger = NOOP_LOGGER,
): ChannelDependencies {
  return {
    bus,
    logger,
    configDir: '/tmp',
    channels: createChannelRegistry(),
  };
}

function buildInstance(
  configOverrides: Partial<DiscordChannelConfig> = {},
  stubOpts: StubOptions = {},
): {
  instance: DiscordChannelInstance;
  calls: StubCalls;
  bus: ReturnType<typeof createEventBus>;
  events: AgentEvent[];
  pushGatewayEvent: (payload: DiscordGatewayPayload) => Promise<void>;
} {
  const { client, calls, pushGatewayEvent } = makeStubClient(stubOpts);
  const bus = createEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe('*', (e) => {
    events.push(e);
  });
  const instance = new DiscordChannelInstance({
    config: baseConfig(configOverrides),
    deps: deps(bus),
    client,
  });
  return { instance, calls, bus, events, pushGatewayEvent };
}

function makeMessage(overrides: Partial<DiscordMessage>): DiscordMessage {
  return {
    id: 'm-1',
    channel_id: 'ch-1',
    author: { id: 'u-42', username: 'alice', bot: false },
    content: 'hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DiscordChannelInstance — lifecycle', () => {
  test('start opens Gateway and fetches current user', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.stop();
    expect(calls.getCurrentUser).toBe(1);
    expect(calls.gatewayConnect).toBe(1);
    expect(calls.gatewayClose).toBe(1);
  });

  test('start registers slash commands once when configured', async () => {
    const { instance, calls } = buildInstance({
      slashCommands: [
        { name: 'agent', description: 'Talk to the agent' },
        { name: 'help', description: 'Show help' },
      ],
    });
    await instance.start();
    await instance.stop();
    expect(calls.registerCommands).toHaveLength(1);
    expect(calls.registerCommands[0]?.commands).toHaveLength(2);
    expect(calls.registerCommands[0]?.commands.map((c) => c.name).sort()).toEqual([
      'agent',
      'help',
    ]);
  });

  test('skips slash command registration when unchanged across restarts (via conversationStore)', async () => {
    const store = new Map<string, string>();
    const conversationStore = {
      async get(key: string) {
        return store.get(key);
      },
      async set(key: string, value: string) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
    };
    const cfg = baseConfig({
      slashCommands: [{ name: 'agent', description: 'Talk to the agent' }],
    });

    const { client: c1, calls: calls1 } = makeStubClient();
    const inst1 = new DiscordChannelInstance({
      config: cfg,
      deps: { ...deps(), conversationStore },
      client: c1,
    });
    await inst1.start();
    await inst1.stop();
    expect(calls1.registerCommands).toHaveLength(1);

    const { client: c2, calls: calls2 } = makeStubClient();
    const inst2 = new DiscordChannelInstance({
      config: cfg,
      deps: { ...deps(), conversationStore },
      client: c2,
    });
    await inst2.start();
    await inst2.stop();
    expect(calls2.registerCommands).toHaveLength(0);
  });
});

describe('DiscordChannelInstance — privileged intent gate', () => {
  test('validateConfig rejects privileged intents without opt-in', () => {
    const adapter = createDiscordAdapter();
    const bad = {
      ...baseConfig(),
      transport: {
        botToken: 't',
        applicationId: 'a',
        intents: ['Guilds', 'MessageContent'],
      },
    };
    expect(() => adapter.validateConfig(bad)).toThrow(/privileged/);
  });

  test('validateConfig accepts privileged intents with privileged: true', () => {
    const adapter = createDiscordAdapter();
    const good = {
      ...baseConfig(),
      transport: {
        botToken: 't',
        applicationId: 'a',
        intents: ['Guilds', 'MessageContent'],
        privileged: true,
      },
    };
    expect(() => adapter.validateConfig(good)).not.toThrow();
  });
});

describe('DiscordChannelInstance — inbound classification', () => {
  test('MESSAGE_CREATE in guild → chat.message', async () => {
    const { instance, events, pushGatewayEvent } = buildInstance();
    await instance.start();
    await pushGatewayEvent({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: makeMessage({ guild_id: 'g-1', content: 'howdy' }),
    });
    await instance.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('chat.message');
    expect(events[0]?.source.type).toBe('discord');
    expect(events[0]?.meta?.principal?.platformUserId).toBe('u-42');
  });

  test('MESSAGE_CREATE without guild → chat.dm', async () => {
    const { instance, events, pushGatewayEvent } = buildInstance();
    await instance.start();
    await pushGatewayEvent({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: makeMessage({ type: 1 }),
    });
    await instance.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('chat.dm');
  });

  test('MESSAGE_CREATE mentioning the bot → chat.mention', async () => {
    const { instance, events, pushGatewayEvent } = buildInstance();
    await instance.start();
    await pushGatewayEvent({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: makeMessage({
        guild_id: 'g-1',
        content: '<@bot-1> how are you?',
        mentions: [{ id: 'bot-1', username: 'agentbot', bot: true }],
      }),
    });
    await instance.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('chat.mention');
  });

  test('bot-authored MESSAGE_CREATE is ignored (loop prevention)', async () => {
    const { instance, events, pushGatewayEvent } = buildInstance();
    await instance.start();
    await pushGatewayEvent({
      op: 0,
      t: 'MESSAGE_CREATE',
      d: makeMessage({
        author: { id: 'u-99', username: 'otherbot', bot: true },
      }),
    });
    await instance.stop();
    expect(events).toHaveLength(0);
  });

  test('INTERACTION_CREATE button → channel.interaction + acks immediately', async () => {
    const { instance, events, calls, pushGatewayEvent } = buildInstance();
    await instance.start();
    const interaction: DiscordInteraction = {
      id: 'int-1',
      application_id: 'app-1',
      type: 3,
      token: 'token-1',
      version: 1,
      guild_id: 'g-1',
      channel_id: 'ch-1',
      data: { custom_id: 'yes', component_type: 2 },
      member: { user: { id: 'u-42', username: 'alice', bot: false } },
      message: makeMessage({}),
    };
    await pushGatewayEvent({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: interaction,
    });
    await instance.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('channel.interaction');
    expect(calls.createInteractionResponse).toHaveLength(1);
    expect(calls.createInteractionResponse[0]?.response.type).toBe(5);
  });

  test('INTERACTION_CREATE slash command → channel.command', async () => {
    const { instance, events, pushGatewayEvent } = buildInstance();
    await instance.start();
    const interaction: DiscordInteraction = {
      id: 'int-2',
      application_id: 'app-1',
      type: 2,
      token: 'token-2',
      version: 1,
      guild_id: 'g-1',
      channel_id: 'ch-1',
      data: { name: 'agent', options: [] },
      user: { id: 'u-42', username: 'alice', bot: false },
    };
    await pushGatewayEvent({
      op: 0,
      t: 'INTERACTION_CREATE',
      d: interaction,
    });
    await instance.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('channel.command');
    const payload = events[0]?.payload as { command?: string };
    expect(payload.command).toBe('agent');
  });
});

describe('DiscordChannelInstance — outbound', () => {
  test('send(text) calls sendMessage with content', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    const sent = await instance.send({
      conversation: { channelId: 'discord-main', conversationId: 'ch-1' },
      content: { kind: 'text', text: 'hello world' },
      idempotencyKey: 't1',
    });
    await instance.stop();
    expect(calls.sendMessage).toHaveLength(1);
    expect(calls.sendMessage[0]?.content).toBe('hello world');
    expect(calls.sendMessage[0]?.channelId).toBe('ch-1');
    expect(sent.conversation.conversationId).toBe('ch-1');
  });

  test('send(rich) renders embeds + ActionRow components', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.send({
      conversation: { channelId: 'discord-main', conversationId: 'ch-1' },
      content: {
        kind: 'rich',
        blocks: [
          { kind: 'heading', text: 'Order' },
          { kind: 'paragraph', text: 'Confirm?' },
          {
            kind: 'button-row',
            buttons: [
              { id: 'yes', label: 'Yes', style: 'primary' },
              { id: 'link', label: 'Docs', url: 'https://docs' },
            ],
          },
        ],
      },
      idempotencyKey: 't2',
    });
    await instance.stop();
    expect(calls.sendMessage).toHaveLength(1);
    const sent = calls.sendMessage[0];
    expect(sent?.embeds).toHaveLength(1);
    const embeds = sent?.embeds as { title?: string; description?: string }[];
    expect(embeds[0]?.title).toBe('Order');
    const rows = sent?.components as {
      type: number;
      components: { custom_id?: string; url?: string }[];
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.components[0]?.custom_id).toBe('yes');
    expect(rows[0]?.components[1]?.url).toBe('https://docs');
  });

  test('send(file) forwards files array to sendMessage', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.send({
      conversation: { channelId: 'discord-main', conversationId: 'ch-1' },
      content: {
        kind: 'file',
        file: { id: 'f', name: 'report.md', url: 'https://cdn/report.md' },
        caption: 'here',
      },
      idempotencyKey: 'f1',
    });
    await instance.stop();
    expect(calls.sendMessage).toHaveLength(1);
    expect(calls.sendMessage[0]?.files).toHaveLength(1);
    expect(calls.sendMessage[0]?.files?.[0]?.name).toBe('report.md');
    expect(calls.sendMessage[0]?.content).toBe('here');
  });

  test('react, setTyping, edit, delete call matching REST endpoints', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.setTyping?.({ channelId: 'discord-main', conversationId: 'ch-1' }, 0);
    await instance.react?.(
      { conversation: { channelId: 'discord-main', conversationId: 'ch-1' }, id: 'm-1' },
      '👍',
    );
    await instance.edit?.(
      { conversation: { channelId: 'discord-main', conversationId: 'ch-1' }, id: 'm-1' },
      { kind: 'text', text: 'updated' },
    );
    await instance.delete?.({
      conversation: { channelId: 'discord-main', conversationId: 'ch-1' },
      id: 'm-1',
    });
    await instance.stop();
    expect(calls.triggerTyping).toHaveLength(1);
    expect(calls.createReaction).toHaveLength(1);
    expect(calls.createReaction[0]?.emoji).toBe('👍');
    expect(calls.editMessage).toHaveLength(1);
    expect(calls.editMessage[0]?.content).toBe('updated');
    expect(calls.deleteMessage).toHaveLength(1);
  });

  test('429 response maps to ChannelRateLimitError and base class retries once', async () => {
    const rateLimitErr = new DiscordApiError(
      'Too Many Requests',
      'POST /channels/ch-1/messages',
      429,
      { retry_after: 0.001 },
      1,
    );
    const state = { fired: false };
    const { client, calls } = makeStubClient();
    const original = client.sendMessage;
    client.sendMessage = async (p) => {
      if (!state.fired) {
        state.fired = true;
        throw rateLimitErr;
      }
      return original(p);
    };
    const bus = createEventBus();
    const instance = new DiscordChannelInstance({
      config: baseConfig(),
      deps: deps(bus),
      client,
    });
    await instance.start();
    const sent = await instance.send({
      conversation: { channelId: 'discord-main', conversationId: 'ch-1' },
      content: { kind: 'text', text: 'hello' },
      idempotencyKey: 'rl',
    });
    await instance.stop();
    expect(sent.id).toBeDefined();
    expect(calls.sendMessage).toHaveLength(1);
    expect(instance.sendCountersSnapshot().rateLimitRetried).toBe(1);
  });

  test('archived thread → auto-unarchive before send', async () => {
    const channels = new Map<string, DiscordChannel>();
    channels.set('thread-1', {
      id: 'thread-1',
      type: 11,
      thread_metadata: { archived: true },
    });
    const { instance, calls } = buildInstance({}, { channels });
    await instance.start();
    await instance.send({
      conversation: {
        channelId: 'discord-main',
        conversationId: 'ch-1',
        threadId: 'thread-1',
      },
      content: { kind: 'text', text: 'rezzing the thread' },
      idempotencyKey: 'at1',
    });
    await instance.stop();
    expect(calls.getChannel).toContain('thread-1');
    expect(calls.unarchiveThread).toHaveLength(1);
    expect(calls.unarchiveThread[0]?.threadId).toBe('thread-1');
    expect(calls.sendMessage).toHaveLength(1);
    expect(calls.sendMessage[0]?.channelId).toBe('thread-1');
  });

  test('archived thread with policy=drop → send throws', async () => {
    const channels = new Map<string, DiscordChannel>();
    channels.set('thread-drop', {
      id: 'thread-drop',
      type: 11,
      thread_metadata: { archived: true },
    });
    const { instance, calls } = buildInstance({ archivedThreadPolicy: 'drop' }, { channels });
    await instance.start();
    await expect(
      instance.send({
        conversation: {
          channelId: 'discord-main',
          conversationId: 'ch-1',
          threadId: 'thread-drop',
        },
        content: { kind: 'text', text: 'nope' },
        idempotencyKey: 'ad1',
      }),
    ).rejects.toThrow(/archived/);
    await instance.stop();
    expect(calls.unarchiveThread).toHaveLength(0);
    expect(calls.sendMessage).toHaveLength(0);
  });

  test('interaction follow-up is used when a pending interaction exists', async () => {
    const { instance, calls, pushGatewayEvent } = buildInstance();
    await instance.start();
    const interaction: DiscordInteraction = {
      id: 'int-fu',
      application_id: 'app-1',
      type: 3,
      token: 'token-fu',
      version: 1,
      guild_id: 'g-1',
      channel_id: 'ch-fu',
      data: { custom_id: 'yes', component_type: 2 },
      user: { id: 'u-42', username: 'alice', bot: false },
    };
    await pushGatewayEvent({ op: 0, t: 'INTERACTION_CREATE', d: interaction });
    // Now send to the same conversation — should use createFollowupMessage.
    await instance.send({
      conversation: { channelId: 'discord-main', conversationId: 'ch-fu' },
      content: { kind: 'text', text: 'following up' },
      idempotencyKey: 'fu1',
    });
    await instance.stop();
    expect(calls.createFollowupMessage).toHaveLength(1);
    expect(calls.createFollowupMessage[0]?.content).toBe('following up');
    expect(calls.sendMessage).toHaveLength(0);
  });

  test('uploadFile throws (no standalone upload on Discord)', async () => {
    const { instance } = buildInstance();
    await instance.start();
    await expect(
      instance.uploadFile?.(
        { name: 'a.txt', mimeType: 'text/plain' },
        { channelId: 'discord-main', conversationId: 'ch-1' },
      ),
    ).rejects.toThrow(/not supported/);
    await instance.stop();
  });
});

describe('DiscordChannelInstance — webhook mode', () => {
  const HEX = '0123456789abcdef';
  function toHex(bytes: Uint8Array): string {
    let out = '';
    for (const b of bytes) {
      out += HEX[b >> 4];
      out += HEX[b & 0xf];
    }
    return out;
  }

  async function withSignedBody(
    instance: DiscordChannelInstance,
    publicKeyHex: string,
    privateKey: CryptoKey,
    body: Uint8Array,
    timestamp = '1700000000',
  ): Promise<{ status: number; body?: string }> {
    const tsBytes = new TextEncoder().encode(timestamp);
    const messageBuf = new ArrayBuffer(tsBytes.length + body.length);
    const message = new Uint8Array(messageBuf);
    message.set(tsBytes, 0);
    message.set(body, tsBytes.length);
    const sig = await crypto.subtle.sign('Ed25519', privateKey, messageBuf);
    // Suppress unused-var warning for publicKeyHex; it's already on the config.
    void publicKeyHex;
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: {
        'x-signature-ed25519': toHex(new Uint8Array(sig)),
        'x-signature-timestamp': timestamp,
      },
      body,
    });
    return { status: resp?.status ?? 0, ...(resp?.body !== undefined && { body: resp.body }) };
  }

  async function makeKeypair(): Promise<{ publicKeyHex: string; privateKey: CryptoKey }> {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as unknown as CryptoKeyPair;
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    return { publicKeyHex: toHex(new Uint8Array(raw)), privateKey: pair.privateKey };
  }

  test('responds to PING interactions with type 1 when signature is valid', async () => {
    const { publicKeyHex, privateKey } = await makeKeypair();
    const { instance } = buildInstance({
      transport: {
        botToken: 'test-token',
        applicationId: 'app-1',
        intents: ['Guilds', 'GuildMessages', 'DirectMessages'],
        publicKey: publicKeyHex,
      },
    });
    await instance.start();
    const resp = await withSignedBody(
      instance,
      publicKeyHex,
      privateKey,
      new TextEncoder().encode(JSON.stringify({ type: 1 })),
    );
    expect(resp.status).toBe(200);
    expect(resp.body).toBe(JSON.stringify({ type: 1 }));
    await instance.stop();
  });

  test('rejects missing signature headers with 401', async () => {
    const { publicKeyHex } = await makeKeypair();
    const { instance } = buildInstance({
      transport: {
        botToken: 'test-token',
        applicationId: 'app-1',
        intents: ['Guilds', 'GuildMessages', 'DirectMessages'],
        publicKey: publicKeyHex,
      },
    });
    await instance.start();
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: {},
      body: new TextEncoder().encode('{}'),
    });
    expect(resp?.status).toBe(401);
    await instance.stop();
  });

  test('rejects tampered bodies with 401 (Ed25519 verification)', async () => {
    const { publicKeyHex, privateKey } = await makeKeypair();
    const { instance } = buildInstance({
      transport: {
        botToken: 'test-token',
        applicationId: 'app-1',
        intents: ['Guilds', 'GuildMessages', 'DirectMessages'],
        publicKey: publicKeyHex,
      },
    });
    await instance.start();
    // Sign one body; present a different one.
    const timestamp = '1700000000';
    const signed = new TextEncoder().encode(JSON.stringify({ type: 1 }));
    const tsBytes = new TextEncoder().encode(timestamp);
    const messageBuf = new ArrayBuffer(tsBytes.length + signed.length);
    const message = new Uint8Array(messageBuf);
    message.set(tsBytes, 0);
    message.set(signed, tsBytes.length);
    const sig = await crypto.subtle.sign('Ed25519', privateKey, messageBuf);
    const tampered = new TextEncoder().encode(JSON.stringify({ type: 2 }));
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: {
        'x-signature-ed25519': toHex(new Uint8Array(sig)),
        'x-signature-timestamp': timestamp,
      },
      body: tampered,
    });
    expect(resp?.status).toBe(401);
    await instance.stop();
  });

  test('rejects webhook calls entirely when publicKey is not configured', async () => {
    const { instance } = buildInstance(); // baseConfig: no publicKey
    await instance.start();
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: {
        'x-signature-ed25519': 'a'.repeat(128),
        'x-signature-timestamp': '1700000000',
      },
      body: new TextEncoder().encode('{}'),
    });
    expect(resp?.status).toBe(401);
    await instance.stop();
  });
});

describe('createDiscordAdapter', () => {
  test('validateConfig accepts a well-formed config', () => {
    const adapter = createDiscordAdapter();
    expect(() => adapter.validateConfig(baseConfig())).not.toThrow();
  });

  test('validateConfig rejects missing botToken', () => {
    const adapter = createDiscordAdapter();
    const bad = {
      ...baseConfig(),
      transport: { applicationId: 'app', intents: ['Guilds'] },
    };
    expect(() => adapter.validateConfig(bad)).toThrow(/botToken/);
  });

  test('validateConfig rejects unknown intent', () => {
    const adapter = createDiscordAdapter();
    const bad = {
      ...baseConfig(),
      transport: { botToken: 't', applicationId: 'a', intents: ['WhateverMode'] },
    };
    expect(() => adapter.validateConfig(bad)).toThrow(/unknown entry/);
  });

  test('create returns a DiscordChannelInstance with correct id and type', async () => {
    const { client } = makeStubClient();
    const adapter = createDiscordAdapter({ client });
    const bus = createEventBus();
    const instance = await adapter.create(baseConfig(), deps(bus));
    expect(instance.id).toBe('discord-main');
    expect(instance.type).toBe('discord');
  });
});

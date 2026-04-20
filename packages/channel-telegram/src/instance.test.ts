import { describe, expect, test } from 'bun:test';
import {
  type AgentEvent,
  type ChannelDependencies,
  createChannelRegistry,
  createEventBus,
} from '@declaragent/core';
import type { Logger } from '@declaragent/core';
import { createTelegramAdapter } from './adapter.js';
import type {
  AnswerCallbackQueryParams,
  DeleteMessageParams,
  EditMessageTextParams,
  GetUpdatesParams,
  SendChatActionParams,
  SendDocumentParams,
  SendMessageParams,
  SendVoiceParams,
  SetMessageReactionParams,
  SetWebhookParams,
  TelegramClient,
} from './client.js';
import { TelegramApiError } from './client.js';
import type { TelegramChannelConfig } from './config.js';
import { TelegramChannelInstance } from './instance.js';
import type { TelegramBotInfo, TelegramMessage, TelegramUpdate } from './telegram-api.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface StubCalls {
  sendMessage: SendMessageParams[];
  sendDocument: SendDocumentParams[];
  sendVoice: SendVoiceParams[];
  sendChatAction: SendChatActionParams[];
  setMessageReaction: SetMessageReactionParams[];
  editMessageText: EditMessageTextParams[];
  deleteMessage: DeleteMessageParams[];
  answerCallbackQuery: AnswerCallbackQueryParams[];
  setWebhook: SetWebhookParams[];
  deleteWebhook: number;
  getMe: number;
  getUpdates: GetUpdatesParams[];
}

interface StubOptions {
  botInfo?: Partial<TelegramBotInfo>;
  updatesQueue?: TelegramUpdate[][];
  getUpdatesDelayMs?: number;
  sendMessageError?: () => unknown;
}

function makeStubClient(opts: StubOptions = {}): { client: TelegramClient; calls: StubCalls } {
  const calls: StubCalls = {
    sendMessage: [],
    sendDocument: [],
    sendVoice: [],
    sendChatAction: [],
    setMessageReaction: [],
    editMessageText: [],
    deleteMessage: [],
    answerCallbackQuery: [],
    setWebhook: [],
    deleteWebhook: 0,
    getMe: 0,
    getUpdates: [],
  };
  const queue = [...(opts.updatesQueue ?? [])];
  const nextMessage = (chatId: number, messageId: number): TelegramMessage => ({
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
  });
  const client: TelegramClient = {
    getMe: async () => {
      calls.getMe += 1;
      return {
        id: 1,
        is_bot: true,
        first_name: 'Agent',
        username: 'agentbot',
        can_join_groups: true,
        can_read_all_group_messages: true,
        supports_inline_queries: false,
        ...opts.botInfo,
      };
    },
    getUpdates: async (params) => {
      calls.getUpdates.push(params);
      if (opts.getUpdatesDelayMs) {
        await new Promise((r) => setTimeout(r, opts.getUpdatesDelayMs));
      }
      const batch = queue.shift();
      return batch ?? [];
    },
    setWebhook: async (p) => {
      calls.setWebhook.push(p);
      return true;
    },
    deleteWebhook: async () => {
      calls.deleteWebhook += 1;
      return true;
    },
    sendMessage: async (p) => {
      if (opts.sendMessageError) throw opts.sendMessageError();
      calls.sendMessage.push(p);
      return nextMessage(Number(p.chat_id), 1_000 + calls.sendMessage.length);
    },
    sendDocument: async (p) => {
      calls.sendDocument.push(p);
      const msg = nextMessage(Number(p.chat_id), 2_000 + calls.sendDocument.length);
      return { ...msg, document: { file_id: 'file_123', file_unique_id: 'u1' } };
    },
    sendVoice: async (p) => {
      calls.sendVoice.push(p);
      const msg = nextMessage(Number(p.chat_id), 3_000 + calls.sendVoice.length);
      return { ...msg, voice: { file_id: 'voice_123', file_unique_id: 'u2', duration: 3 } };
    },
    editMessageText: async (p) => {
      calls.editMessageText.push(p);
      return true;
    },
    deleteMessage: async (p) => {
      calls.deleteMessage.push(p);
      return true;
    },
    sendChatAction: async (p) => {
      calls.sendChatAction.push(p);
      return true;
    },
    setMessageReaction: async (p) => {
      calls.setMessageReaction.push(p);
      return true;
    },
    answerCallbackQuery: async (p) => {
      calls.answerCallbackQuery.push(p);
      return true;
    },
  };
  return { client, calls };
}

function baseConfig(overrides: Partial<TelegramChannelConfig> = {}): TelegramChannelConfig {
  return {
    id: 'tg-main',
    transport: {
      mode: 'long-polling',
      botToken: 'test-token',
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

function deps(bus = createEventBus(), logger: Logger = NOOP_LOGGER): ChannelDependencies {
  return {
    bus,
    logger,
    configDir: '/tmp',
    channels: createChannelRegistry(),
  };
}

function buildInstance(
  configOverrides: Partial<TelegramChannelConfig> = {},
  stubOpts: StubOptions = {},
): {
  instance: TelegramChannelInstance;
  calls: StubCalls;
  bus: ReturnType<typeof createEventBus>;
  events: AgentEvent[];
} {
  const { client, calls } = makeStubClient(stubOpts);
  const bus = createEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe('*', (e) => {
    events.push(e);
  });
  const instance = new TelegramChannelInstance({
    config: baseConfig(configOverrides),
    deps: deps(bus),
    client,
  });
  return { instance, calls, bus, events };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('TelegramChannelInstance — lifecycle', () => {
  test('long-polling: start → getMe preflight + begins poll loop', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    // Let the poll loop run once.
    await new Promise((r) => setTimeout(r, 10));
    await instance.stop();
    expect(calls.getMe).toBe(1);
    expect(calls.getUpdates.length).toBeGreaterThan(0);
  });

  test('privacy mode on → warns on startup', async () => {
    const warnings: unknown[][] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args) => warnings.push(args),
      error() {},
      child: () => logger,
    };
    const { client } = makeStubClient({ botInfo: { can_read_all_group_messages: false } });
    const bus = createEventBus();
    const instance = new TelegramChannelInstance({
      config: baseConfig(),
      deps: { bus, logger, configDir: '/tmp', channels: createChannelRegistry() },
      client,
    });
    await instance.start();
    await instance.stop();
    const privacyWarn = warnings.find((w) => w[0] === 'telegram.privacy_mode_on');
    expect(privacyWarn).toBeDefined();
  });

  test('webhook mode: start calls setWebhook, stop calls deleteWebhook', async () => {
    const { instance, calls } = buildInstance({
      transport: {
        mode: 'webhook',
        botToken: 'test-token',
        webhookUrl: 'https://example.com/wh',
        webhookSecret: 'topsecret',
      },
    });
    await instance.start();
    expect(calls.setWebhook).toHaveLength(1);
    expect(calls.setWebhook[0]?.url).toBe('https://example.com/wh');
    expect(calls.setWebhook[0]?.secret_token).toBe('topsecret');
    await instance.stop();
    expect(calls.deleteWebhook).toBe(1);
  });
});

describe('TelegramChannelInstance — inbound', () => {
  test('dispatches a message via long-polling onto the bus', async () => {
    const { instance, events } = buildInstance(
      {},
      {
        updatesQueue: [
          [
            {
              update_id: 1,
              message: {
                message_id: 10,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 555, type: 'private' },
                from: { id: 42, is_bot: false, first_name: 'Alice', username: 'alice' },
                text: 'hello',
              },
            },
          ],
        ],
      },
    );
    await instance.start();
    // Wait for at least one poll cycle.
    for (let i = 0; i < 20 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await instance.stop();
    expect(events).toHaveLength(1);
    const [evt] = events;
    expect(evt?.kind).toBe('chat.dm');
    expect(evt?.source.type).toBe('telegram');
    expect(evt?.meta?.principal?.platformUserId).toBe('42');
  });

  test('routes callback_query as channel.interaction + acks', async () => {
    const { instance, events, calls } = buildInstance(
      {},
      {
        updatesQueue: [
          [
            {
              update_id: 2,
              callback_query: {
                id: 'cbq-1',
                from: { id: 42, is_bot: false, first_name: 'Alice' },
                message: {
                  message_id: 11,
                  date: Math.floor(Date.now() / 1000),
                  chat: { id: 555, type: 'private' },
                },
                data: 'track',
              },
            },
          ],
        ],
      },
    );
    await instance.start();
    for (
      let i = 0;
      i < 40 && (events.length === 0 || calls.answerCallbackQuery.length === 0);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await instance.stop();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('channel.interaction');
    expect(calls.answerCallbackQuery).toHaveLength(1);
    expect(calls.answerCallbackQuery[0]?.callback_query_id).toBe('cbq-1');
  });

  test('tags / commands as channel.command', async () => {
    const { instance, events } = buildInstance(
      {},
      {
        updatesQueue: [
          [
            {
              update_id: 3,
              message: {
                message_id: 12,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 555, type: 'private' },
                from: { id: 42, is_bot: false, first_name: 'Alice' },
                text: '/help now',
                entities: [{ type: 'bot_command', offset: 0, length: 5 }],
              },
            },
          ],
        ],
      },
    );
    await instance.start();
    for (let i = 0; i < 20 && events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await instance.stop();
    expect(events[0]?.kind).toBe('channel.command');
    const payload = events[0]?.payload as { command?: string; args?: string };
    expect(payload.command).toBe('help');
    expect(payload.args).toBe('now');
  });

  test('ignores bot-authored messages (loop prevention)', async () => {
    const { instance, events } = buildInstance(
      {},
      {
        updatesQueue: [
          [
            {
              update_id: 4,
              message: {
                message_id: 13,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 555, type: 'private' },
                from: { id: 99, is_bot: true, first_name: 'OtherBot' },
                text: 'relay from another bot',
              },
            },
          ],
        ],
      },
    );
    await instance.start();
    await new Promise((r) => setTimeout(r, 30));
    await instance.stop();
    expect(events).toHaveLength(0);
  });
});

describe('TelegramChannelInstance — webhook', () => {
  test('rejects bad secret with 401', async () => {
    const { instance } = buildInstance({
      transport: {
        mode: 'webhook',
        botToken: 'test-token',
        webhookUrl: 'https://example.com/wh',
        webhookSecret: 'topsecret',
      },
    });
    await instance.start();
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: { 'x-telegram-bot-api-secret-token': 'nope' },
      body: new TextEncoder().encode('{}'),
    });
    expect(resp?.status).toBe(401);
    await instance.stop();
  });

  test('rejects when called outside webhook mode', async () => {
    const { instance } = buildInstance();
    await instance.start();
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: {},
      body: new Uint8Array(),
    });
    expect(resp?.status).toBe(405);
    await instance.stop();
  });

  test('dispatches an update on valid secret', async () => {
    const { instance, events } = buildInstance({
      transport: {
        mode: 'webhook',
        botToken: 'test-token',
        webhookUrl: 'https://example.com/wh',
        webhookSecret: 'topsecret',
      },
    });
    await instance.start();
    const update: TelegramUpdate = {
      update_id: 99,
      message: {
        message_id: 21,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 555, type: 'private' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'hi via webhook',
      },
    };
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: { 'x-telegram-bot-api-secret-token': 'topsecret' },
      body: new TextEncoder().encode(JSON.stringify(update)),
    });
    expect(resp?.status).toBe(200);
    expect(events).toHaveLength(1);
    await instance.stop();
  });
});

describe('TelegramChannelInstance — outbound', () => {
  test('send(text) invokes sendMessage with escaped MarkdownV2', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    const sent = await instance.send({
      conversation: { channelId: 'tg-main', conversationId: '555' },
      content: { kind: 'text', text: 'hi. world!' },
      idempotencyKey: 's1',
    });
    await instance.stop();
    expect(calls.sendMessage).toHaveLength(1);
    expect(calls.sendMessage[0]?.parse_mode).toBe('MarkdownV2');
    expect(calls.sendMessage[0]?.text).toContain('\\.');
    expect(sent.conversation.conversationId).toBe('555');
  });

  test('send(rich with buttons) attaches inline keyboard', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.send({
      conversation: { channelId: 'tg-main', conversationId: '555' },
      content: {
        kind: 'rich',
        blocks: [
          { kind: 'heading', text: 'Order' },
          {
            kind: 'button-row',
            buttons: [
              { id: 'yes', label: 'Yes' },
              { id: 'link', label: 'Docs', url: 'https://docs' },
            ],
          },
        ],
      },
      idempotencyKey: 's2',
    });
    await instance.stop();
    expect(calls.sendMessage).toHaveLength(1);
    const rm = calls.sendMessage[0]?.reply_markup;
    expect(rm?.inline_keyboard).toHaveLength(1);
    expect(rm?.inline_keyboard[0]?.[0]?.callback_data).toBe('yes');
    expect(rm?.inline_keyboard[0]?.[1]?.url).toBe('https://docs');
  });

  test('send(file) uses sendDocument + caches file_id', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.send({
      conversation: { channelId: 'tg-main', conversationId: '555' },
      content: { kind: 'file', file: { id: 'f', path: '/tmp/report.md' }, caption: 'here.' },
      idempotencyKey: 's3a',
    });
    // Same local-path ref → adapter should reuse cached file_id on second send.
    await instance.send({
      conversation: { channelId: 'tg-main', conversationId: '555' },
      content: { kind: 'file', file: { id: 'f', path: '/tmp/report.md' }, caption: 'again.' },
      idempotencyKey: 's3b',
    });
    await instance.stop();
    expect(calls.sendDocument).toHaveLength(2);
    expect(calls.sendDocument[0]?.document).toBe('/tmp/report.md');
    expect(calls.sendDocument[1]?.document).toBe('file_123');
  });

  test('send(voice) uses sendVoice', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.send({
      conversation: { channelId: 'tg-main', conversationId: '555' },
      content: { kind: 'voice', audio: { id: 'a', path: '/tmp/a.ogg' }, durationSec: 4 },
      idempotencyKey: 'v1',
    });
    await instance.stop();
    expect(calls.sendVoice).toHaveLength(1);
    expect(calls.sendVoice[0]?.duration).toBe(4);
  });

  test('maps 429 to ChannelRateLimitError so BaseChannelInstance retries', async () => {
    const rateLimitErr = new TelegramApiError('Too Many Requests', 'sendMessage', 429, {
      retry_after: 1,
    });
    const firstCallRateLimited = { fired: false };
    const { client, calls } = makeStubClient();
    // Wrap sendMessage to throw 429 once.
    const origSend = client.sendMessage;
    client.sendMessage = async (p) => {
      if (!firstCallRateLimited.fired) {
        firstCallRateLimited.fired = true;
        throw rateLimitErr;
      }
      return origSend(p);
    };
    const bus = createEventBus();
    const instance = new TelegramChannelInstance({
      config: baseConfig(),
      deps: deps(bus),
      client,
    });
    await instance.start();
    const sent = await instance.send({
      conversation: { channelId: 'tg-main', conversationId: '555' },
      content: { kind: 'text', text: 'hi' },
      idempotencyKey: 'rl',
    });
    await instance.stop();
    expect(sent.id).toBeDefined();
    // Second call (the retry) succeeds; calls.sendMessage captures only successful ones.
    expect(calls.sendMessage).toHaveLength(1);
    expect(instance.sendCountersSnapshot().rateLimitRetried).toBe(1);
  });

  test('setTyping issues sendChatAction', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.setTyping?.({ channelId: 'tg-main', conversationId: '555' }, 0);
    await instance.stop();
    expect(calls.sendChatAction).toHaveLength(1);
    expect(calls.sendChatAction[0]?.action).toBe('typing');
  });

  test('react issues setMessageReaction', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.react?.(
      { conversation: { channelId: 'tg-main', conversationId: '555' }, id: '10' },
      '👍',
    );
    await instance.stop();
    expect(calls.setMessageReaction).toHaveLength(1);
    expect(calls.setMessageReaction[0]?.reaction[0]?.emoji).toBe('👍');
  });

  test('edit + delete call the matching Bot API methods', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.edit?.(
      { conversation: { channelId: 'tg-main', conversationId: '555' }, id: '10' },
      { kind: 'text', text: 'updated.' },
    );
    await instance.delete?.({
      conversation: { channelId: 'tg-main', conversationId: '555' },
      id: '10',
    });
    await instance.stop();
    expect(calls.editMessageText).toHaveLength(1);
    expect(calls.editMessageText[0]?.text).toContain('updated');
    expect(calls.deleteMessage).toHaveLength(1);
  });

  test('uploadFile throws (no standalone upload on Bot API)', async () => {
    const { instance } = buildInstance();
    await instance.start();
    await expect(
      instance.uploadFile?.(
        { name: 'a.txt', mimeType: 'text/plain' },
        { channelId: 'tg-main', conversationId: '555' },
      ),
    ).rejects.toThrow(/not supported/);
    await instance.stop();
  });
});

describe('createTelegramAdapter', () => {
  test('validateConfig accepts a well-formed config', () => {
    const adapter = createTelegramAdapter();
    expect(() => adapter.validateConfig(baseConfig())).not.toThrow();
  });

  test('validateConfig rejects missing botToken', () => {
    const adapter = createTelegramAdapter();
    const bad = { ...baseConfig(), transport: { mode: 'long-polling' } };
    expect(() => adapter.validateConfig(bad)).toThrow(/botToken/);
  });

  test('create returns a TelegramChannelInstance with correct id', async () => {
    const { client } = makeStubClient();
    const adapter = createTelegramAdapter({ client });
    const bus = createEventBus();
    const instance = await adapter.create(baseConfig(), deps(bus));
    expect(instance.id).toBe('tg-main');
    expect(instance.type).toBe('telegram');
  });
});

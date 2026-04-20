import {
  type ChannelDependencies,
  ChannelRateLimitError,
  createChannelRegistry,
  createEventBus,
} from '@declaragent/core';
import type { Logger } from '@declaragent/core';
import { channelContractSuite } from '@declaragent/testkit/channels';
import type {
  SendDocumentParams,
  SendMessageParams,
  SendVoiceParams,
  TelegramClient,
} from './client.js';
import type { TelegramChannelConfig } from './config.js';
import { TelegramChannelInstance } from './instance.js';
import type { TelegramBotInfo, TelegramMessage, TelegramUpdate } from './telegram-api.js';

/**
 * Conformance run. Plugs a stub `TelegramClient` into the real
 * `TelegramChannelInstance` and hands it to the shared suite.
 */

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface Stub {
  client: TelegramClient;
  nextError: { err: Error | null };
}

function stubClient(): Stub {
  const nextError = { err: null as Error | null };
  const nextMessage = (chatId: number, id: number): TelegramMessage => ({
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
  });
  let msgSeq = 0;
  const client: TelegramClient = {
    getMe: async (): Promise<TelegramBotInfo> => ({
      id: 1,
      is_bot: true,
      first_name: 'Agent',
      username: 'agentbot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
    }),
    getUpdates: async (): Promise<TelegramUpdate[]> => [],
    setWebhook: async () => true,
    deleteWebhook: async () => true,
    sendMessage: async (params: SendMessageParams) => {
      if (nextError.err) {
        const err = nextError.err;
        nextError.err = null;
        throw err;
      }
      msgSeq += 1;
      return nextMessage(Number(params.chat_id), msgSeq);
    },
    sendDocument: async (params: SendDocumentParams) => {
      msgSeq += 1;
      return nextMessage(Number(params.chat_id), msgSeq);
    },
    sendVoice: async (params: SendVoiceParams) => {
      msgSeq += 1;
      return nextMessage(Number(params.chat_id), msgSeq);
    },
    editMessageText: async () => true,
    deleteMessage: async () => true,
    sendChatAction: async () => true,
    setMessageReaction: async () => true,
    answerCallbackQuery: async () => true,
  };
  return { client, nextError };
}

function buildFixture() {
  const { client, nextError } = stubClient();
  const bus = createEventBus();
  const deps: ChannelDependencies = {
    bus,
    logger: NOOP_LOGGER,
    configDir: '/tmp',
    channels: createChannelRegistry(),
  };
  const config: TelegramChannelConfig = {
    id: 'tg-contract',
    transport: { mode: 'long-polling', botToken: 'stub' },
    routing: {
      format: 'json',
      kindSelector: { const: 'chat.message' },
      targetSelector: { type: 'broadcast' },
    },
    delivery: {
      mode: 'at-least-once',
      ackStrategy: 'after-publish',
      maxRetries: 1,
      retryBackoff: { initialMs: 1, maxMs: 5, jitter: false },
      idempotency: { strategy: 'content-hash', ttlMs: 60_000, store: 'memory' },
    },
    limits: { concurrency: 4, maxInflight: 10 },
  };
  const instance = new TelegramChannelInstance({ config, deps, client });
  return { instance, client, nextError };
}

channelContractSuite('telegram', () => {
  const fx = buildFixture();
  let transportCount = 0;
  const originalSend = fx.client.sendMessage;
  fx.client.sendMessage = async (params) => {
    transportCount += 1;
    return originalSend(params);
  };
  return {
    instance: fx.instance,
    simulateRateLimit(retryAfterMs) {
      fx.nextError.err = new ChannelRateLimitError(retryAfterMs);
    },
    simulateError(message) {
      fx.nextError.err = new Error(message);
    },
    transportSendCount: () => transportCount,
    cleanup: async () => {
      await fx.instance.stop();
    },
  };
});

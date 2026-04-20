import {
  type ChannelDependencies,
  ChannelRateLimitError,
  createChannelRegistry,
  createEventBus,
} from '@declaragent/core';
import type { Logger } from '@declaragent/core';
import { channelContractSuite } from '@declaragent/testkit/channels';
import type {
  CreateGatewayTransportOptions,
  DiscordClient,
  DiscordSendMessageParams,
  GatewayEventHandler,
  GatewayTransport,
} from './client.js';
import type { DiscordChannelConfig } from './config.js';
import type { DiscordMessage } from './discord-api.js';
import { DiscordChannelInstance } from './instance.js';

/**
 * Conformance run. Plugs a stub `DiscordClient` into the real
 * `DiscordChannelInstance` and hands it to the shared suite.
 */

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface Stub {
  client: DiscordClient;
  nextError: { err: Error | null };
}

function stubClient(): Stub {
  const nextError = { err: null as Error | null };
  let msgSeq = 0;
  const nextMessage = (channelId: string, id: string): DiscordMessage => ({
    id,
    channel_id: channelId,
    author: { id: 'bot-1', username: 'agentbot', bot: true },
    content: '',
    timestamp: new Date().toISOString(),
  });
  let gatewayHandlers: GatewayEventHandler[] = [];
  const transport: GatewayTransport = {
    async connect() {},
    onEvent(handler) {
      gatewayHandlers.push(handler);
    },
    async close() {
      gatewayHandlers = [];
    },
  };
  const client: DiscordClient = {
    getCurrentUser: async () => ({
      id: 'bot-1',
      username: 'agentbot',
      bot: true,
    }),
    getGatewayBotInfo: async () => ({
      url: 'wss://example',
      shards: 1,
      session_start_limit: {
        total: 1000,
        remaining: 999,
        reset_after: 0,
        max_concurrency: 1,
      },
    }),
    getChannel: async (id) => ({ id, type: 0 }),
    sendMessage: async (params: DiscordSendMessageParams) => {
      if (nextError.err) {
        const err = nextError.err;
        nextError.err = null;
        throw err;
      }
      msgSeq += 1;
      return nextMessage(params.channelId, `msg-${msgSeq}`);
    },
    editMessage: async (params) => {
      msgSeq += 1;
      return nextMessage(params.channelId, params.messageId);
    },
    deleteMessage: async () => {},
    createReaction: async () => {},
    triggerTypingIndicator: async () => {},
    unarchiveThread: async () => {},
    registerGlobalCommands: async () => [],
    createInteractionResponse: async () => {},
    createFollowupMessage: async (_params) => {
      msgSeq += 1;
      return nextMessage('interaction', `fm-${msgSeq}`);
    },
    createGatewayTransport: (_opts: CreateGatewayTransportOptions) => transport,
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
  const config: DiscordChannelConfig = {
    id: 'discord-contract',
    transport: {
      botToken: 'stub',
      applicationId: 'app-1',
      intents: ['Guilds', 'GuildMessages', 'DirectMessages', 'GuildMessageReactions'],
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
      retryBackoff: { initialMs: 1, maxMs: 5, jitter: false },
      idempotency: { strategy: 'content-hash', ttlMs: 60_000, store: 'memory' },
    },
    limits: { concurrency: 4, maxInflight: 10 },
  };
  const instance = new DiscordChannelInstance({ config, deps, client });
  return { instance, client, nextError };
}

channelContractSuite('discord', () => {
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

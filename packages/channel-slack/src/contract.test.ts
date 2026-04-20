import {
  type ChannelDependencies,
  ChannelRateLimitError,
  createChannelRegistry,
  createEventBus,
} from '@declaragent/core';
import type { Logger } from '@declaragent/core';
import { channelContractSuite } from '@declaragent/testkit/channels';
import type {
  ChatDeleteParams,
  ChatPostMessageParams,
  ChatUpdateParams,
  ConversationsRepliesParams,
  FilesUploadV2Params,
  ReactionsAddParams,
  SlackClient,
} from './client.js';
import type { SlackChannelConfig } from './config.js';
import { SlackChannelInstance } from './instance.js';
import type {
  SlackAppsConnectionsOpenResponse,
  SlackAuthTestResponse,
  SlackConversationsRepliesResponse,
  SlackFilesUploadV2Response,
  SlackPostMessageResponse,
} from './slack-api.js';

/**
 * Conformance run. Plugs a stub `SlackClient` into the real
 * `SlackChannelInstance` and hands it to the shared suite.
 */

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface Stub {
  client: SlackClient;
  nextError: { err: Error | null };
}

function stubClient(): Stub {
  const nextError = { err: null as Error | null };
  let msgSeq = 0;
  const client: SlackClient = {
    async authTest(): Promise<SlackAuthTestResponse> {
      return {
        ok: true,
        url: 'https://declaragent-test.slack.com/',
        team: 'declaragent-test',
        user: 'agent-bot',
        team_id: 'T00000000',
        user_id: 'U00000001',
        bot_id: 'B00000001',
        response_metadata: {
          scopes: [
            'chat:write',
            'channels:history',
            'im:history',
            'app_mentions:read',
            'reactions:write',
          ],
        },
      };
    },
    async chatPostMessage(params: ChatPostMessageParams): Promise<SlackPostMessageResponse> {
      if (nextError.err) {
        const err = nextError.err;
        nextError.err = null;
        throw err;
      }
      msgSeq += 1;
      const ts = `1700000000.00000${msgSeq}`;
      return {
        ok: true,
        channel: params.channel,
        ts,
        message: {
          ts,
          text: params.text,
          ...(params.thread_ts !== undefined && { thread_ts: params.thread_ts }),
        },
      };
    },
    async chatUpdate(params: ChatUpdateParams): Promise<SlackPostMessageResponse> {
      return {
        ok: true,
        channel: params.channel,
        ts: params.ts,
        message: { ts: params.ts, text: params.text },
      };
    },
    async chatDelete(
      params: ChatDeleteParams,
    ): Promise<{ ok: boolean; channel?: string; ts?: string }> {
      return { ok: true, channel: params.channel, ts: params.ts };
    },
    async reactionsAdd(_params: ReactionsAddParams): Promise<{ ok: boolean }> {
      return { ok: true };
    },
    async conversationsReplies(
      _params: ConversationsRepliesParams,
    ): Promise<SlackConversationsRepliesResponse> {
      return { ok: true, messages: [] };
    },
    async filesUploadV2(params: FilesUploadV2Params): Promise<SlackFilesUploadV2Response> {
      const size = params.bytes?.byteLength;
      return {
        ok: true,
        files: [
          {
            id: 'F0FAKE',
            name: params.filename,
            ...(size !== undefined && { size }),
            permalink: `https://files.slack.com/${params.filename}`,
          },
        ],
      };
    },
    async appsConnectionsOpen(): Promise<SlackAppsConnectionsOpenResponse> {
      return { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=stub' };
    },
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
  const config: SlackChannelConfig = {
    id: 'slack-contract',
    transport: {
      mode: 'events',
      botToken: 'xoxb-stub',
      signingSecret: 'super-secret',
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
  const instance = new SlackChannelInstance({ config, deps, client });
  return { instance, client, nextError };
}

channelContractSuite('slack', () => {
  const fx = buildFixture();
  let transportCount = 0;
  const originalSend = fx.client.chatPostMessage;
  fx.client.chatPostMessage = async (params) => {
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

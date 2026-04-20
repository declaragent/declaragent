import {
  type ChannelDependencies,
  ChannelRateLimitError,
  createChannelRegistry,
  createEventBus,
} from '@declaragent/core';
import type { Logger } from '@declaragent/core';
import { channelContractSuite } from '@declaragent/testkit/channels';
import type {
  WhatsAppClient,
  WhatsAppCreateTemplateParams,
  WhatsAppMediaUrlResponse,
  WhatsAppSendInteractiveParams,
  WhatsAppSendMediaParams,
  WhatsAppSendReactionParams,
  WhatsAppSendTemplateParams,
  WhatsAppSendTextParams,
  WhatsAppSentResponse,
} from './client.js';
import type { WhatsAppChannelConfig } from './config.js';
import { WhatsAppChannelInstance } from './instance.js';
import type { WhatsAppPhoneNumberInfo, WhatsAppTemplate } from './whatsapp-api.js';

/**
 * Conformance run. Plugs a stub `WhatsAppClient` into the real
 * `WhatsAppChannelInstance` and hands it to the shared suite.
 *
 * Note: we disable the 24-hour conversation-window enforcement so the
 * contract's plain-text send asserts a direct `sendText` path rather
 * than the template fallback.
 */

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface Stub {
  client: WhatsAppClient;
  nextError: { err: Error | null };
}

function stubClient(): Stub {
  const nextError = { err: null as Error | null };
  let idSeq = 0;
  const mkResponse = (to: string): WhatsAppSentResponse => {
    idSeq += 1;
    return {
      messaging_product: 'whatsapp',
      contacts: [{ input: to, wa_id: to }],
      messages: [{ id: `wamid.${idSeq}` }],
    };
  };
  const client: WhatsAppClient = {
    sendText: async (p: WhatsAppSendTextParams) => {
      if (nextError.err) {
        const err = nextError.err;
        nextError.err = null;
        throw err;
      }
      return mkResponse(p.to);
    },
    sendInteractive: async (p: WhatsAppSendInteractiveParams) => mkResponse(p.to),
    sendTemplate: async (p: WhatsAppSendTemplateParams) => mkResponse(p.to),
    sendMedia: async (p: WhatsAppSendMediaParams) => mkResponse(p.to),
    sendReaction: async (p: WhatsAppSendReactionParams) => mkResponse(p.to),
    getMedia: async (id: string): Promise<WhatsAppMediaUrlResponse> => ({
      url: `https://lookaside.fbsbx.com/whatsapp_business/${id}`,
      mime_type: 'image/jpeg',
      sha256: 'deadbeef',
      file_size: 1024,
      id,
      messaging_product: 'whatsapp',
    }),
    downloadMedia: async (_url: string) => new Uint8Array([1, 2, 3]),
    listTemplates: async (): Promise<WhatsAppTemplate[]> => [],
    createTemplate: async (p: WhatsAppCreateTemplateParams): Promise<WhatsAppTemplate> => ({
      name: p.name,
      language: p.language,
      components: p.components,
      status: 'PENDING',
    }),
    getPhoneNumber: async (): Promise<WhatsAppPhoneNumberInfo> => ({
      id: 'phone-1',
      display_phone_number: '+15555551212',
      verified_name: 'Test',
      quality_rating: 'GREEN',
      messaging_limit_tier: 'TIER_1000',
    }),
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
  const config: WhatsAppChannelConfig = {
    id: 'wa-contract',
    transport: {
      provider: 'meta-cloud',
      phoneNumberId: '123',
      businessAccountId: '456',
      accessToken: 'stub-token',
      webhookVerifyToken: 'verify-token',
      webhookAppSecret: 'app-secret',
    },
    policy: {
      enforceConversationWindow: false,
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
  const instance = new WhatsAppChannelInstance({ config, deps, client });
  return { instance, client, nextError };
}

channelContractSuite('whatsapp', () => {
  const fx = buildFixture();
  let transportCount = 0;
  const originalSend = fx.client.sendText;
  fx.client.sendText = async (params) => {
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

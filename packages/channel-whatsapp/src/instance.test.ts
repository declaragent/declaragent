import { describe, expect, test } from 'bun:test';
import {
  type AgentEvent,
  type ChannelDependencies,
  type ConversationStateStore,
  type Logger,
  createChannelRegistry,
  createEventBus,
  hmacSha256Hex,
} from '@declaragent/core';
import { createWhatsAppAdapter } from './adapter.js';
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
import { WhatsAppApiError } from './client.js';
import type { WhatsAppChannelConfig } from './config.js';
import {
  WhatsAppChannelInstance,
  type WhatsAppFileCache,
  WhatsAppTemplateError,
} from './instance.js';
import type {
  WhatsAppPhoneNumberInfo,
  WhatsAppTemplate,
  WhatsAppWebhookBody,
} from './whatsapp-api.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function mkLogger(records: { warn: unknown[][]; info: unknown[][] }): Logger {
  const logger: Logger = {
    debug() {},
    info: (...args: unknown[]) => records.info.push(args),
    warn: (...args: unknown[]) => records.warn.push(args),
    error() {},
    child: () => logger,
  };
  return logger;
}

interface StubCalls {
  sendText: WhatsAppSendTextParams[];
  sendInteractive: WhatsAppSendInteractiveParams[];
  sendTemplate: WhatsAppSendTemplateParams[];
  sendMedia: WhatsAppSendMediaParams[];
  sendReaction: WhatsAppSendReactionParams[];
  getMedia: string[];
  downloadMedia: string[];
  listTemplates: number;
  createTemplate: WhatsAppCreateTemplateParams[];
  getPhoneNumber: number;
}

interface StubOptions {
  sendTextError?: () => unknown;
}

function makeStubClient(opts: StubOptions = {}): { client: WhatsAppClient; calls: StubCalls } {
  const calls: StubCalls = {
    sendText: [],
    sendInteractive: [],
    sendTemplate: [],
    sendMedia: [],
    sendReaction: [],
    getMedia: [],
    downloadMedia: [],
    listTemplates: 0,
    createTemplate: [],
    getPhoneNumber: 0,
  };
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
    sendText: async (p) => {
      if (opts.sendTextError) throw opts.sendTextError();
      calls.sendText.push(p);
      return mkResponse(p.to);
    },
    sendInteractive: async (p) => {
      calls.sendInteractive.push(p);
      return mkResponse(p.to);
    },
    sendTemplate: async (p) => {
      calls.sendTemplate.push(p);
      return mkResponse(p.to);
    },
    sendMedia: async (p) => {
      calls.sendMedia.push(p);
      return mkResponse(p.to);
    },
    sendReaction: async (p) => {
      calls.sendReaction.push(p);
      return mkResponse(p.to);
    },
    getMedia: async (id) => {
      calls.getMedia.push(id);
      const resp: WhatsAppMediaUrlResponse = {
        url: `https://lookaside.fbsbx.com/whatsapp_business/${id}`,
        mime_type: 'image/jpeg',
        sha256: 'deadbeef',
        file_size: 1024,
        id,
        messaging_product: 'whatsapp',
      };
      return resp;
    },
    downloadMedia: async (url) => {
      calls.downloadMedia.push(url);
      return new Uint8Array([1, 2, 3]);
    },
    listTemplates: async () => {
      calls.listTemplates += 1;
      return [];
    },
    createTemplate: async (p) => {
      calls.createTemplate.push(p);
      const tpl: WhatsAppTemplate = {
        name: p.name,
        language: p.language,
        components: p.components,
        status: 'PENDING',
      };
      return tpl;
    },
    getPhoneNumber: async () => {
      calls.getPhoneNumber += 1;
      const info: WhatsAppPhoneNumberInfo = {
        id: 'phone-1',
        display_phone_number: '+15555551212',
        verified_name: 'Test',
        quality_rating: 'GREEN',
        messaging_limit_tier: 'TIER_1000',
      };
      return info;
    },
  };
  return { client, calls };
}

function baseConfig(overrides: Partial<WhatsAppChannelConfig> = {}): WhatsAppChannelConfig {
  return {
    id: 'wa-main',
    transport: {
      provider: 'meta-cloud',
      phoneNumberId: '123',
      businessAccountId: '456',
      accessToken: 'test-token',
      webhookVerifyToken: 'verify-token',
      webhookAppSecret: 'app-secret',
    },
    policy: {
      enforceConversationWindow: true,
      outsideWindowAction: 'template',
      defaultTemplate: 'checkin_reminder_v1',
    },
    templates: [
      { name: 'checkin_reminder_v1', language: 'en_US', parameterNames: ['summary'] },
      { name: 'order_update_v1', language: 'en_US', parameterNames: ['orderId', 'status'] },
    ],
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
  bus = createEventBus(),
  logger: Logger = NOOP_LOGGER,
  conversationStore?: ConversationStateStore,
): ChannelDependencies {
  const d: ChannelDependencies = {
    bus,
    logger,
    configDir: '/tmp',
    channels: createChannelRegistry(),
  };
  if (conversationStore) d.conversationStore = conversationStore;
  return d;
}

function buildInstance(
  configOverrides: Partial<WhatsAppChannelConfig> = {},
  stubOpts: StubOptions = {},
  extra: {
    logger?: Logger;
    now?: () => number;
    conversationStore?: ConversationStateStore;
    fileCache?: WhatsAppFileCache;
  } = {},
): {
  instance: WhatsAppChannelInstance;
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
  const instanceOpts: ConstructorParameters<typeof WhatsAppChannelInstance>[0] = {
    config: baseConfig(configOverrides),
    deps: deps(bus, extra.logger ?? NOOP_LOGGER, extra.conversationStore),
    client,
  };
  if (extra.now !== undefined) instanceOpts.now = extra.now;
  if (extra.fileCache !== undefined) instanceOpts.fileCache = extra.fileCache;
  const instance = new WhatsAppChannelInstance(instanceOpts);
  return { instance, calls, bus, events };
}

function makeMemStore(): ConversationStateStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key);
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

async function signedPost(secret: string, body: string): Promise<Record<string, string>> {
  const sig = await hmacSha256Hex(secret, body);
  return { 'x-hub-signature-256': `sha256=${sig}` };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('WhatsAppChannelInstance — lifecycle', () => {
  test('doStart warms template cache from config', async () => {
    const { instance } = buildInstance();
    await instance.start();
    expect(instance.templateNames()).toContain('checkin_reminder_v1');
    expect(instance.templateNames()).toContain('order_update_v1');
    await instance.stop();
  });

  test('doStop clears outstanding queued messages', async () => {
    const now = () => 1_000_000;
    const { instance } = buildInstance(
      {
        policy: {
          enforceConversationWindow: true,
          outsideWindowAction: 'queue',
        },
      },
      {},
      { now },
    );
    await instance.start();
    await instance.send({
      conversation: { channelId: 'wa-main', conversationId: '15555550001' },
      content: { kind: 'text', text: 'hi' },
      idempotencyKey: 'q-stop',
    });
    expect(instance.queueLength('15555550001')).toBe(1);
    await instance.stop();
    expect(instance.queueLength('15555550001')).toBe(0);
  });
});

describe('WhatsAppChannelInstance — webhook GET verification', () => {
  test('matching verify token returns the challenge body', async () => {
    const { instance } = buildInstance();
    await instance.start();
    const resp = await instance.handleWebhook?.({
      method: 'GET',
      path: '/',
      headers: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': 'abc123',
      },
      body: new Uint8Array(),
    });
    expect(resp?.status).toBe(200);
    expect(resp?.body).toBe('abc123');
    await instance.stop();
  });

  test('mismatched verify token returns 403', async () => {
    const { instance } = buildInstance();
    await instance.start();
    const resp = await instance.handleWebhook?.({
      method: 'GET',
      path: '/',
      headers: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': 'abc123',
      },
      body: new Uint8Array(),
    });
    expect(resp?.status).toBe(403);
    await instance.stop();
  });
});

describe('WhatsAppChannelInstance — webhook POST signature', () => {
  test('valid HMAC accepted; inbound published', async () => {
    const { instance, events } = buildInstance();
    await instance.start();
    const body: WhatsAppWebhookBody = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+15555551212', phone_number_id: '123' },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '15555550001' }],
                messages: [
                  {
                    id: 'wamid.1',
                    from: '15555550001',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(body);
    const headers = await signedPost('app-secret', raw);
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers,
      body: new TextEncoder().encode(raw),
    });
    expect(resp?.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('chat.dm');
    await instance.stop();
  });

  test('bad signature returns 401', async () => {
    const { instance } = buildInstance();
    await instance.start();
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: {
        'x-hub-signature-256':
          'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: new TextEncoder().encode(raw),
    });
    expect(resp?.status).toBe(401);
    await instance.stop();
  });

  test('missing signature returns 401', async () => {
    const { instance } = buildInstance();
    await instance.start();
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers: {},
      body: new TextEncoder().encode(raw),
    });
    expect(resp?.status).toBe(401);
    await instance.stop();
  });
});

describe('WhatsAppChannelInstance — inbound classification', () => {
  async function runInbound(body: WhatsAppWebhookBody): Promise<AgentEvent[]> {
    const { instance, events } = buildInstance();
    await instance.start();
    const raw = JSON.stringify(body);
    const headers = await signedPost('app-secret', raw);
    await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers,
      body: new TextEncoder().encode(raw),
    });
    await instance.stop();
    return events;
  }

  test('text → chat.dm with principal displayName', async () => {
    const events = await runInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'w1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+15555551212', phone_number_id: '123' },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '15555550001' }],
                messages: [
                  {
                    id: 'wamid.t',
                    from: '15555550001',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('chat.dm');
    expect(events[0]?.meta?.principal?.displayName).toBe('Alice');
  });

  test('interactive button_reply → channel.interaction with buttonId', async () => {
    const events = await runInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'w2',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+15555551212', phone_number_id: '123' },
                messages: [
                  {
                    id: 'wamid.i',
                    from: '15555550001',
                    timestamp: '1700000000',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: 'yes', title: 'Yes' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]?.kind).toBe('channel.interaction');
    const payload = events[0]?.payload as { buttonId?: string; interaction?: string };
    expect(payload.interaction).toBe('button');
    expect(payload.buttonId).toBe('yes');
  });

  test('image → chat.file', async () => {
    const events = await runInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'w3',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+15555551212', phone_number_id: '123' },
                messages: [
                  {
                    id: 'wamid.img',
                    from: '15555550001',
                    timestamp: '1700000000',
                    type: 'image',
                    image: { id: 'media-1', mime_type: 'image/jpeg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]?.kind).toBe('chat.file');
  });

  test('audio → chat.voice', async () => {
    const events = await runInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'w4',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+15555551212', phone_number_id: '123' },
                messages: [
                  {
                    id: 'wamid.aud',
                    from: '15555550001',
                    timestamp: '1700000000',
                    type: 'audio',
                    audio: { id: 'media-a', mime_type: 'audio/ogg', voice: true },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]?.kind).toBe('chat.voice');
  });

  test('reaction → channel.reaction', async () => {
    const events = await runInbound({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'w5',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+15555551212', phone_number_id: '123' },
                messages: [
                  {
                    id: 'wamid.r',
                    from: '15555550001',
                    timestamp: '1700000000',
                    type: 'reaction',
                    reaction: { message_id: 'wamid.orig', emoji: '❤️' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events[0]?.kind).toBe('channel.reaction');
    expect((events[0]?.payload as { emoji?: string }).emoji).toBe('❤️');
  });
});

describe('WhatsAppChannelInstance — media download', () => {
  test('inbound image triggers getMedia + downloadMedia on the stub client', async () => {
    const seen: {
      mediaId: string;
      bytes: Uint8Array;
      meta: { mimeType?: string; mediaType: string };
    }[] = [];
    const fileCache: WhatsAppFileCache = {
      async put(mediaId, bytes, meta) {
        seen.push({ mediaId, bytes, meta });
      },
    };
    const { instance, calls } = buildInstance({}, {}, { fileCache });
    await instance.start();
    const body: WhatsAppWebhookBody = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'wm',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '+15555551212', phone_number_id: '123' },
                messages: [
                  {
                    id: 'wamid.img',
                    from: '15555550001',
                    timestamp: '1700000000',
                    type: 'image',
                    image: { id: 'media-xyz', mime_type: 'image/jpeg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(body);
    const headers = await signedPost('app-secret', raw);
    await instance.handleWebhook?.({
      method: 'POST',
      path: '/',
      headers,
      body: new TextEncoder().encode(raw),
    });
    // The fetch is fire-and-forget; flush microtasks.
    for (let i = 0; i < 10 && calls.downloadMedia.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await instance.stop();
    expect(calls.getMedia).toContain('media-xyz');
    expect(calls.downloadMedia).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.mediaId).toBe('media-xyz');
  });
});

describe('WhatsAppChannelInstance — window tracker', () => {
  test('recordInbound + isInWindow interplay', async () => {
    const { instance } = buildInstance({}, {}, { now: () => 1_000_000 });
    await instance.start();
    expect(await instance.window.isInWindow('15555550001', 1_000_000)).toBe(false);
    await instance.window.recordInbound('15555550001', 1_000_000);
    expect(await instance.window.isInWindow('15555550001', 1_000_000)).toBe(true);
    const justAfter = 1_000_000 + 24 * 60 * 60 * 1000 - 1;
    expect(await instance.window.isInWindow('15555550001', justAfter)).toBe(true);
    const past = 1_000_000 + 24 * 60 * 60 * 1000 + 1;
    expect(await instance.window.isInWindow('15555550001', past)).toBe(false);
    await instance.stop();
  });

  test('window state round-trips through ConversationStateStore', async () => {
    const store = makeMemStore();
    const now = () => 5_000_000;
    const build1 = buildInstance({}, {}, { now, conversationStore: store });
    await build1.instance.start();
    await build1.instance.window.recordInbound('15555550001', 5_000_000);
    await build1.instance.stop();

    // Fresh instance, shared store — window survives restart.
    const build2 = buildInstance({}, {}, { now, conversationStore: store });
    await build2.instance.start();
    expect(await build2.instance.window.isInWindow('15555550001', 5_000_000)).toBe(true);
    await build2.instance.stop();
  });
});

describe('WhatsAppChannelInstance — outbound in-window', () => {
  test('plain text → sendText', async () => {
    const now = () => 1_000_000;
    const { instance, calls } = buildInstance({}, {}, { now });
    await instance.start();
    await instance.window.recordInbound('15555550001', 1_000_000);
    const sent = await instance.send({
      conversation: { channelId: 'wa-main', conversationId: '15555550001' },
      content: { kind: 'text', text: 'hi' },
      idempotencyKey: 't1',
    });
    await instance.stop();
    expect(calls.sendText).toHaveLength(1);
    expect(calls.sendText[0]?.body).toBe('hi');
    expect(sent.id).toMatch(/^wamid/);
  });

  test('rich with ≤3 buttons → sendInteractive (button variant)', async () => {
    const now = () => 1_000_000;
    const { instance, calls } = buildInstance({}, {}, { now });
    await instance.start();
    await instance.window.recordInbound('15555550001', 1_000_000);
    await instance.send({
      conversation: { channelId: 'wa-main', conversationId: '15555550001' },
      content: {
        kind: 'rich',
        blocks: [
          { kind: 'paragraph', text: 'Pick one' },
          {
            kind: 'button-row',
            buttons: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ],
      },
      idempotencyKey: 'i1',
    });
    await instance.stop();
    expect(calls.sendInteractive).toHaveLength(1);
    expect(calls.sendInteractive[0]?.interactive.type).toBe('button');
  });

  test('template → sendTemplate (with ordered body params)', async () => {
    const now = () => 1_000_000;
    const { instance, calls } = buildInstance({}, {}, { now });
    await instance.start();
    await instance.window.recordInbound('15555550001', 1_000_000);
    await instance.send({
      conversation: { channelId: 'wa-main', conversationId: '15555550001' },
      content: {
        kind: 'template',
        name: 'order_update_v1',
        params: { orderId: 'A-1', status: 'shipped' },
      },
      idempotencyKey: 'tpl1',
    });
    await instance.stop();
    expect(calls.sendTemplate).toHaveLength(1);
    const comp = calls.sendTemplate[0]?.components;
    expect(comp?.[0]?.parameters).toEqual([
      { type: 'text', text: 'A-1' },
      { type: 'text', text: 'shipped' },
    ]);
  });
});

describe('WhatsAppChannelInstance — outbound out-of-window policy', () => {
  test('drop: warns + returns placeholder, no client call', async () => {
    const records = { warn: [] as unknown[][], info: [] as unknown[][] };
    const now = () => 1_000_000;
    const { instance, calls } = buildInstance(
      {
        policy: {
          enforceConversationWindow: true,
          outsideWindowAction: 'drop',
        },
      },
      {},
      { now, logger: mkLogger(records) },
    );
    await instance.start();
    const sent = await instance.send({
      conversation: { channelId: 'wa-main', conversationId: '15555550001' },
      content: { kind: 'text', text: 'hi' },
      idempotencyKey: 'd1',
    });
    await instance.stop();
    expect(calls.sendText).toHaveLength(0);
    expect(calls.sendTemplate).toHaveLength(0);
    expect(sent.id).toBe('dropped');
    expect(records.warn.find((w) => w[0] === 'whatsapp.outside_window.dropped')).toBeDefined();
  });

  test('template: falls back to default template via sendTemplate', async () => {
    const now = () => 1_000_000;
    const { instance, calls } = buildInstance({}, {}, { now });
    await instance.start();
    // No recordInbound → out of window.
    await instance.send({
      conversation: { channelId: 'wa-main', conversationId: '15555550001' },
      content: { kind: 'text', text: 'hello from outside' },
      idempotencyKey: 'tpl-fallback',
    });
    await instance.stop();
    expect(calls.sendText).toHaveLength(0);
    expect(calls.sendTemplate).toHaveLength(1);
    expect(calls.sendTemplate[0]?.name).toBe('checkin_reminder_v1');
    const params = calls.sendTemplate[0]?.components?.[0]?.parameters ?? [];
    expect(params[0]?.text).toBe('hello from outside');
  });

  test('queue: stashes pending sends + logs queue info', async () => {
    const records = { warn: [] as unknown[][], info: [] as unknown[][] };
    const now = () => 1_000_000;
    const { instance, calls } = buildInstance(
      {
        policy: {
          enforceConversationWindow: true,
          outsideWindowAction: 'queue',
        },
      },
      {},
      { now, logger: mkLogger(records) },
    );
    await instance.start();
    const sent = await instance.send({
      conversation: { channelId: 'wa-main', conversationId: '15555550001' },
      content: { kind: 'text', text: 'queued message' },
      idempotencyKey: 'q1',
    });
    expect(calls.sendText).toHaveLength(0);
    expect(sent.id).toBe('queued');
    expect(instance.queueLength('15555550001')).toBe(1);
    expect(records.info.find((i) => i[0] === 'whatsapp.outside_window.queued')).toBeDefined();
    await instance.stop();
  });
});

describe('WhatsAppChannelInstance — template validation', () => {
  test('unknown template name throws WhatsAppTemplateError', async () => {
    const now = () => 1_000_000;
    const { instance } = buildInstance({}, {}, { now });
    await instance.start();
    await instance.window.recordInbound('15555550001', 1_000_000);
    await expect(
      instance.send({
        conversation: { channelId: 'wa-main', conversationId: '15555550001' },
        content: {
          kind: 'template',
          name: 'not_registered_v1',
          params: {},
        },
        idempotencyKey: 'tpl-bad',
      }),
    ).rejects.toBeInstanceOf(WhatsAppTemplateError);
    await instance.stop();
  });
});

describe('WhatsAppChannelInstance — rate limiting', () => {
  test('429 maps to ChannelRateLimitError + retries once', async () => {
    const now = () => 1_000_000;
    const first = { fired: false };
    const { client, calls } = makeStubClient();
    const origSend = client.sendText;
    client.sendText = async (p) => {
      if (!first.fired) {
        first.fired = true;
        throw new WhatsAppApiError('rate limit', 'sendText', undefined, undefined, 1, 'trace', 429);
      }
      return origSend(p);
    };
    const bus = createEventBus();
    const instance = new WhatsAppChannelInstance({
      config: baseConfig(),
      deps: deps(bus),
      client,
      now,
      // Make the built-in sleep cheap so the test stays fast.
    });
    await instance.start();
    await instance.window.recordInbound('15555550001', 1_000_000);
    const sent = await instance.send({
      conversation: { channelId: 'wa-main', conversationId: '15555550001' },
      content: { kind: 'text', text: 'hi' },
      idempotencyKey: 'rl',
    });
    await instance.stop();
    expect(sent.id).toMatch(/^wamid/);
    expect(calls.sendText).toHaveLength(1); // only the retry succeeded
    expect(instance.sendCountersSnapshot().rateLimitRetried).toBe(1);
  });
});

describe('WhatsAppChannelInstance — unsupported surfaces', () => {
  test('edit + delete + uploadFile + setTyping + performAction all throw', async () => {
    const { instance } = buildInstance();
    await instance.start();
    await expect(
      instance.edit?.(
        { conversation: { channelId: 'wa-main', conversationId: '15555550001' }, id: 'x' },
        { kind: 'text', text: 'nope' },
      ),
    ).rejects.toThrow(/not supported/);
    await expect(
      instance.delete?.({
        conversation: { channelId: 'wa-main', conversationId: '15555550001' },
        id: 'x',
      }),
    ).rejects.toThrow(/not supported/);
    await expect(
      instance.uploadFile?.(
        { name: 'a.txt', mimeType: 'text/plain' },
        { channelId: 'wa-main', conversationId: '15555550001' },
      ),
    ).rejects.toThrow(/not supported/);
    await expect(
      instance.setTyping?.({ channelId: 'wa-main', conversationId: '15555550001' }, 1_000),
    ).rejects.toThrow(/not supported/);
    await expect(
      instance.performAction?.({
        kind: 'pin',
        ref: {
          conversation: { channelId: 'wa-main', conversationId: '15555550001' },
          id: 'x',
        },
      }),
    ).rejects.toThrow(/not supported/);
    await instance.stop();
  });

  test('react calls sendReaction', async () => {
    const now = () => 1_000_000;
    const { instance, calls } = buildInstance({}, {}, { now });
    await instance.start();
    await instance.react?.(
      { conversation: { channelId: 'wa-main', conversationId: '15555550001' }, id: 'wamid.orig' },
      '👍',
    );
    await instance.stop();
    expect(calls.sendReaction).toHaveLength(1);
    expect(calls.sendReaction[0]?.emoji).toBe('👍');
  });
});

describe('createWhatsAppAdapter', () => {
  test('validateConfig accepts a well-formed config', () => {
    const adapter = createWhatsAppAdapter();
    expect(() => adapter.validateConfig(baseConfig())).not.toThrow();
  });

  test('validateConfig rejects group mode', () => {
    const adapter = createWhatsAppAdapter();
    const bad = { ...baseConfig(), groupMode: true };
    expect(() => adapter.validateConfig(bad)).toThrow(/group mode is not supported/);
  });

  test('validateConfig rejects outsideWindowAction === "template" with no defaultTemplate', () => {
    const adapter = createWhatsAppAdapter();
    const cfg = baseConfig({
      policy: { enforceConversationWindow: true, outsideWindowAction: 'template' },
    });
    expect(() => adapter.validateConfig(cfg)).toThrow(/defaultTemplate/);
  });

  test('create returns a WhatsAppChannelInstance with correct id + type', async () => {
    const { client } = makeStubClient();
    const adapter = createWhatsAppAdapter({ client });
    const bus = createEventBus();
    const instance = await adapter.create(baseConfig(), deps(bus));
    expect(instance.id).toBe('wa-main');
    expect(instance.type).toBe('whatsapp');
  });
});

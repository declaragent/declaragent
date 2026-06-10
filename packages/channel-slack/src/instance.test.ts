import { describe, expect, test } from 'bun:test';
import {
  type AgentEvent,
  type ChannelDependencies,
  ChannelRateLimitError,
  type Logger,
  createChannelRegistry,
  createEventBus,
  hmacSha256Hex,
} from '@declaragent/core';
import { createSlackAdapter } from './adapter.js';
import type {
  ChatDeleteParams,
  ChatPostMessageParams,
  ChatUpdateParams,
  ConversationsRepliesParams,
  FilesUploadV2Params,
  ReactionsAddParams,
  SlackClient,
  SlackSocketHandler,
  SocketModeTransport,
} from './client.js';
import { SlackApiError } from './client.js';
import type { SlackChannelConfig } from './config.js';
import { SlackChannelInstance } from './instance.js';
import type {
  SlackAuthTestResponse,
  SlackBlockActionsPayload,
  SlackConversationsRepliesResponse,
  SlackEventWrapper,
  SlackFilesUploadV2Response,
  SlackPostMessageResponse,
  SlackSlashCommandPayload,
  SlackSocketFrame,
} from './slack-api.js';

// ── Fixtures ────────────────────────────────────────────────────────────

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

interface StubCalls {
  authTest: number;
  appsConnectionsOpen: number;
  chatPostMessage: ChatPostMessageParams[];
  chatUpdate: ChatUpdateParams[];
  chatDelete: ChatDeleteParams[];
  reactionsAdd: ReactionsAddParams[];
  conversationsReplies: ConversationsRepliesParams[];
  filesUploadV2: FilesUploadV2Params[];
}

interface StubOptions {
  authGranted?: string[];
  authTeam?: string;
  chatPostMessageError?: () => unknown;
  chatPostMessageResult?: (params: ChatPostMessageParams) => SlackPostMessageResponse;
}

function makeStubClient(opts: StubOptions = {}): { client: SlackClient; calls: StubCalls } {
  const calls: StubCalls = {
    authTest: 0,
    appsConnectionsOpen: 0,
    chatPostMessage: [],
    chatUpdate: [],
    chatDelete: [],
    reactionsAdd: [],
    conversationsReplies: [],
    filesUploadV2: [],
  };
  const defaultResult = (params: ChatPostMessageParams): SlackPostMessageResponse => {
    const idx = calls.chatPostMessage.length; // length *before* push
    const ts = `1700000000.00000${idx}`;
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
  };
  const client: SlackClient = {
    async authTest(): Promise<SlackAuthTestResponse> {
      calls.authTest += 1;
      return {
        ok: true,
        team: opts.authTeam ?? 'declaragent-test',
        user: 'agent-bot',
        team_id: 'T00000000',
        user_id: 'U00000001',
        response_metadata: {
          scopes: opts.authGranted ?? [
            'chat:write',
            'channels:history',
            'im:history',
            'app_mentions:read',
            'reactions:write',
          ],
        },
      };
    },
    async appsConnectionsOpen() {
      calls.appsConnectionsOpen += 1;
      return { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=stub' };
    },
    async chatPostMessage(params) {
      if (opts.chatPostMessageError) throw opts.chatPostMessageError();
      calls.chatPostMessage.push(params);
      return (opts.chatPostMessageResult ?? defaultResult)(params);
    },
    async chatUpdate(params) {
      calls.chatUpdate.push(params);
      return {
        ok: true,
        channel: params.channel,
        ts: params.ts,
        message: { ts: params.ts, text: params.text },
      };
    },
    async chatDelete(params) {
      calls.chatDelete.push(params);
      return { ok: true, channel: params.channel, ts: params.ts };
    },
    async reactionsAdd(params) {
      calls.reactionsAdd.push(params);
      return { ok: true };
    },
    async conversationsReplies(params): Promise<SlackConversationsRepliesResponse> {
      calls.conversationsReplies.push(params);
      return { ok: true, messages: [] };
    },
    async filesUploadV2(params): Promise<SlackFilesUploadV2Response> {
      calls.filesUploadV2.push(params);
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
  };
  return { client, calls };
}

function makeStubSocket(): {
  transport: SocketModeTransport;
  dispatch(frame: SlackSocketFrame): Promise<void>;
  connects: number;
  closes: number;
} {
  let handler: SlackSocketHandler | null = null;
  let connects = 0;
  let closes = 0;
  const state = {
    get connects() {
      return connects;
    },
    get closes() {
      return closes;
    },
  };
  let connected = false;
  const transport: SocketModeTransport = {
    async connect() {
      connects += 1;
      connected = true;
    },
    onEvent(h) {
      handler = h;
    },
    connected() {
      return connected;
    },
    async close() {
      closes += 1;
      connected = false;
    },
  };
  return {
    transport,
    async dispatch(frame) {
      if (handler) await handler(frame);
    },
    get connects() {
      return state.connects;
    },
    get closes() {
      return state.closes;
    },
  };
}

function baseConfig(overrides: Partial<SlackChannelConfig> = {}): SlackChannelConfig {
  return {
    id: 'slack-main',
    transport: {
      mode: 'events',
      botToken: 'xoxb-test',
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

interface BuiltInstance {
  instance: SlackChannelInstance;
  calls: StubCalls;
  bus: ReturnType<typeof createEventBus>;
  events: AgentEvent[];
  socket: ReturnType<typeof makeStubSocket>;
}

function buildInstance(
  configOverrides: Partial<SlackChannelConfig> = {},
  stubOpts: StubOptions = {},
  extras: { nowMs?: () => number; useSocket?: boolean } = {},
): BuiltInstance {
  const { client, calls } = makeStubClient(stubOpts);
  const bus = createEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe('*', (e) => {
    events.push(e);
  });
  const socket = makeStubSocket();
  const useSocket = extras.useSocket === true || configOverrides.transport?.mode === 'socket';
  const instance = new SlackChannelInstance({
    config: baseConfig(configOverrides),
    deps: deps(bus),
    client,
    ...(useSocket && { socketTransport: socket.transport }),
    ...(extras.nowMs !== undefined && { now: extras.nowMs }),
  });
  return { instance, calls, bus, events, socket };
}

// Build an HMAC-signed Events API request for a given body + timestamp.
async function signedRequest(
  body: string,
  tsSec: number,
  signingSecret: string,
): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  const sig = await hmacSha256Hex(signingSecret, `v0:${tsSec}:${body}`);
  return {
    body: new TextEncoder().encode(body),
    headers: {
      'x-slack-request-timestamp': String(tsSec),
      'x-slack-signature': `v0=${sig}`,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('SlackChannelInstance — lifecycle', () => {
  test('events mode: start → auth.test preflight', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.stop();
    expect(calls.authTest).toBe(1);
  });

  test('socket mode: start opens socket; stop closes', async () => {
    const { instance, socket } = buildInstance(
      { transport: { mode: 'socket', botToken: 'xoxb', appToken: 'xapp', signingSecret: 'ss' } },
      {},
      { useSocket: true },
    );
    await instance.start();
    expect(socket.connects).toBe(1);
    await instance.stop();
    expect(socket.closes).toBe(1);
  });

  test('scope preflight warns when a required scope is missing', async () => {
    const warnings: unknown[][] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args) => warnings.push(args),
      error() {},
      child: () => logger,
    };
    const { client } = makeStubClient({
      authGranted: ['channels:history', 'im:history', 'app_mentions:read', 'reactions:write'],
      // chat:write intentionally missing
    });
    const bus = createEventBus();
    const instance = new SlackChannelInstance({
      config: baseConfig(),
      deps: { bus, logger, configDir: '/tmp', channels: createChannelRegistry() },
      client,
    });
    await instance.start();
    await instance.stop();
    const scopeWarn = warnings.find((w) => w[0] === 'slack.scopes.missing');
    expect(scopeWarn).toBeDefined();
    const data = scopeWarn?.[1] as { missing?: string[] };
    expect(data.missing).toContain('chat:write');
  });
});

describe('SlackChannelInstance — Events API webhook', () => {
  test('url_verification returns challenge body', async () => {
    const { instance } = buildInstance();
    await instance.start();
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/slack/events',
      headers: {},
      body: new TextEncoder().encode(
        JSON.stringify({ type: 'url_verification', token: 't', challenge: 'abc' }),
      ),
    });
    await instance.stop();
    expect(resp?.status).toBe(200);
    expect(resp?.body).toBe('abc');
  });

  test('good signature is accepted', async () => {
    const { instance, events } = buildInstance();
    await instance.start();
    const tsSec = Math.floor(Date.now() / 1000);
    const wrapper: SlackEventWrapper = {
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C0XYZ',
        channel_type: 'channel',
        user: 'U01',
        text: 'hello',
        ts: '1702345678.000100',
      },
    };
    const body = JSON.stringify(wrapper);
    const req = await signedRequest(body, tsSec, 'super-secret');
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/slack/events',
      headers: req.headers,
      body: req.body,
    });
    await instance.stop();
    expect(resp?.status).toBe(200);
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe('chat.message');
  });

  test('bad signature is rejected with 401', async () => {
    const { instance } = buildInstance();
    await instance.start();
    const tsSec = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/slack/events',
      headers: {
        'x-slack-request-timestamp': String(tsSec),
        'x-slack-signature': 'v0=deadbeef',
      },
      body: new TextEncoder().encode(body),
    });
    await instance.stop();
    expect(resp?.status).toBe(401);
  });

  test('stale timestamp is rejected', async () => {
    // Fix the clock so we can force a stale timestamp.
    const now = 1_700_000_000_000;
    const { instance } = buildInstance({}, {}, { nowMs: () => now });
    await instance.start();
    const staleSec = Math.floor(now / 1000) - 60 * 10; // 10 min ago
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', channel: 'C0', ts: '1', user: 'U0' },
    });
    const req = await signedRequest(body, staleSec, 'super-secret');
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/slack/events',
      headers: req.headers,
      body: req.body,
    });
    await instance.stop();
    expect(resp?.status).toBe(401);
    expect(resp?.body).toContain('stale');
  });

  test('socket-mode instance rejects direct webhook with 405', async () => {
    const { instance } = buildInstance(
      { transport: { mode: 'socket', botToken: 'xoxb', appToken: 'xapp', signingSecret: 'ss' } },
      {},
      { useSocket: true },
    );
    await instance.start();
    const resp = await instance.handleWebhook?.({
      method: 'POST',
      path: '/slack/events',
      headers: {},
      body: new Uint8Array(),
    });
    await instance.stop();
    expect(resp?.status).toBe(405);
  });
});

describe('SlackChannelInstance — inbound classification', () => {
  async function deliverWrapper(
    built: BuiltInstance,
    wrapper: SlackEventWrapper | SlackBlockActionsPayload | SlackSlashCommandPayload,
  ) {
    await built.instance.start();
    const tsSec = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(wrapper);
    const req = await signedRequest(body, tsSec, 'super-secret');
    await built.instance.handleWebhook?.({
      method: 'POST',
      path: '/slack/events',
      headers: req.headers,
      body: req.body,
    });
    await built.instance.stop();
  }

  test('app_mention → chat.mention', async () => {
    const built = buildInstance();
    await deliverWrapper(built, {
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U01',
        text: '<@BOT> help',
        channel: 'C0XYZ',
        ts: '1702345679.000100',
      },
    });
    expect(built.events[0]?.kind).toBe('chat.mention');
  });

  test('IM message → chat.dm', async () => {
    const built = buildInstance();
    await deliverWrapper(built, {
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'D01',
        channel_type: 'im',
        user: 'U01',
        text: 'psst',
        ts: '1702345679.000200',
      },
    });
    expect(built.events[0]?.kind).toBe('chat.dm');
  });

  test('channel message with thread_ts carries threadId', async () => {
    const built = buildInstance();
    await deliverWrapper(built, {
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C0XYZ',
        channel_type: 'channel',
        user: 'U01',
        text: 'threaded reply',
        ts: '1702345700.000100',
        thread_ts: '1702345600.000000',
      },
    });
    expect(built.events[0]?.kind).toBe('chat.message');
    const src = built.events[0]?.source as { threadTs?: string };
    expect(src.threadTs).toBe('1702345600.000000');
  });

  test('bot_id filter drops bot messages', async () => {
    const built = buildInstance();
    await deliverWrapper(built, {
      type: 'event_callback',
      event: {
        type: 'message',
        channel: 'C0XYZ',
        channel_type: 'channel',
        user: 'U99',
        bot_id: 'B01OTHER',
        text: 'relay',
        ts: '1702345702.000100',
      },
    });
    expect(built.events).toHaveLength(0);
  });

  test('block_actions → channel.interaction', async () => {
    const built = buildInstance();
    await deliverWrapper(built, {
      type: 'block_actions',
      user: { id: 'U01', username: 'alice' },
      trigger_id: 'trg-1',
      channel: { id: 'C0XYZ', name: 'general' },
      actions: [{ action_id: 'accept', block_id: 'b1', type: 'button', value: 'yes' }],
      container: { type: 'message', message_ts: '1702345703.000100', channel_id: 'C0XYZ' },
      message: { ts: '1702345703.000100', text: 'order ready?', user: 'U99' },
    });
    expect(built.events[0]?.kind).toBe('channel.interaction');
    const p = built.events[0]?.payload as { actionId?: string; value?: string };
    expect(p.actionId).toBe('accept');
    expect(p.value).toBe('yes');
  });

  test('slash command → channel.command', async () => {
    const built = buildInstance();
    await deliverWrapper(built, {
      command: '/agent',
      text: 'status now',
      channel_id: 'C0XYZ',
      user_id: 'U01',
      user_name: 'alice',
    });
    expect(built.events[0]?.kind).toBe('channel.command');
    const p = built.events[0]?.payload as { command?: string; args?: string };
    expect(p.command).toBe('agent');
    expect(p.args).toBe('status now');
  });
});

describe('SlackChannelInstance — Socket Mode dispatch', () => {
  test('incoming events_api frame publishes to bus', async () => {
    const built = buildInstance(
      { transport: { mode: 'socket', botToken: 'xoxb', appToken: 'xapp', signingSecret: 'ss' } },
      {},
      { useSocket: true },
    );
    await built.instance.start();
    await built.socket.dispatch({
      type: 'events_api',
      envelope_id: 'env-1',
      payload: {
        type: 'event_callback',
        event: {
          type: 'app_mention',
          user: 'U01',
          text: '<@BOT> hi',
          channel: 'C0XYZ',
          ts: '1702345720.000100',
        },
      },
    });
    await built.instance.stop();
    expect(built.events).toHaveLength(1);
    expect(built.events[0]?.kind).toBe('chat.mention');
  });

  test('hello frame is ignored', async () => {
    const built = buildInstance(
      { transport: { mode: 'socket', botToken: 'xoxb', appToken: 'xapp', signingSecret: 'ss' } },
      {},
      { useSocket: true },
    );
    await built.instance.start();
    await built.socket.dispatch({ type: 'hello', num_connections: 1 });
    await built.instance.stop();
    expect(built.events).toHaveLength(0);
  });
});

describe('SlackChannelInstance — outbound', () => {
  test('send(text) posts plain message with text fallback', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    const sent = await instance.send({
      conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' },
      content: { kind: 'text', text: 'hello world' },
      idempotencyKey: 's1',
    });
    await instance.stop();
    expect(calls.chatPostMessage).toHaveLength(1);
    expect(calls.chatPostMessage[0]?.text).toBe('hello world');
    expect(calls.chatPostMessage[0]?.blocks).toBeUndefined();
    expect(sent.conversation.conversationId).toBe('C0XYZ');
  });

  test('send(rich) always includes text alongside blocks', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.send({
      conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' },
      content: {
        kind: 'rich',
        blocks: [
          { kind: 'heading', text: 'Order' },
          { kind: 'paragraph', text: 'Ready to ship?' },
          { kind: 'divider' },
          {
            kind: 'button-row',
            buttons: [
              { id: 'yes', label: 'Ship it', style: 'primary' },
              { id: 'no', label: 'Hold', style: 'danger' },
            ],
          },
        ],
      },
      idempotencyKey: 's2',
    });
    await instance.stop();
    const posted = calls.chatPostMessage[0];
    expect(posted).toBeDefined();
    expect(posted?.blocks?.length).toBe(4);
    expect(posted?.text).toBeDefined();
    expect((posted?.text ?? '').length).toBeGreaterThan(0);
    const blockTypes = posted?.blocks?.map((b) => (b as { type: string }).type);
    expect(blockTypes).toEqual(['header', 'section', 'divider', 'actions']);
  });

  test('react issues reactions.add (strips colons)', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.react?.(
      {
        conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' },
        id: '1702345678.000100',
      },
      ':white_check_mark:',
    );
    await instance.stop();
    expect(calls.reactionsAdd).toHaveLength(1);
    expect(calls.reactionsAdd[0]?.name).toBe('white_check_mark');
  });

  test('edit + delete call matching APIs', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.edit?.(
      { conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' }, id: '1702345.000' },
      { kind: 'text', text: 'updated' },
    );
    await instance.delete?.({
      conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' },
      id: '1702345.000',
    });
    await instance.stop();
    expect(calls.chatUpdate).toHaveLength(1);
    expect(calls.chatUpdate[0]?.text).toBe('updated');
    expect(calls.chatDelete).toHaveLength(1);
  });

  test('setTyping is a no-op (capability is off)', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.setTyping?.({ channelId: 'slack-main', conversationId: 'C0XYZ' }, 1000);
    await instance.stop();
    expect(calls.chatPostMessage).toHaveLength(0);
  });

  test('thread_ts from replyTo is forwarded', async () => {
    const { instance, calls } = buildInstance();
    await instance.start();
    await instance.send({
      conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' },
      replyTo: {
        conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' },
        id: '1702345.000',
      },
      content: { kind: 'text', text: 'in-thread' },
      idempotencyKey: 's-thread',
    });
    await instance.stop();
    expect(calls.chatPostMessage[0]?.thread_ts).toBe('1702345.000');
  });

  test('429 maps to ChannelRateLimitError and retries once', async () => {
    const err = new SlackApiError('ratelimited', 'chat.postMessage', 'ratelimited', 1, 429);
    const state = { thrown: false };
    const { client, calls } = makeStubClient();
    const original = client.chatPostMessage;
    client.chatPostMessage = async (p) => {
      if (!state.thrown) {
        state.thrown = true;
        throw err;
      }
      return original(p);
    };
    const bus = createEventBus();
    const instance = new SlackChannelInstance({
      config: baseConfig(),
      deps: deps(bus),
      client,
    });
    await instance.start();
    const sent = await instance.send({
      conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' },
      content: { kind: 'text', text: 'hi' },
      idempotencyKey: 'rl',
    });
    await instance.stop();
    expect(sent.id).toBeDefined();
    expect(calls.chatPostMessage).toHaveLength(1);
    expect(instance.sendCountersSnapshot().rateLimitRetried).toBe(1);
  });

  test('persistent 429 surfaces ChannelRateLimitError to caller', async () => {
    const err = new SlackApiError('ratelimited', 'chat.postMessage', 'ratelimited', 0, 429);
    const { client } = makeStubClient();
    client.chatPostMessage = async () => {
      throw err;
    };
    const bus = createEventBus();
    const instance = new SlackChannelInstance({
      config: baseConfig(),
      deps: deps(bus),
      client,
    });
    await instance.start();
    await expect(
      instance.send({
        conversation: { channelId: 'slack-main', conversationId: 'C0XYZ' },
        content: { kind: 'text', text: 'hi' },
        idempotencyKey: 'rl-fail',
      }),
    ).rejects.toBeInstanceOf(ChannelRateLimitError);
    await instance.stop();
  });
});

describe('createSlackAdapter', () => {
  test('validateConfig accepts a well-formed config', () => {
    const adapter = createSlackAdapter();
    expect(() => adapter.validateConfig(baseConfig())).not.toThrow();
  });

  test('validateConfig rejects missing botToken', () => {
    const adapter = createSlackAdapter();
    const bad = { ...baseConfig(), transport: { mode: 'events', signingSecret: 'ss' } };
    expect(() => adapter.validateConfig(bad)).toThrow(/botToken/);
  });

  test('validateConfig rejects events-mode without signingSecret', () => {
    const adapter = createSlackAdapter();
    const bad = { ...baseConfig(), transport: { mode: 'events', botToken: 'xoxb' } };
    expect(() => adapter.validateConfig(bad)).toThrow(/signingSecret/);
  });

  test('validateConfig rejects socket-mode without appToken', () => {
    const adapter = createSlackAdapter();
    const bad = { ...baseConfig(), transport: { mode: 'socket', botToken: 'xoxb' } };
    expect(() => adapter.validateConfig(bad)).toThrow(/appToken/);
  });

  test('create returns a SlackChannelInstance with correct id', async () => {
    const { client } = makeStubClient();
    const adapter = createSlackAdapter({ client });
    const bus = createEventBus();
    const instance = await adapter.create(baseConfig(), deps(bus));
    expect(instance.id).toBe('slack-main');
    expect(instance.type).toBe('slack');
  });
});

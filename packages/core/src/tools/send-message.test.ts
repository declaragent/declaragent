import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createChannelRegistry } from '../channels/registry.js';
import type {
  ChannelCapabilities,
  ChannelInstance,
  SendMessageParams,
  SentMessage,
} from '../channels/types.js';
import { createMailbox } from '../events/mailbox.js';
import { collectToolEvents, makeToolContext } from '../testing/context.js';
import { createMemorySession } from '../testing/memory-session.js';
import { createSendMessageTool, permissionKeyFor } from './send-message.js';

function memDb(): Database {
  const db = new Database(':memory:', { create: true });
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

const CAPS: ChannelCapabilities = {
  supportsThreads: true,
  supportsReactions: false,
  supportsTypingIndicator: false,
  supportsFileUpload: false,
  supportsVoice: false,
  supportsButtons: true,
  supportsEditMessage: false,
  supportsDeleteMessage: false,
  supportsPresence: false,
  supportsSlashCommands: false,
  supportsDMs: true,
  supportsGroupChats: true,
  supportsVoiceChannels: false,
  maxMessageLength: 4096,
  maxAttachmentBytes: 10 * 1024 * 1024,
};

function fakeChannel(id: string): ChannelInstance & { calls: SendMessageParams[] } {
  const calls: SendMessageParams[] = [];
  return {
    id,
    type: 'fake',
    capabilities: CAPS,
    calls,
    start: async () => {},
    stop: async () => {},
    pause: async () => {},
    resume: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    metrics: () => ({ eventsPublished: 0, lastEventAt: null }),
    send: async (params: SendMessageParams): Promise<SentMessage> => {
      calls.push(params);
      return { id: `${id}-msg-${calls.length}`, conversation: params.conversation };
    },
  };
}

// ── Agent-target (Phase 3 path, updated shape) ───────────────────────────

describe('createSendMessageTool — agent target', () => {
  test('permissionKey formats as "agent:<id>"', () => {
    const mailbox = createMailbox({ db: memDb() });
    const tool = createSendMessageTool(mailbox);
    expect(tool.permissionKey({ kind: 'agent', agent: 'billing-bot', payload: {} })).toBe(
      'agent:billing-bot',
    );
  });

  test('sends a message tagged with the current session spec.name', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    const tool = createSendMessageTool(mailbox);
    const session = createMemorySession({ spec: { name: 'alice-agent' } });

    const events = await collectToolEvents(
      tool.execute(
        { kind: 'agent', agent: 'billing-bot', payload: { amount: 42 } },
        makeToolContext({ session }),
      ),
    );
    expect(events.error).toBeUndefined();
    expect(events.result?.kind).toBe('agent');
    expect(events.result?.toAgent).toBe('billing-bot');
    expect(events.result?.fromAgent).toBe('alice-agent');
    expect(typeof events.result?.eventId).toBe('string');

    const drained = await mailbox.drainFor('billing-bot');
    expect(drained).toHaveLength(1);
    expect(drained[0]?.source).toEqual({ type: 'mailbox', fromAgent: 'alice-agent' });
    expect(drained[0]?.payload).toEqual({ amount: 42 });
  });

  test('aborted signal yields an error event without sending', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    const tool = createSendMessageTool(mailbox);
    const ac = new AbortController();
    ac.abort();

    const events = await collectToolEvents(
      tool.execute(
        { kind: 'agent', agent: 'billing-bot', payload: {} },
        makeToolContext({ abortSignal: ac.signal }),
      ),
    );
    expect(events.error?.code).toBe('ABORTED');
    expect(await mailbox.depth('billing-bot')).toBe(0);
  });

  test('mailbox failure surfaces as an error event', async () => {
    const db = memDb();
    const mailbox = createMailbox({ db });
    const tool = createSendMessageTool(mailbox);
    const events = await collectToolEvents(
      tool.execute({ kind: 'agent', agent: '', payload: {} }, makeToolContext()),
    );
    expect(events.error?.message).toContain('toAgent');
  });

  test('accepts legacy factory signature (mailbox directly)', () => {
    const tool = createSendMessageTool(createMailbox({ db: memDb() }));
    expect(tool.name).toBe('SendMessage');
  });
});

// ── Channel-target (slice 11 additions) ──────────────────────────────────

describe('createSendMessageTool — channel target', () => {
  test('permissionKey formats as "channel:<channelId>/<conversationId>"', () => {
    const mailbox = createMailbox({ db: memDb() });
    const channels = createChannelRegistry();
    const tool = createSendMessageTool({ mailbox, channels });
    expect(
      tool.permissionKey({
        kind: 'channel',
        channelId: 'slack-prod',
        conversationId: 'C123',
        content: { kind: 'text', text: 'hi' },
      }),
    ).toBe('channel:slack-prod/C123');
  });

  test('dispatches through ChannelRegistry.get(channelId).send()', async () => {
    const mailbox = createMailbox({ db: memDb() });
    const channels = createChannelRegistry();
    const ch = fakeChannel('slack-prod');
    channels.register(ch);
    const tool = createSendMessageTool({ mailbox, channels });

    const events = await collectToolEvents(
      tool.execute(
        {
          kind: 'channel',
          channelId: 'slack-prod',
          conversationId: 'C123',
          content: { kind: 'text', text: 'hi there' },
        },
        makeToolContext(),
      ),
    );
    expect(events.error).toBeUndefined();
    expect(events.result?.kind).toBe('channel');
    expect(events.result?.messageId).toBe('slack-prod-msg-1');
    expect(ch.calls).toHaveLength(1);
    expect(ch.calls[0]?.conversation).toEqual({
      channelId: 'slack-prod',
      conversationId: 'C123',
    });
    expect(ch.calls[0]?.content).toEqual({ kind: 'text', text: 'hi there' });
  });

  test('threadId + replyTo pass through to the channel instance', async () => {
    const mailbox = createMailbox({ db: memDb() });
    const channels = createChannelRegistry();
    const ch = fakeChannel('slack-prod');
    channels.register(ch);
    const tool = createSendMessageTool({ mailbox, channels });

    const replyTo = {
      conversation: { channelId: 'slack-prod', conversationId: 'C123', threadId: '1' },
      id: '0xdeadbeef',
    };
    await collectToolEvents(
      tool.execute(
        {
          kind: 'channel',
          channelId: 'slack-prod',
          conversationId: 'C123',
          threadId: '1',
          content: { kind: 'text', text: 'hi' },
          replyTo,
        },
        makeToolContext(),
      ),
    );
    expect(ch.calls[0]?.conversation.threadId).toBe('1');
    expect(ch.calls[0]?.replyTo).toEqual(replyTo);
  });

  test('caller-supplied idempotencyKey is passed through unchanged', async () => {
    const mailbox = createMailbox({ db: memDb() });
    const channels = createChannelRegistry();
    const ch = fakeChannel('slack-prod');
    channels.register(ch);
    const tool = createSendMessageTool({ mailbox, channels });

    await collectToolEvents(
      tool.execute(
        {
          kind: 'channel',
          channelId: 'slack-prod',
          conversationId: 'C123',
          content: { kind: 'text', text: 'hi' },
          idempotencyKey: 'caller-provided-key',
        },
        makeToolContext(),
      ),
    );
    expect(ch.calls[0]?.idempotencyKey).toBe('caller-provided-key');
  });

  test('auto-derives idempotencyKey from session when caller omits', async () => {
    const mailbox = createMailbox({ db: memDb() });
    const channels = createChannelRegistry();
    const ch = fakeChannel('slack-prod');
    channels.register(ch);
    const tool = createSendMessageTool({ mailbox, channels });

    const session = createMemorySession({ spec: { name: 'alice' } });
    await collectToolEvents(
      tool.execute(
        {
          kind: 'channel',
          channelId: 'slack-prod',
          conversationId: 'C123',
          content: { kind: 'text', text: 'hi' },
        },
        makeToolContext({ session }),
      ),
    );
    // Key starts with the deterministic `tool:<sessionId>:` prefix.
    expect(ch.calls[0]?.idempotencyKey).toMatch(/^tool:/);
    expect(ch.calls[0]?.idempotencyKey).toContain(session.id);
  });

  test('returns ENOCHANNEL when channels dep is not wired', async () => {
    const mailbox = createMailbox({ db: memDb() });
    const tool = createSendMessageTool({ mailbox });
    const events = await collectToolEvents(
      tool.execute(
        {
          kind: 'channel',
          channelId: 'slack-prod',
          conversationId: 'C123',
          content: { kind: 'text', text: 'hi' },
        },
        makeToolContext(),
      ),
    );
    expect(events.error?.code).toBe('ENOCHANNEL');
    expect(events.error?.message).toContain('channel registry');
  });

  test('returns ENOCHANNEL when target channel is not registered', async () => {
    const mailbox = createMailbox({ db: memDb() });
    const channels = createChannelRegistry();
    const tool = createSendMessageTool({ mailbox, channels });
    const events = await collectToolEvents(
      tool.execute(
        {
          kind: 'channel',
          channelId: 'missing',
          conversationId: 'C123',
          content: { kind: 'text', text: 'hi' },
        },
        makeToolContext(),
      ),
    );
    expect(events.error?.code).toBe('ENOCHANNEL');
    expect(events.error?.message).toContain('missing');
  });

  test('channel.send failure surfaces as a typed error', async () => {
    const mailbox = createMailbox({ db: memDb() });
    const channels = createChannelRegistry();
    const boom = fakeChannel('slack-prod');
    boom.send = async () => {
      throw new Error('platform 500');
    };
    channels.register(boom);
    const tool = createSendMessageTool({ mailbox, channels });

    const events = await collectToolEvents(
      tool.execute(
        {
          kind: 'channel',
          channelId: 'slack-prod',
          conversationId: 'C123',
          content: { kind: 'text', text: 'hi' },
        },
        makeToolContext(),
      ),
    );
    expect(events.error?.message).toContain('platform 500');
  });

  test('aborted signal bails before touching the registry', async () => {
    const mailbox = createMailbox({ db: memDb() });
    const channels = createChannelRegistry();
    const ch = fakeChannel('slack-prod');
    channels.register(ch);
    const tool = createSendMessageTool({ mailbox, channels });
    const ac = new AbortController();
    ac.abort();

    const events = await collectToolEvents(
      tool.execute(
        {
          kind: 'channel',
          channelId: 'slack-prod',
          conversationId: 'C123',
          content: { kind: 'text', text: 'hi' },
        },
        makeToolContext({ abortSignal: ac.signal }),
      ),
    );
    expect(events.error?.code).toBe('ABORTED');
    expect(ch.calls).toHaveLength(0);
  });
});

describe('permissionKeyFor', () => {
  test('agent form', () => {
    expect(permissionKeyFor({ kind: 'agent', agent: 'x', payload: null })).toBe('agent:x');
  });
  test('channel form', () => {
    expect(
      permissionKeyFor({
        kind: 'channel',
        channelId: 'slack-prod',
        conversationId: 'C123',
        content: { kind: 'text', text: 'x' },
      }),
    ).toBe('channel:slack-prod/C123');
  });
});

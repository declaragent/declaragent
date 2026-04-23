import { describe, expect, test } from 'bun:test';
import type {
  AssistantFinalPayload,
  AssistantMessagePayload,
  TurnStartedPayload,
} from '../engine/engine.js';
import { createEventBus } from '../events/bus.js';
import type { AgentEvent } from '../events/types.js';
import type { Logger } from '../types/logger.js';
import type { Message } from '../types/messages.js';
import {
  type ChannelSendRequestPayload,
  createChannelOutboundBridge,
  extractAssistantContent,
} from './outbound-bridge.js';
import { createChannelRegistry } from './registry.js';
import { createSessionChannelContextStore } from './session-context.js';
import type {
  ChannelCapabilities,
  ChannelInstance,
  ChannelMessageContent,
  ConversationRef,
  MessageRef,
  SendMessageParams,
  SentMessage,
} from './types.js';

const CAPS: ChannelCapabilities = {
  supportsThreads: false,
  supportsReactions: false,
  supportsTypingIndicator: false,
  supportsFileUpload: false,
  supportsVoice: false,
  supportsButtons: false,
  supportsEditMessage: false,
  supportsDeleteMessage: false,
  supportsPresence: false,
  supportsSlashCommands: false,
  supportsDMs: true,
  supportsGroupChats: false,
  supportsVoiceChannels: false,
  maxMessageLength: 4096,
  maxAttachmentBytes: 10 * 1024 * 1024,
};

interface CollectingLogger extends Logger {
  warns: unknown[][];
  errors: unknown[][];
}

function collectingLogger(): CollectingLogger {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  const self: CollectingLogger = {
    debug: () => {},
    info: () => {},
    warn: (...args) => {
      warns.push(args);
    },
    error: (...args) => {
      errors.push(args);
    },
    child: () => self,
    warns,
    errors,
  };
  return self;
}

interface FakeChannelOptions {
  throwOnSend?: boolean;
  capabilities?: ChannelCapabilities;
  throwOnEdit?: boolean;
}

interface FakeChannel extends ChannelInstance {
  calls: SendMessageParams[];
  typingCalls: { conversation: ConversationRef; durationMs?: number }[];
  editCalls: { ref: MessageRef; content: ChannelMessageContent }[];
}

function fakeChannel(id: string, overrides: FakeChannelOptions = {}): FakeChannel {
  const calls: SendMessageParams[] = [];
  const typingCalls: { conversation: ConversationRef; durationMs?: number }[] = [];
  const editCalls: { ref: MessageRef; content: ChannelMessageContent }[] = [];
  const capabilities = overrides.capabilities ?? CAPS;
  const instance: FakeChannel = {
    id,
    type: 'fake',
    capabilities,
    calls,
    typingCalls,
    editCalls,
    start: async () => {},
    stop: async () => {},
    pause: async () => {},
    resume: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    metrics: () => ({ eventsPublished: 0, lastEventAt: null }),
    send: async (params: SendMessageParams): Promise<SentMessage> => {
      calls.push(params);
      if (overrides.throwOnSend) throw new Error('boom');
      return { id: `${id}-msg-${calls.length}`, conversation: params.conversation };
    },
  };
  if (capabilities.supportsTypingIndicator) {
    instance.setTyping = async (conversation, durationMs) => {
      typingCalls.push({ conversation, ...(durationMs !== undefined && { durationMs }) });
    };
  }
  if (capabilities.supportsEditMessage) {
    instance.edit = async (ref, content) => {
      editCalls.push({ ref, content });
      if (overrides.throwOnEdit) throw new Error('edit-boom');
    };
  }
  return instance;
}

const STREAM_CAPS: ChannelCapabilities = {
  ...CAPS,
  supportsTypingIndicator: true,
  supportsEditMessage: true,
};

const TYPING_ONLY_CAPS: ChannelCapabilities = {
  ...CAPS,
  supportsTypingIndicator: true,
};

describe('extractAssistantContent', () => {
  test('concatenates text blocks with newlines', () => {
    const content: Message['content'] = [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ];
    expect(extractAssistantContent(content)).toEqual({
      kind: 'text',
      text: 'hello\nworld',
      format: 'markdown',
    });
  });

  test('drops tool_use blocks', () => {
    const content: Message['content'] = [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 'x', name: 'Read', input: {} },
    ];
    expect(extractAssistantContent(content)).toEqual({
      kind: 'text',
      text: 'hi',
      format: 'markdown',
    });
  });

  test('returns null when no text present', () => {
    expect(extractAssistantContent([])).toBeNull();
    expect(
      extractAssistantContent([{ type: 'tool_use', id: 'x', name: 'Read', input: {} }]),
    ).toBeNull();
    expect(extractAssistantContent([{ type: 'text', text: '' }])).toBeNull();
  });
});

const CONV: ConversationRef = { channelId: 'telegram-main', conversationId: 'chat-1' };

function assistantFinalEvent(
  sessionId: string,
  payload: Partial<AssistantFinalPayload> = {},
): AgentEvent<AssistantFinalPayload> {
  const turnId = payload.turnId ?? 'turn-1';
  return {
    id: `evt-${Math.random()}`,
    kind: 'assistant.final',
    source: { type: 'engine', sessionId, turnId },
    target: { type: 'broadcast' },
    timestamp: Date.now(),
    auth: { kind: 'internal' },
    payload: {
      sessionId,
      turnId,
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'reply' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      ...payload,
    },
  };
}

describe('ChannelOutboundBridge', () => {
  test('routes assistant.final to the originating channel', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main');
    channels.register(tg);
    sessionChannelContext.set('sess-1', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    const detach = bridge.start();

    await bus.publish(assistantFinalEvent('sess-1'));
    await bus.drained();

    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]?.conversation).toEqual(CONV);
    expect(tg.calls[0]?.content).toEqual({ kind: 'text', text: 'reply', format: 'markdown' });
    expect(tg.calls[0]?.idempotencyKey).toBe('session:sess-1:turn-1');
    detach();
  });

  test('drops silently when session has no channel origin', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main');
    channels.register(tg);

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    bridge.start();
    await bus.publish(assistantFinalEvent('unbound-session'));
    await bus.drained();

    expect(tg.calls).toHaveLength(0);
    expect(logger.warns).toHaveLength(0);
  });

  test('warns + drops when channel is unregistered', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    sessionChannelContext.set('sess-2', {
      channelOrigin: { channelId: 'missing', conversationId: 'c' },
    });

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    bridge.start();
    await bus.publish(assistantFinalEvent('sess-2'));
    await bus.drained();

    expect(logger.warns.length).toBeGreaterThan(0);
    const firstWarn = logger.warns[0];
    if (!firstWarn) throw new Error('expected a warn call');
    expect(firstWarn[0]).toBe('channels.outbound.unregistered');
  });

  test('skips empty assistant content', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main');
    channels.register(tg);
    sessionChannelContext.set('sess-3', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    bridge.start();
    await bus.publish(
      assistantFinalEvent('sess-3', {
        content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }],
      }),
    );
    await bus.drained();
    expect(tg.calls).toHaveLength(0);
  });

  test('deduplicates on the idempotency key', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main');
    channels.register(tg);
    sessionChannelContext.set('sess-4', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    bridge.start();

    const evt = assistantFinalEvent('sess-4');
    await bus.publish(evt);
    await bus.publish(evt);
    await bus.drained();

    // Fake channel does not dedupe; confirm the bridge uses a stable key so
    // a real BaseChannelInstance would. Both calls share the same key:
    expect(tg.calls).toHaveLength(2);
    expect(tg.calls[0]?.idempotencyKey).toBe(tg.calls[1]?.idempotencyKey);
  });

  test('handles channel.send.request explicitly', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const sl = fakeChannel('slack-prod');
    channels.register(sl);

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    bridge.start();

    const payload: ChannelSendRequestPayload = {
      conversation: { channelId: 'slack-prod', conversationId: 'C9' },
      content: { kind: 'text', text: 'hi there' },
      idempotencyKey: 'tool-1',
    };
    await bus.publish({
      id: 'evt-xyz',
      kind: 'channel.send.request',
      source: { type: 'user', sessionId: 'sess-5' },
      target: { type: 'broadcast' },
      timestamp: Date.now(),
      payload,
      auth: { kind: 'internal' },
    });
    await bus.drained();

    expect(sl.calls).toHaveLength(1);
    expect(sl.calls[0]?.idempotencyKey).toBe('tool-1');
  });

  test('uses event id as fallback idempotency key for channel.send.request', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const sl = fakeChannel('slack-prod');
    channels.register(sl);

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    bridge.start();

    const payload: ChannelSendRequestPayload = {
      conversation: { channelId: 'slack-prod', conversationId: 'C9' },
      content: { kind: 'text', text: 'no explicit key' },
    };
    await bus.publish({
      id: 'evt-abc',
      kind: 'channel.send.request',
      source: { type: 'user', sessionId: 'sess-6' },
      target: { type: 'broadcast' },
      timestamp: Date.now(),
      payload,
      auth: { kind: 'internal' },
    });
    await bus.drained();

    expect(sl.calls[0]?.idempotencyKey).toBe('event:evt-abc');
  });

  test('logs + swallows send errors so the bus subscriber does not crash', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main', { throwOnSend: true });
    channels.register(tg);
    sessionChannelContext.set('sess-7', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    bridge.start();
    await bus.publish(assistantFinalEvent('sess-7'));
    await bus.drained();

    expect(logger.warns.some((w) => w[0] === 'channels.outbound.failed')).toBe(true);
  });

  test('detach unsubscribes from the bus', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main');
    channels.register(tg);
    sessionChannelContext.set('sess-8', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    const detach = bridge.start();
    detach();
    await bus.publish(assistantFinalEvent('sess-8'));
    await bus.drained();
    expect(tg.calls).toHaveLength(0);
  });

  test('forwardAssistantFinal + forwardSendRequest work directly', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main');
    channels.register(tg);
    sessionChannelContext.set('sess-9', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({ bus, channels, sessionChannelContext, logger });
    const sent = await bridge.forwardAssistantFinal({
      sessionId: 'sess-9',
      turnId: 't',
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'direct' }],
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(sent?.id).toBe('telegram-main-msg-1');

    const sent2 = await bridge.forwardSendRequest(
      {
        conversation: { channelId: 'telegram-main', conversationId: 'other' },
        content: { kind: 'text', text: 'also direct' },
        idempotencyKey: 'k-direct',
      },
      'fallback-key',
    );
    expect(sent2?.id).toBe('telegram-main-msg-2');
  });

  // ── Slice 13: typing + streaming ─────────────────────────────────────────

  function turnStartedEvent(
    sessionId: string,
    payload: Partial<TurnStartedPayload> = {},
  ): AgentEvent<TurnStartedPayload> {
    const turnId = payload.turnId ?? 'turn-x';
    return {
      id: `evt-start-${Math.random()}`,
      kind: 'turn.started',
      source: { type: 'engine', sessionId, turnId },
      target: { type: 'broadcast' },
      timestamp: Date.now(),
      auth: { kind: 'internal' },
      payload: { sessionId, turnId, depth: 0, ...payload },
    };
  }

  function assistantMessageEvent(
    sessionId: string,
    payload: Partial<AssistantMessagePayload> = {},
  ): AgentEvent<AssistantMessagePayload> {
    const turnId = payload.turnId ?? 'turn-x';
    return {
      id: `evt-msg-${Math.random()}`,
      kind: 'assistant.message',
      source: { type: 'engine', sessionId, turnId },
      target: { type: 'broadcast' },
      timestamp: Date.now(),
      auth: { kind: 'internal' },
      payload: {
        sessionId,
        turnId,
        delta: payload.delta ?? 'chunk',
        done: payload.done ?? false,
      },
    };
  }

  test('turn.started → setTyping called when typingEnabled + supportsTypingIndicator', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main', { capabilities: TYPING_ONLY_CAPS });
    channels.register(tg);
    sessionChannelContext.set('sess-type-1', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
      typingEnabled: true,
    });
    bridge.start();
    await bus.publish(turnStartedEvent('sess-type-1'));
    await bus.drained();

    expect(tg.typingCalls).toHaveLength(1);
    expect(tg.typingCalls[0]?.conversation).toEqual(CONV);
  });

  test('turn.started → setTyping NOT called when channel capability is false', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    // Default CAPS has supportsTypingIndicator: false.
    const sl = fakeChannel('slack-prod');
    channels.register(sl);
    sessionChannelContext.set('sess-type-2', {
      channelOrigin: { channelId: 'slack-prod', conversationId: 'C1' },
    });

    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
      typingEnabled: true,
    });
    bridge.start();
    await bus.publish(turnStartedEvent('sess-type-2'));
    await bus.drained();

    expect(sl.typingCalls).toHaveLength(0);
  });

  test('turn.started → setTyping NOT called when typingEnabled is false', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main', { capabilities: TYPING_ONLY_CAPS });
    channels.register(tg);
    sessionChannelContext.set('sess-type-3', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
      // typingEnabled defaults to false — slice-2 behavior preserved.
    });
    bridge.start();
    await bus.publish(turnStartedEvent('sess-type-3'));
    await bus.drained();

    expect(tg.typingCalls).toHaveLength(0);
  });

  test('streaming: first assistant.message → send, second+ → edit (supportsEditMessage)', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main', { capabilities: STREAM_CAPS });
    channels.register(tg);
    sessionChannelContext.set('sess-stream-1', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
      streaming: true,
    });
    bridge.start();

    await bus.publish(
      assistantMessageEvent('sess-stream-1', { turnId: 't1', delta: 'hello', done: false }),
    );
    await bus.drained();
    await bus.publish(
      assistantMessageEvent('sess-stream-1', {
        turnId: 't1',
        delta: 'hello world',
        done: false,
      }),
    );
    await bus.drained();
    await bus.publish(
      assistantMessageEvent('sess-stream-1', {
        turnId: 't1',
        delta: 'hello world!',
        done: true,
      }),
    );
    await bus.drained();

    // One send, two edits — the first delta creates the message, the
    // two subsequent deltas edit it in place.
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]?.content).toEqual({ kind: 'text', text: 'hello', format: 'markdown' });
    expect(tg.editCalls).toHaveLength(2);
    expect(tg.editCalls[0]?.content).toEqual({
      kind: 'text',
      text: 'hello world',
      format: 'markdown',
    });
    expect(tg.editCalls[1]?.content).toEqual({
      kind: 'text',
      text: 'hello world!',
      format: 'markdown',
    });
    // The edit target references the message created by the first send.
    expect(tg.editCalls[0]?.ref.id).toBe('telegram-main-msg-1');
  });

  test('streaming: channel without supportsEditMessage stays in buffered mode (one send per final)', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    // Default CAPS has supportsEditMessage: false.
    const tg = fakeChannel('telegram-main');
    channels.register(tg);
    sessionChannelContext.set('sess-stream-2', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
      streaming: true,
    });
    bridge.start();

    await bus.publish(
      assistantMessageEvent('sess-stream-2', { turnId: 't2', delta: 'a', done: false }),
    );
    await bus.publish(
      assistantMessageEvent('sess-stream-2', { turnId: 't2', delta: 'ab', done: false }),
    );
    await bus.publish(
      assistantFinalEvent('sess-stream-2', {
        turnId: 't2',
        content: [{ type: 'text', text: 'ab' }],
      }),
    );
    await bus.drained();

    // assistant.message is ignored (no edit capability); assistant.final
    // produces the single send.
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]?.content).toEqual({ kind: 'text', text: 'ab', format: 'markdown' });
  });

  test('streaming: assistant.final after a streamed turn is a no-op (no extra send)', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main', { capabilities: STREAM_CAPS });
    channels.register(tg);
    sessionChannelContext.set('sess-stream-3', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
      streaming: true,
    });
    bridge.start();

    await bus.publish(
      assistantMessageEvent('sess-stream-3', { turnId: 't3', delta: 'streamed', done: true }),
    );
    await bus.drained();
    await bus.publish(
      assistantFinalEvent('sess-stream-3', {
        turnId: 't3',
        content: [{ type: 'text', text: 'streamed' }],
      }),
    );
    await bus.drained();

    // The streaming send is the only outbound call; assistant.final
    // should have been recognized as "already delivered" and dropped.
    expect(tg.calls).toHaveLength(1);
    expect(tg.editCalls).toHaveLength(0);
  });

  test('streaming: assistant.final for a non-streamed turn still sends (buffered fallback)', async () => {
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = collectingLogger();
    const tg = fakeChannel('telegram-main', { capabilities: STREAM_CAPS });
    channels.register(tg);
    sessionChannelContext.set('sess-stream-4', { channelOrigin: CONV });

    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
      streaming: true,
    });
    bridge.start();

    // No assistant.message for this turn — assistant.final should fall
    // back to buffered mode and send.
    await bus.publish(
      assistantFinalEvent('sess-stream-4', {
        turnId: 't4',
        content: [{ type: 'text', text: 'buffered' }],
      }),
    );
    await bus.drained();
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]?.content).toEqual({
      kind: 'text',
      text: 'buffered',
      format: 'markdown',
    });
  });
});

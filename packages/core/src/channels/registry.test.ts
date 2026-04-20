import { describe, expect, it } from 'bun:test';
import { ChannelRegistryError, createChannelRegistry } from './registry.js';
import type {
  ChannelCapabilities,
  ChannelInstance,
  ConversationRef,
  SendMessageParams,
  SentMessage,
} from './types.js';

function baseCaps(): ChannelCapabilities {
  return {
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
}

function fakeChannel(id: string, type = 'fake'): ChannelInstance {
  return {
    id,
    type,
    capabilities: baseCaps(),
    start: async () => {},
    stop: async () => {},
    pause: async () => {},
    resume: async () => {},
    health: async () => ({ status: 'healthy' as const }),
    metrics: () => ({ eventsPublished: 0, lastEventAt: null }),
    send: async (params: SendMessageParams): Promise<SentMessage> => ({
      id: `${id}-msg-1`,
      conversation: params.conversation,
    }),
  };
}

describe('ChannelRegistry', () => {
  it('registers and retrieves instances by id', () => {
    const registry = createChannelRegistry();
    const tg = fakeChannel('telegram-main', 'telegram');
    registry.register(tg);
    expect(registry.get('telegram-main')).toBe(tg);
  });

  it('returns undefined for unknown ids', () => {
    const registry = createChannelRegistry();
    expect(registry.get('missing')).toBeUndefined();
  });

  it('rejects duplicate ids with a typed error', () => {
    const registry = createChannelRegistry();
    registry.register(fakeChannel('slack-prod'));
    expect(() => registry.register(fakeChannel('slack-prod'))).toThrow(ChannelRegistryError);
    try {
      registry.register(fakeChannel('slack-prod'));
    } catch (err) {
      expect(err).toBeInstanceOf(ChannelRegistryError);
      expect((err as ChannelRegistryError).code).toBe('duplicate-id');
    }
  });

  it('allows multiple instances of the same type under distinct ids', () => {
    const registry = createChannelRegistry();
    registry.register(fakeChannel('telegram-a', 'telegram'));
    registry.register(fakeChannel('telegram-b', 'telegram'));
    expect(registry.list()).toHaveLength(2);
  });

  it('unregisters an instance by id', () => {
    const registry = createChannelRegistry();
    registry.register(fakeChannel('discord-main'));
    expect(registry.get('discord-main')).toBeDefined();
    registry.unregister('discord-main');
    expect(registry.get('discord-main')).toBeUndefined();
  });

  it('treats unregister of an unknown id as a no-op', () => {
    const registry = createChannelRegistry();
    expect(() => registry.unregister('nope')).not.toThrow();
  });

  it('list returns a snapshot, not a live reference', () => {
    const registry = createChannelRegistry();
    registry.register(fakeChannel('a'));
    const snapshot = registry.list();
    registry.register(fakeChannel('b'));
    expect(snapshot).toHaveLength(1);
    expect(registry.list()).toHaveLength(2);
  });

  it('re-registers an id after unregister', () => {
    const registry = createChannelRegistry();
    const first = fakeChannel('telegram-main', 'telegram');
    registry.register(first);
    registry.unregister('telegram-main');
    const second = fakeChannel('telegram-main', 'telegram');
    expect(() => registry.register(second)).not.toThrow();
    expect(registry.get('telegram-main')).toBe(second);
  });

  it('registry is isolated — one instance does not leak into another', () => {
    const r1 = createChannelRegistry();
    const r2 = createChannelRegistry();
    r1.register(fakeChannel('x'));
    expect(r1.list()).toHaveLength(1);
    expect(r2.list()).toHaveLength(0);
  });

  it('can address a test conversation through a registered instance', async () => {
    const registry = createChannelRegistry();
    registry.register(fakeChannel('telegram-main', 'telegram'));
    const conv: ConversationRef = { channelId: 'telegram-main', conversationId: '123' };
    const instance = registry.get(conv.channelId);
    if (!instance) throw new Error('instance should be registered');
    const sent = await instance.send({
      conversation: conv,
      content: { kind: 'text', text: 'hi' },
      idempotencyKey: 'k-1',
    });
    expect(sent.id).toBe('telegram-main-msg-1');
  });
});

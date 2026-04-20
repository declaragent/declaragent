import { describe, expect, it } from 'bun:test';
import { conversationSessionId, ephemeralSessionId, userSessionId } from './session-id.js';
import type { ConversationRef } from './types.js';

describe('conversationSessionId', () => {
  it('derives a deterministic id from channel + conversation', () => {
    const ref: ConversationRef = {
      channelId: 'telegram-main',
      conversationId: '-1001234567',
    };
    expect(conversationSessionId(ref)).toBe('chat:telegram-main:-1001234567:main');
  });

  it('includes thread id when present', () => {
    const ref: ConversationRef = {
      channelId: 'slack-prod',
      conversationId: 'C07ABC123',
      threadId: '1702345678.001234',
    };
    expect(conversationSessionId(ref)).toBe('chat:slack-prod:C07ABC123:1702345678.001234');
  });

  it('escapes colons in components', () => {
    const ref: ConversationRef = {
      channelId: 'discord-guild',
      conversationId: '987:654',
      threadId: 'thread:111',
    };
    expect(conversationSessionId(ref)).toBe('chat:discord-guild:987\\:654:thread\\:111');
  });

  it('escapes backslashes in components', () => {
    const ref: ConversationRef = {
      channelId: 'x\\y',
      conversationId: 'z',
    };
    expect(conversationSessionId(ref)).toBe('chat:x\\\\y:z:main');
  });

  it('is stable — same ref always maps to same id', () => {
    const ref: ConversationRef = { channelId: 'a', conversationId: 'b', threadId: 'c' };
    expect(conversationSessionId(ref)).toBe(conversationSessionId({ ...ref }));
  });
});

describe('userSessionId', () => {
  it('derives a per-user id', () => {
    expect(userSessionId('slack-prod', 'U0ABC')).toBe('chat-user:slack-prod:U0ABC');
  });

  it('is disjoint from conversationSessionId', () => {
    const user = userSessionId('c', 'u');
    const conv = conversationSessionId({ channelId: 'c', conversationId: 'u' });
    expect(user).not.toBe(conv);
  });
});

describe('ephemeralSessionId', () => {
  it('appends the suffix deterministically', () => {
    const ref: ConversationRef = { channelId: 'a', conversationId: 'b' };
    expect(ephemeralSessionId(ref, 'msg-1')).toBe('chat:a:b:main:msg-1');
  });

  it('differs across suffixes', () => {
    const ref: ConversationRef = { channelId: 'a', conversationId: 'b' };
    expect(ephemeralSessionId(ref, 'x')).not.toBe(ephemeralSessionId(ref, 'y'));
  });
});

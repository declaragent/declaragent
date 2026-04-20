import { describe, expect, it } from 'bun:test';
import { createSessionChannelContextStore } from './session-context.js';
import type { ConversationRef } from './types.js';

const CONV: ConversationRef = { channelId: 'slack-prod', conversationId: 'C123' };

describe('SessionChannelContextStore', () => {
  it('sets and gets by session id', () => {
    const store = createSessionChannelContextStore();
    store.set('sess-1', { channelOrigin: CONV });
    expect(store.get('sess-1')?.channelOrigin).toEqual(CONV);
  });

  it('returns undefined for unknown sessions', () => {
    const store = createSessionChannelContextStore();
    expect(store.get('missing')).toBeUndefined();
  });

  it('clears an individual session', () => {
    const store = createSessionChannelContextStore();
    store.set('sess-1', { channelOrigin: CONV });
    store.clear('sess-1');
    expect(store.get('sess-1')).toBeUndefined();
  });

  it('overwrites on re-set', () => {
    const store = createSessionChannelContextStore();
    store.set('sess-1', { channelOrigin: CONV });
    const other: ConversationRef = { channelId: 'slack-prod', conversationId: 'C999' };
    store.set('sess-1', { channelOrigin: other });
    expect(store.get('sess-1')?.channelOrigin).toEqual(other);
  });

  it('list returns a snapshot of all entries', () => {
    const store = createSessionChannelContextStore();
    store.set('a', { channelOrigin: CONV });
    store.set('b', { channelOrigin: CONV });
    expect(store.list()).toHaveLength(2);
  });

  it('preserves principal + lastInbound alongside origin', () => {
    const store = createSessionChannelContextStore();
    store.set('sess-1', {
      channelOrigin: CONV,
      channelPrincipal: {
        channelId: 'slack-prod',
        platformUserId: 'U0ALICE',
        scopes: ['channels:read'],
        verified: true,
      },
      lastInboundMessageRef: { conversation: CONV, id: 'ts-1' },
    });
    const ctx = store.get('sess-1');
    expect(ctx?.channelPrincipal?.platformUserId).toBe('U0ALICE');
    expect(ctx?.lastInboundMessageRef?.id).toBe('ts-1');
  });
});

import { describe, expect, it } from 'bun:test';
import { createSendIdempotencyCache } from './send-idempotency.js';
import type { ConversationRef, SentMessage } from './types.js';

const CONV: ConversationRef = { channelId: 'telegram-main', conversationId: '1' };

function sent(id: string): SentMessage {
  return { id, conversation: CONV };
}

describe('SendIdempotencyCache', () => {
  it('returns undefined for unknown keys', () => {
    const cache = createSendIdempotencyCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('stores and retrieves by key', () => {
    const cache = createSendIdempotencyCache();
    cache.put('k1', sent('msg-1'));
    expect(cache.get('k1')).toEqual(sent('msg-1'));
  });

  it('overwrites on re-put', () => {
    const cache = createSendIdempotencyCache();
    cache.put('k1', sent('msg-1'));
    cache.put('k1', sent('msg-2'));
    expect(cache.get('k1')).toEqual(sent('msg-2'));
  });

  it('expires entries after the TTL', () => {
    let t = 0;
    const cache = createSendIdempotencyCache({ ttlMs: 1000, now: () => t });
    cache.put('k', sent('a'));
    t = 500;
    expect(cache.get('k')).toEqual(sent('a'));
    t = 1500;
    expect(cache.get('k')).toBeUndefined();
  });

  it('prunes expired entries on put/size', () => {
    let t = 0;
    const cache = createSendIdempotencyCache({ ttlMs: 1000, now: () => t });
    cache.put('k1', sent('a'));
    cache.put('k2', sent('b'));
    t = 1500;
    cache.put('k3', sent('c'));
    // size() triggers a prune
    expect(cache.size()).toBe(1);
    expect(cache.get('k3')).toEqual(sent('c'));
  });

  it('enforces an LRU cap', () => {
    const cache = createSendIdempotencyCache({ maxEntries: 2 });
    cache.put('k1', sent('a'));
    cache.put('k2', sent('b'));
    cache.put('k3', sent('c'));
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k2')).toEqual(sent('b'));
    expect(cache.get('k3')).toEqual(sent('c'));
  });

  it('moves an entry to MRU position on get', () => {
    const cache = createSendIdempotencyCache({ maxEntries: 2 });
    cache.put('k1', sent('a'));
    cache.put('k2', sent('b'));
    // Touch k1 so it is MRU.
    cache.get('k1');
    cache.put('k3', sent('c'));
    expect(cache.get('k1')).toEqual(sent('a'));
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k3')).toEqual(sent('c'));
  });

  it('clears all entries', () => {
    const cache = createSendIdempotencyCache();
    cache.put('k', sent('a'));
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('k')).toBeUndefined();
  });
});

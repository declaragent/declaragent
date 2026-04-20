import type { SentMessage } from './types.js';

export const DEFAULT_SEND_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_SEND_IDEMPOTENCY_MAX_ENTRIES = 4096;

/**
 * Outbound idempotency cache. `BaseChannelInstance` consults this on every
 * `send()`; a hit short-circuits the transport call and returns the prior
 * `SentMessage`, so retries from `ChannelOutboundBridge` or the
 * `SendMessage` tool never double-post.
 *
 * Slice 2 ships an in-memory implementation. The interface accepts a
 * `persistent` flag — a sqlite-backed variant lands with the Phase-1
 * `SqliteSessionStore` extension in Phase-5.x for adapters that need
 * cross-restart dedup (Discord interactions mid-token, WhatsApp send
 * during daemon rollover).
 */
export interface SendIdempotencyCache {
  get(key: string): SentMessage | undefined;
  put(key: string, value: SentMessage): void;
  clear(): void;
  size(): number;
}

export interface SendIdempotencyCacheOptions {
  /** TTL per entry, in ms. Defaults to 10 minutes. */
  ttlMs?: number;
  /** LRU cap. Oldest insertions evict first once reached. */
  maxEntries?: number;
  /** Injected clock (ms-epoch). Default: `Date.now`. */
  now?: () => number;
}

interface Entry {
  value: SentMessage;
  expiresAt: number;
}

/**
 * Create an in-memory TTL + LRU cache. Uses the insertion-order guarantee
 * of `Map` to implement LRU: on every `put` we delete-then-set (so the
 * entry moves to the end), and `size()` prunes expired entries lazily.
 */
export function createSendIdempotencyCache(
  options: SendIdempotencyCacheOptions = {},
): SendIdempotencyCache {
  const ttl = options.ttlMs ?? DEFAULT_SEND_IDEMPOTENCY_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_SEND_IDEMPOTENCY_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function evictExpired(): void {
    if (entries.size === 0) return;
    const t = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt > t) break; // insertion order + monotonic TTLs
      entries.delete(key);
    }
  }

  function evictLRU(): void {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) return;
      entries.delete(oldest);
    }
  }

  return {
    get(key: string): SentMessage | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      // Refresh LRU position without resetting TTL.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    put(key: string, value: SentMessage): void {
      evictExpired();
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttl });
      evictLRU();
    },
    clear(): void {
      entries.clear();
    },
    size(): number {
      evictExpired();
      return entries.size;
    },
  };
}

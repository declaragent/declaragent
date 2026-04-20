/**
 * Minimal TTL cache used by every {@link SecretProvider} implementation.
 * Keeps the provider files small + testable — no external cache dep.
 */

export interface TtlCacheOptions<V> {
  /** Default TTL applied when a set() call doesn't specify one. */
  defaultTtlMs: number;
  /** Injectable clock so tests can advance time deterministically. */
  now?: () => number;
  /** Cleanup hook fired on eviction (useful for tokens with leases). */
  onEvict?: (key: string, value: V) => void;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlCache<V> {
  /** Return the cached value when fresh, else `undefined`. */
  get(key: string): V | undefined;
  /** Insert or overwrite. `ttlMs` overrides the default for this entry. */
  set(key: string, value: V, ttlMs?: number): void;
  /** Remove a single entry. */
  delete(key: string): boolean;
  /** Clear every entry. Fires the `onEvict` hook on each key. */
  clear(): void;
  /** Active entry count — for diagnostics + tests. */
  readonly size: number;
}

export function createTtlCache<V>(options: TtlCacheOptions<V>): TtlCache<V> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<V>>();

  function get(key: string): V | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      options.onEvict?.(key, entry.value);
      return undefined;
    }
    return entry.value;
  }

  function set(key: string, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? options.defaultTtlMs;
    // Preserve any caller-requested non-positive TTL as "cache disabled"
    // for this entry — never cache it.
    if (ttl <= 0) return;
    const existing = entries.get(key);
    if (existing) options.onEvict?.(key, existing.value);
    entries.set(key, { value, expiresAt: now() + ttl });
  }

  function del(key: string): boolean {
    const existing = entries.get(key);
    if (!existing) return false;
    entries.delete(key);
    options.onEvict?.(key, existing.value);
    return true;
  }

  function clear(): void {
    for (const [k, v] of entries) options.onEvict?.(k, v.value);
    entries.clear();
  }

  return {
    get,
    set,
    delete: del,
    clear,
    get size(): number {
      return entries.size;
    },
  };
}

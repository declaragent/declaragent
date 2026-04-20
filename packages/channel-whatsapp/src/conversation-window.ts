import type { ConversationStateStore } from '@declaragent/core';

/**
 * Tracks WhatsApp's 24-hour conversation window per-sender. A new inbound
 * message resets the window-end to `recordedAt + windowMs`. The adapter
 * consults `isInWindow(waId, now)` before each outbound `send`.
 *
 * State is cached in-process for fast reads and optionally persisted to a
 * `ConversationStateStore` (sqlite-backed in production) so restarts don't
 * lose the window and reopen a policy-template storm.
 */
export interface ConversationWindowTrackerOptions {
  channelId: string;
  windowMs: number;
  /** Optional persistent KV. Omit for pure in-memory tracking. */
  store?: ConversationStateStore;
  /** Injected clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Snapshot row for `/status` + health details. */
export interface ConversationWindowSnapshot {
  waId: string;
  recordedAt: number;
  expiresAt: number;
}

export class ConversationWindowTracker {
  private readonly channelId: string;
  private readonly windowMs: number;
  private readonly store: ConversationStateStore | undefined;
  private readonly now: () => number;
  /** waId → window-end ms. */
  private readonly cache = new Map<string, number>();

  constructor(opts: ConversationWindowTrackerOptions) {
    this.channelId = opts.channelId;
    this.windowMs = opts.windowMs;
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Key used in the persistent store. */
  private key(waId: string): string {
    return `whatsapp:${this.channelId}:${waId}:window`;
  }

  /**
   * Record an inbound message. Resets the window-end to `timestampMs + windowMs`.
   * Persisting to the external store happens best-effort: failures log
   * via the caller's logger (tracker itself stays quiet).
   */
  async recordInbound(waId: string, timestampMs?: number): Promise<void> {
    const base = timestampMs ?? this.now();
    const expiresAt = base + this.windowMs;
    this.cache.set(waId, expiresAt);
    if (this.store) {
      await this.store.set(this.key(waId), String(expiresAt), this.windowMs);
    }
  }

  /** Is the outbound send currently inside the 24h free-form window? */
  async isInWindow(waId: string, nowMs?: number): Promise<boolean> {
    const now = nowMs ?? this.now();
    const expiresAt = await this.windowEndMs(waId);
    if (expiresAt === undefined) return false;
    return expiresAt > now;
  }

  /** Returns the window-end in ms, or undefined if no inbound recorded. */
  async windowEndMs(waId: string): Promise<number | undefined> {
    const cached = this.cache.get(waId);
    if (cached !== undefined) return cached;
    if (!this.store) return undefined;
    const raw = await this.store.get(this.key(waId));
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    // Warm the cache so subsequent checks don't round-trip to the store.
    this.cache.set(waId, parsed);
    return parsed;
  }

  async clear(waId: string): Promise<void> {
    this.cache.delete(waId);
    if (this.store) await this.store.delete(this.key(waId));
  }

  /** Summary of in-memory state (excludes entries that live only on disk). */
  snapshot(nowMs?: number): ConversationWindowSnapshot[] {
    const now = nowMs ?? this.now();
    const rows: ConversationWindowSnapshot[] = [];
    for (const [waId, expiresAt] of this.cache) {
      rows.push({ waId, recordedAt: expiresAt - this.windowMs, expiresAt });
      void now;
    }
    return rows;
  }

  /** Current number of active (not yet expired) windows. */
  activeCount(nowMs?: number): number {
    const now = nowMs ?? this.now();
    let count = 0;
    for (const expiresAt of this.cache.values()) if (expiresAt > now) count += 1;
    return count;
  }
}

import { TokenBucket } from '../events/rate-limiter.js';

export interface OutboundRateLimiterOptions {
  /** Per-conversation token bucket rate, tokens/sec. Omit for unlimited. */
  perConversationPerSec?: number;
  /** Per-conversation burst. Defaults to `perConversationPerSec`. */
  perConversationBurst?: number;
  /** Global (per-channel) token bucket rate, tokens/sec. Omit for unlimited. */
  globalPerSec?: number;
  /** Global burst. Defaults to `globalPerSec`. */
  globalBurst?: number;
  /**
   * Upper bound on how long a single `acquire()` call will wait before
   * giving up. On expiry `acquire()` throws `OutboundRateLimitTimeoutError`;
   * callers surface as a typed rate-limit failure. Default: 30s.
   */
  maxWaitMs?: number;
  /** Injected clock (ms-epoch). Default: `Date.now`. */
  now?: () => number;
  /** Injected sleep; respects AbortSignal when wired by subclass. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * LRU cap on per-conversation buckets. A daemon running at steady state
   * holds one bucket per active conversation; the cap keeps memory bounded
   * when the agent participates in many one-off conversations.
   */
  maxConversationBuckets?: number;
}

export const DEFAULT_OUTBOUND_MAX_WAIT_MS = 30_000;
export const DEFAULT_MAX_CONVERSATION_BUCKETS = 4096;

export class OutboundRateLimitTimeoutError extends Error {
  constructor(
    readonly scope: 'global' | 'per-conversation',
    readonly conversationId: string | null,
    readonly waitedMs: number,
  ) {
    super(
      `OutboundRateLimiter: ${scope} bucket did not refill within ${waitedMs}ms${
        conversationId !== null ? ` (conversation=${conversationId})` : ''
      }`,
    );
    this.name = 'OutboundRateLimitTimeoutError';
  }
}

/**
 * Two-tier outbound limiter. Every `send()` path acquires one token from
 * the global bucket and one from the conversation-scoped bucket before
 * touching the transport. Rate knobs come from the channel config's
 * `limits.outbound` section.
 *
 * The limiter waits (does not reject) on a shortage so callers see the
 * same linear send semantics; a wait longer than `maxWaitMs` throws so a
 * stuck daemon can't block a caller indefinitely.
 */
export class OutboundRateLimiter {
  private readonly global: TokenBucket | null;
  private readonly perConvRate: number | null;
  private readonly perConvBurst: number | null;
  private readonly perConversation = new Map<string, TokenBucket>();
  private readonly maxConvBuckets: number;
  private readonly maxWaitMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: OutboundRateLimiterOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_OUTBOUND_MAX_WAIT_MS;
    this.maxConvBuckets = options.maxConversationBuckets ?? DEFAULT_MAX_CONVERSATION_BUCKETS;

    if (options.globalPerSec !== undefined) {
      const opts: { ratePerSec: number; burst?: number; now?: () => number } = {
        ratePerSec: options.globalPerSec,
        now: this.clock,
      };
      if (options.globalBurst !== undefined) opts.burst = options.globalBurst;
      this.global = new TokenBucket(opts);
    } else {
      this.global = null;
    }
    this.perConvRate = options.perConversationPerSec ?? null;
    this.perConvBurst = options.perConversationBurst ?? null;
  }

  async acquire(conversationId: string, signal?: AbortSignal): Promise<void> {
    const deadline = this.clock() + this.maxWaitMs;
    if (this.global !== null) {
      await this.drainBucket(this.global, deadline, 'global', null, signal);
    }
    if (this.perConvRate !== null) {
      const bucket = this.bucketFor(conversationId);
      await this.drainBucket(bucket, deadline, 'per-conversation', conversationId, signal);
    }
  }

  /** For tests + metrics. */
  snapshot(): { global: number | null; perConversation: Record<string, number> } {
    const perConversation: Record<string, number> = {};
    for (const [k, b] of this.perConversation) perConversation[k] = b.available();
    return {
      global: this.global ? this.global.available() : null,
      perConversation,
    };
  }

  private bucketFor(conversationId: string): TokenBucket {
    let bucket = this.perConversation.get(conversationId);
    if (!bucket) {
      if (this.perConvRate === null) {
        throw new Error('bucketFor called while per-conversation rate is unset');
      }
      const opts: { ratePerSec: number; burst?: number; now?: () => number } = {
        ratePerSec: this.perConvRate,
        now: this.clock,
      };
      if (this.perConvBurst !== null) opts.burst = this.perConvBurst;
      bucket = new TokenBucket(opts);
      this.perConversation.set(conversationId, bucket);
      this.evictLRU();
    } else {
      // Refresh LRU position.
      this.perConversation.delete(conversationId);
      this.perConversation.set(conversationId, bucket);
    }
    return bucket;
  }

  private evictLRU(): void {
    while (this.perConversation.size > this.maxConvBuckets) {
      const oldest = this.perConversation.keys().next().value;
      if (oldest === undefined) return;
      this.perConversation.delete(oldest);
    }
  }

  private async drainBucket(
    bucket: TokenBucket,
    deadlineMs: number,
    scope: 'global' | 'per-conversation',
    conversationId: string | null,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    while (!bucket.tryTake(1)) {
      if (signal?.aborted) throw new Error('OutboundRateLimiter: aborted');
      const waitMs = Math.min(100, deadlineMs - this.clock());
      if (waitMs <= 0) {
        throw new OutboundRateLimitTimeoutError(scope, conversationId, this.maxWaitMs);
      }
      await this.sleep(waitMs, signal);
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Provider-level rate limiting.
 *
 * A token bucket enforced at the {@link LLMProvider.complete} callsite.
 * When the bucket is empty, the call awaits the refill before proceeding —
 * the dispatcher sees per-skill turns queue naturally through the same
 * concurrency machinery it already uses. No events dropped; no retries
 * triggered by our own 429-equivalent.
 *
 * Design notes:
 * - Wrapper is narrow. `countTokens` is a pure local calculation and is
 *   passed through unchanged. `stream` is passed through but gated on
 *   first-chunk delivery so a streaming call still consumes a token.
 * - `onWait` callback is the hook the CLI uses to bump
 *   `declaragent_provider_rate_limit_{waits_total,wait_ms}` counters
 *   through its shared PrometheusRegistry (Slice 1).
 * - The bucket uses the WALL clock by default (`Date.now`). Tests inject
 *   `now()` + a custom `sleep` to drive time deterministically.
 *
 * @since 0.6.0-slice.4
 */

import type { LLMProvider } from '../types/llm.js';

// ── Token bucket ──────────────────────────────────────────────────────────

export interface ProviderTokenBucketOptions {
  /** Steady-state rate in tokens per second. Must be > 0. */
  ratePerSec: number;
  /**
   * Max tokens the bucket can hold (burst capacity). Defaults to
   * `max(ratePerSec, 1)` — lets a single-RPS limiter pass one call
   * through before starting to throttle.
   */
  burst?: number;
  /** Injected monotonic clock. Default: `Date.now`. */
  now?: () => number;
  /**
   * Injected sleep. Default: `setTimeout`-based. Tests override with a
   * promise-tracking fake so the test clock can advance deterministically.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Leaky-bucket-style token bucket. `take()` returns the time the caller
 * waited before acquiring a token (0 when the bucket had capacity).
 */
export class ProviderTokenBucket {
  readonly ratePerSec: number;
  readonly burst: number;
  private tokens: number;
  private lastRefillMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ProviderTokenBucketOptions) {
    if (!(options.ratePerSec > 0)) {
      throw new Error('TokenBucket requires ratePerSec > 0');
    }
    this.ratePerSec = options.ratePerSec;
    this.burst = Math.max(1, options.burst ?? options.ratePerSec);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = this.burst;
    this.lastRefillMs = this.now();
  }

  /** Refill tokens based on wall time elapsed since the last refill. */
  private refill(): void {
    const now = this.now();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    if (elapsedMs === 0) return;
    const added = (elapsedMs / 1000) * this.ratePerSec;
    this.tokens = Math.min(this.burst, this.tokens + added);
    this.lastRefillMs = now;
  }

  /**
   * Take one token, awaiting a refill if needed. Returns the ms waited
   * (0 = immediate). Deterministic under an injected clock + sleep.
   */
  async take(): Promise<number> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    // How long until the bucket has one full token?
    const needed = 1 - this.tokens;
    const waitMs = Math.ceil((needed / this.ratePerSec) * 1000);
    await this.sleep(waitMs);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
    return waitMs;
  }

  /**
   * Attempt to take one token without sleeping. Returns `true` if a
   * token was consumed, `false` if the bucket was empty at the time
   * of call (caller decides how to handle — e.g. fail-fast rejects
   * used by the MCP aggregate rate-limit gate).
   *
   * @since 0.7.5 — Post-Enterprise Backlog #27
   */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Current token count — primarily for tests/diagnostics. */
  get available(): number {
    this.refill();
    return this.tokens;
  }
}

// ── Provider wrapper ──────────────────────────────────────────────────────

export interface ProviderRateLimitOptions extends ProviderTokenBucketOptions {
  /**
   * Fired whenever a call had to wait for a token. The CLI bumps
   * Prometheus counters from here. Swallowed errors: the hook must
   * never throw; if it does, the wrapper catches and continues.
   */
  onWait?: (waitMs: number) => void;
}

/**
 * Wrap an {@link LLMProvider} with a token-bucket rate limiter. Every
 * call to `complete()` (and the first chunk of a `stream()` call) takes
 * one token. When the bucket is empty the call awaits the refill.
 *
 * The wrapper is transparent — consumers see the same {@link LLMProvider}
 * shape and the same errors.
 */
export function withProviderRateLimit(
  provider: LLMProvider,
  options: ProviderRateLimitOptions,
): LLMProvider {
  const bucket = new ProviderTokenBucket(options);
  const onWait = options.onWait;

  async function gate(): Promise<void> {
    const waitedMs = await bucket.take();
    if (waitedMs > 0 && onWait) {
      try {
        onWait(waitedMs);
      } catch {
        // Hook misbehaved. We still served the call; swallow.
      }
    }
  }

  const wrapped: LLMProvider = {
    name: provider.name,
    countTokens: (messages) => provider.countTokens(messages),
    async complete(request, signal) {
      await gate();
      return provider.complete(request, signal);
    },
  };
  if (provider.stream) {
    const innerStream = provider.stream.bind(provider);
    wrapped.stream = (request, signal) => gateStream(() => innerStream(request, signal), gate);
  }
  return wrapped;
}

function gateStream<T>(start: () => AsyncIterable<T>, gate: () => Promise<void>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let inner: AsyncIterator<T> | null = null;
      let gated = false;
      return {
        async next(): Promise<IteratorResult<T>> {
          if (!gated) {
            gated = true;
            await gate();
            inner = start()[Symbol.asyncIterator]();
          }
          return (inner as AsyncIterator<T>).next();
        },
        async return(value?: unknown): Promise<IteratorResult<T>> {
          if (inner?.return) return inner.return(value);
          return { done: true, value: value as T };
        },
        async throw(err?: unknown): Promise<IteratorResult<T>> {
          if (inner?.throw) return inner.throw(err);
          throw err;
        },
      };
    },
  };
}

// ── Defaults ──────────────────────────────────────────────────────────────

/**
 * Sensible per-provider steady-state defaults, picked from each
 * provider's published limits. Conservative — the bucket's burst is
 * equal to the rate, so a fresh up-process can absorb one rate-worth
 * of calls before throttling kicks in.
 *
 * Operators who want higher throughput should set a custom rate via
 * env var or (future) agent.yaml override. Setting rate = Infinity
 * disables the limiter by making `take()` always return immediately.
 *
 * @since 0.6.0-slice.4
 */
export const DEFAULT_PROVIDER_RATE_PER_SEC: Readonly<Record<string, number>> = {
  // Anthropic tier-4 default (Opus): 50 requests/second. Tier-1 is 5,
  // which most prod users outgrow fast — we bias toward the higher
  // tier and let low-tier users dial it down.
  anthropic: 50,
  // OpenRouter: no hard published limit, but 20 rps is a safe cap
  // that keeps us well clear of proxy-level throttles.
  openrouter: 20,
};

/**
 * Resolve the rate (rps) for a given provider id. Unknown providers
 * fall back to a conservative 10 rps — enough for typical webhook
 * traffic, low enough to be safe for a brand-new key.
 */
export function defaultRateForProvider(providerId: string): number {
  return DEFAULT_PROVIDER_RATE_PER_SEC[providerId] ?? 10;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-target rate limiting for the event dispatcher (slice 14).
 *
 * Two pieces:
 *   1. `TokenBucket` — classic leaky-bucket / token-bucket primitive.
 *      Starts full at `burst` tokens; drains one per `tryTake()`; refills
 *      at `ratePerSec`. Cheap enough to instantiate per rate-limit rule.
 *   2. `PerTargetRateLimiter` — maps an `EventTarget` to zero-or-more
 *      matching rules, and allows-or-denies based on the first matching
 *      rule whose bucket is exhausted.
 *
 * The dispatcher consults the limiter right before `executeTarget(...)`.
 * On denial it short-circuits with `{ kind: 'rejected', reason:
 * 'rate-limit' }` so callers can distinguish transient overload from a
 * misconfigured target.
 */

import type { EventTarget } from './types.js';

// ─── TokenBucket ─────────────────────────────────────────────────────────

export interface TokenBucketOptions {
  /** Refill rate in tokens per second. Must be > 0. */
  ratePerSec: number;
  /** Max tokens the bucket can hold. Defaults to `ratePerSec` (1-second burst). */
  burst?: number;
  /** Injected clock (ms-epoch). Default: `Date.now`. */
  now?: () => number;
}

/**
 * Continuous-refill token bucket. We track tokens as a fractional value
 * so e.g. `ratePerSec: 0.5` gives "one token every 2 seconds" without
 * integer rounding problems.
 */
export class TokenBucket {
  readonly ratePerSec: number;
  readonly burst: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillAt: number;

  constructor(options: TokenBucketOptions) {
    if (!(options.ratePerSec > 0)) {
      throw new Error(`TokenBucket: ratePerSec must be > 0 (got ${options.ratePerSec})`);
    }
    this.ratePerSec = options.ratePerSec;
    this.burst = options.burst ?? options.ratePerSec;
    if (this.burst < 1) {
      throw new Error(`TokenBucket: burst must be >= 1 (got ${this.burst})`);
    }
    this.now = options.now ?? Date.now;
    this.tokens = this.burst;
    this.lastRefillAt = this.now();
  }

  /** Current token count (after refill). For tests + metrics. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Try to spend `cost` tokens. Returns true on success. On failure the
   * bucket is left unchanged so callers can retry after a wait.
   */
  tryTake(cost = 1): boolean {
    this.refill();
    if (this.tokens + 1e-9 < cost) return false;
    this.tokens -= cost;
    return true;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    const add = (elapsed / 1000) * this.ratePerSec;
    this.tokens = Math.min(this.burst, this.tokens + add);
    this.lastRefillAt = now;
  }
}

// ─── Rate limit rules ────────────────────────────────────────────────────

export type EventTargetType = EventTarget['type'];

export interface RateLimitRule {
  /**
   * Target type this rule applies to. Use `'*'` to match every type.
   */
  target: EventTargetType | '*';
  /**
   * Optional narrowing identifier:
   *   - `session` → `sessionId`
   *   - `skill` → `name`
   *   - `sub-agent` → `parentSessionId`
   * Ignored for `broadcast` + `new-session` (neither has a stable id).
   * Omit to apply the rule to every target of the given type.
   */
  id?: string;
  /** Refill rate in tokens per second. */
  ratePerSec: number;
  /** Max burst (bucket capacity). Defaults to `ratePerSec`. */
  burst?: number;
}

export interface RateLimitSpec {
  byTarget: readonly RateLimitRule[];
}

// ─── PerTargetRateLimiter ────────────────────────────────────────────────

/**
 * Stable key used as the map key in `buckets`. The key fully identifies
 * the rule (type + optional id) so two rules with the same target
 * specification share a bucket, which is usually what callers want.
 */
function ruleKey(rule: RateLimitRule): string {
  return rule.id === undefined ? `${rule.target}` : `${rule.target}:${rule.id}`;
}

/**
 * Extract the candidate id from a target. Returns `undefined` for
 * `broadcast` / `new-session` (no natural identity).
 */
export function targetIdentity(target: EventTarget): string | undefined {
  switch (target.type) {
    case 'session':
      return target.sessionId;
    case 'skill':
      return target.name;
    case 'sub-agent':
      return target.parentSessionId;
    case 'broadcast':
    case 'new-session':
      return undefined;
  }
}

export interface PerTargetRateLimiterOptions {
  spec: RateLimitSpec;
  /** Injected clock (ms-epoch). Default: `Date.now`. */
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Key of the rule that caused the denial (allowed=true leaves this unset). */
  deniedByKey?: string;
  /** The rule that caused the denial. */
  deniedByRule?: RateLimitRule;
}

export class PerTargetRateLimiter {
  private readonly rules: readonly RateLimitRule[];
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly now: () => number;

  constructor(options: PerTargetRateLimiterOptions) {
    this.rules = options.spec.byTarget;
    this.now = options.now ?? Date.now;
  }

  /**
   * Decide whether `target` is allowed through. A target is denied as
   * soon as any matching rule's bucket is exhausted; matching rules with
   * tokens still available are spent (so a target can't dodge a tight
   * rule by also triggering a loose one).
   */
  allow(target: EventTarget): RateLimitDecision {
    const identity = targetIdentity(target);
    const matches = this.rules.filter(
      (r) =>
        (r.target === '*' || r.target === target.type) && (r.id === undefined || r.id === identity),
    );
    if (matches.length === 0) return { allowed: true };
    // Two-pass: check everyone first (so a denial on rule B doesn't half-
    // spend rule A). If all are OK, take from each.
    for (const rule of matches) {
      const bucket = this.bucketFor(rule);
      if (bucket.available() < 1) {
        return {
          allowed: false,
          deniedByKey: ruleKey(rule),
          deniedByRule: rule,
        };
      }
    }
    for (const rule of matches) {
      this.bucketFor(rule).tryTake(1);
    }
    return { allowed: true };
  }

  /** For tests + /status output. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, b] of this.buckets) out[k] = b.available();
    return out;
  }

  private bucketFor(rule: RateLimitRule): TokenBucket {
    const k = ruleKey(rule);
    let bucket = this.buckets.get(k);
    if (!bucket) {
      const opts: TokenBucketOptions = { ratePerSec: rule.ratePerSec, now: this.now };
      if (rule.burst !== undefined) opts.burst = rule.burst;
      bucket = new TokenBucket(opts);
      this.buckets.set(k, bucket);
    }
    return bucket;
  }
}

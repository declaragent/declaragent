/**
 * Lightweight circuit breaker used by `BaseSourceInstance` to pause a
 * source when its handler is failing consistently. Classic three-state
 * machine — `closed` (healthy), `open` (failing; short-circuit), and
 * `half-open` (cool-down probe). Intentionally simple: no rolling-window
 * percentiles, no buckets. Consecutive-failure threshold + fixed
 * reset-after timer covers the primary Phase-4 use case ("consumer is
 * 100% erroring, stop hammering the broker").
 */

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that flip `closed → open`. Default: 5. */
  failureThreshold?: number;
  /**
   * Consecutive successes in `half-open` that flip to `closed`.
   * Default: 1 — as soon as one probe succeeds the breaker closes.
   */
  successThreshold?: number;
  /** Ms spent in `open` before flipping to `half-open` for a probe. Default: 30_000. */
  resetTimeoutMs?: number;
  /** Injected clock. Default: `Date.now`. */
  now?: () => number;
}

export type CircuitBreakerTransitionEvent = {
  from: CircuitBreakerState;
  to: CircuitBreakerState;
  /** Millis-epoch at transition. */
  at: number;
};

export type CircuitBreakerTransitionListener = (event: CircuitBreakerTransitionEvent) => void;

export class CircuitBreaker {
  readonly failureThreshold: number;
  readonly successThreshold: number;
  readonly resetTimeoutMs: number;

  private readonly now: () => number;
  private _state: CircuitBreakerState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt: number | null = null;
  private readonly listeners = new Set<CircuitBreakerTransitionListener>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.successThreshold = Math.max(1, options.successThreshold ?? 1);
    this.resetTimeoutMs = Math.max(0, options.resetTimeoutMs ?? 30_000);
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitBreakerState {
    // Lazily flip `open → half-open` when the cool-down has elapsed. This
    // lets the breaker advance without needing a timer, so tests can drive
    // it by overriding `now`.
    if (this._state === 'open' && this.openedAt !== null) {
      if (this.now() - this.openedAt >= this.resetTimeoutMs) {
        this.transitionTo('half-open');
      }
    }
    return this._state;
  }

  /**
   * Ask whether the next call should be attempted. Accurately reflects
   * state transitions caused by the cool-down timer elapsing.
   */
  allow(): boolean {
    const s = this.state;
    return s === 'closed' || s === 'half-open';
  }

  /** Record the outcome of a protected call. */
  record(success: boolean): void {
    if (success) this.onSuccess();
    else this.onFailure();
  }

  /** Convenience: wrap a promise-returning fn with record() semantics. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.allow()) {
      throw new Error(`circuit-breaker: rejected (state=${this._state})`);
    }
    try {
      const out = await fn();
      this.record(true);
      return out;
    } catch (err) {
      this.record(false);
      throw err;
    }
  }

  /** Force the breaker open (operator action). */
  trip(): void {
    if (this._state !== 'open') {
      this.transitionTo('open');
    }
  }

  /** Force the breaker closed (operator action). Resets counters. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = null;
    if (this._state !== 'closed') {
      this.transitionTo('closed');
    }
  }

  /**
   * Subscribe to state transitions. Returns unsubscribe. Notifications
   * are fire-and-forget — listener errors are swallowed so a bad
   * subscriber can't wedge the breaker.
   */
  onTransition(listener: CircuitBreakerTransitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Internal state machine ──────────────────────────────────────────────

  private onSuccess(): void {
    // Re-evaluate state so a cool-down can flip us into half-open first.
    const s = this.state;
    if (s === 'half-open') {
      this.consecutiveSuccesses += 1;
      this.consecutiveFailures = 0;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.reset();
      }
      return;
    }
    // closed or (unreachable) open — treat as healthy and clear counters.
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
  }

  private onFailure(): void {
    const s = this.state;
    if (s === 'half-open') {
      // Probe failed — reopen and restart cool-down.
      this.consecutiveSuccesses = 0;
      this.consecutiveFailures += 1;
      this.transitionTo('open');
      return;
    }
    if (s === 'open') {
      // Already open; counter accumulation is unnecessary.
      return;
    }
    this.consecutiveFailures += 1;
    this.consecutiveSuccesses = 0;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.transitionTo('open');
    }
  }

  private transitionTo(to: CircuitBreakerState): void {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    if (to === 'open') {
      this.openedAt = this.now();
    } else {
      this.openedAt = null;
    }
    if (to === 'closed') {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
    }
    const event: CircuitBreakerTransitionEvent = { from, to, at: this.now() };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // swallow listener errors — the breaker must stay coherent.
      }
    }
  }
}

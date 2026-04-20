/**
 * Bounded-concurrency semaphore. Backpressure primitive used by
 * `BaseSourceInstance` to cap in-flight message handlers per source.
 *
 * ```ts
 * const limiter = new ConcurrencyLimiter(8);
 * const release = await limiter.acquire();
 * try { await doWork(); } finally { release(); }
 * ```
 *
 * Waiters are served in FIFO order — a source under load doesn't lose
 * the ability to make forward progress as new arrivals pile up.
 */
export class ConcurrencyLimiter {
  private inflight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(public readonly max: number) {
    if (!Number.isInteger(max) || max <= 0) {
      throw new Error(`ConcurrencyLimiter max must be a positive integer, got ${max}`);
    }
  }

  /**
   * Reserve one slot. If fewer than `max` slots are in use, returns
   * immediately; otherwise waits until a peer releases. The returned
   * function MUST be called exactly once to free the slot.
   */
  acquire(): Promise<() => void> {
    if (this.inflight < this.max) {
      this.inflight += 1;
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        this.release();
      });
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.inflight += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.release();
        });
      });
    });
  }

  private release(): void {
    this.inflight -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** Number of slots currently held. */
  get currentInflight(): number {
    return this.inflight;
  }

  /** Number of acquirers waiting for a slot. */
  get queueDepth(): number {
    return this.waiters.length;
  }
}

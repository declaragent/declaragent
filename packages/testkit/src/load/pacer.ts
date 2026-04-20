/**
 * Rate-limited loop driver.
 *
 * `runAtRate({ ratePerSec, totalMessages, onTick })` calls `onTick(n)`
 * at the specified rate until `totalMessages` messages have been
 * produced or the abort signal fires. Uses a deficit-based scheduler so
 * short producer hiccups don't reduce the long-run throughput.
 */

export interface RunAtRateOptions {
  ratePerSec: number;
  /** Max messages to produce. Infinity runs until `signal` aborts. */
  totalMessages?: number;
  /** Batch size per tick; higher means fewer setTimeout wakeups. */
  batchSize?: number;
  /** Abort signal to stop early. */
  signal?: AbortSignal;
  /**
   * Called once per produced message. Receives the 0-based sequence
   * number. Throwing aborts the loop with the thrown error.
   */
  onTick: (seq: number) => Promise<void> | void;
  /** Optional clock (ms-epoch). Default `Date.now`. */
  now?: () => number;
}

export interface RunAtRateResult {
  produced: number;
  elapsedMs: number;
  actualRatePerSec: number;
  aborted: boolean;
}

export async function runAtRate(options: RunAtRateOptions): Promise<RunAtRateResult> {
  const now = options.now ?? Date.now;
  const total =
    options.totalMessages === undefined || options.totalMessages < 0
      ? Number.POSITIVE_INFINITY
      : options.totalMessages;
  const batchSize = Math.max(1, options.batchSize ?? 16);
  const intervalMs = 1000 / options.ratePerSec;
  const start = now();
  let produced = 0;
  let aborted = false;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (options.signal?.aborted) return resolve();
      const timer = setTimeout(
        () => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });

  while (produced < total) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const elapsed = now() - start;
    // Deficit-based scheduling: catch up when we're behind.
    const targetByNow = Math.min(total, Math.ceil(elapsed / intervalMs));
    const behind = targetByNow - produced;
    const thisBatch = Math.min(batchSize, total - produced, Math.max(1, behind));
    for (let i = 0; i < thisBatch; i++) {
      await options.onTick(produced);
      produced += 1;
      if (produced >= total) break;
    }
    if (produced >= total) break;
    // Wait for the next logical tick.
    const nextDeadline = start + produced * intervalMs;
    const waitMs = nextDeadline - now();
    if (waitMs > 0) await sleep(waitMs);
  }

  const elapsedMs = now() - start;
  const actualRatePerSec = elapsedMs > 0 ? (produced / elapsedMs) * 1000 : 0;
  return { produced, elapsedMs, actualRatePerSec, aborted };
}

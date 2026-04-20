import type { ChaosTargetRuntime } from '../types.js';

/**
 * Phase 6 slice-7 `expire-idempotency-cache` fault.
 *
 * Clears every entry in a caller-supplied idempotency cache so a
 * subsequent replay of a recently-processed event looks net-new to the
 * dispatcher. The `dedup-never-drops` assertion then verifies the bus
 * still de-duplicates at least once (via the event id) + that the audit
 * log records exactly one `tool_call` per correlation id.
 */

export interface ExpireIdempotencyCacheFaultOptions {
  /** Caches to expire. The dispatcher + the channel send-idempotency layer both qualify. */
  caches: readonly ExpirableCache[];
}

export interface ExpirableCache {
  clear(): void | Promise<void>;
}

export function createExpireIdempotencyCacheFault(
  opts: ExpireIdempotencyCacheFaultOptions,
): Required<Pick<ChaosTargetRuntime, 'expireIdempotencyCache'>> {
  async function expireIdempotencyCache(): Promise<void> {
    await Promise.all(opts.caches.map((c) => Promise.resolve(c.clear())));
  }
  return { expireIdempotencyCache };
}

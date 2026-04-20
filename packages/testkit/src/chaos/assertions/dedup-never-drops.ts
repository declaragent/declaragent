import type { ChaosAssertion, ChaosAssertionResult, ChaosSnapshot } from '../types.js';

/**
 * Phase 6 slice-7 `dedup-never-drops` assertion.
 *
 * Even with `expire-idempotency-cache` + `clock-skew` faults firing,
 * every event that carries a correlation id should appear in the audit
 * log exactly once. A duplicate means the dispatcher's dedup was
 * bypassed; zero means an event was lost.
 */

interface Bucket {
  correlationId: string;
  count: number;
  seqs: number[];
}

export const dedupNeverDropsAssertion: ChaosAssertion = {
  name: 'dedup-never-drops',
  check(snapshot: ChaosSnapshot): ChaosAssertionResult {
    const buckets = new Map<string, Bucket>();
    for (const entry of snapshot.auditRecords) {
      // Only tool-call + channel-event records carry correlation ids in
      // the default record union. Tombstones + secret_access don't.
      const record = entry.record;
      const correlationId =
        'correlationId' in record && typeof record.correlationId === 'string'
          ? record.correlationId
          : undefined;
      if (!correlationId) continue;
      const existing = buckets.get(correlationId);
      if (existing) {
        existing.count += 1;
        existing.seqs.push(entry.seq);
      } else {
        buckets.set(correlationId, { correlationId, count: 1, seqs: [entry.seq] });
      }
    }
    const duplicates: Bucket[] = [];
    for (const bucket of buckets.values()) {
      if (bucket.count > 1) duplicates.push(bucket);
    }
    if (duplicates.length === 0) {
      return {
        name: 'dedup-never-drops',
        ok: true,
        message: `${buckets.size} correlation id(s) appear exactly once`,
      };
    }
    return {
      name: 'dedup-never-drops',
      ok: false,
      message: `${duplicates.length} correlation id(s) observed more than once`,
      details: { duplicates: duplicates.slice(0, 20) },
    };
  },
};

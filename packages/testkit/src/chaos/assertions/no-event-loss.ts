import type { MetricRecord } from '@declaragent/core';
import type { ChaosAssertion, ChaosAssertionResult, ChaosSnapshot } from '../types.js';

/**
 * Phase 6 slice-7 `no-event-loss` assertion.
 *
 * Walks the metric snapshot and verifies the per-source invariant:
 *
 *   received == processed + dlq + inflight
 *
 * Any gap in that equality means an event was silently dropped
 * somewhere in the pipeline — the exact failure mode the chaos harness
 * exists to surface.
 */

interface Counters {
  received: number;
  processed: number;
  failed: number;
  dlq: number;
  inflight: number;
}

function sumCounter(metrics: readonly MetricRecord[], name: string, id: string): number {
  let total = 0;
  for (const m of metrics) {
    if (m.name !== name) continue;
    if (m.kind === 'counter' && m.op === 'inc' && (!id || m.labels?.id === id)) {
      total += m.value;
    }
  }
  return total;
}

function lastGauge(metrics: readonly MetricRecord[], name: string, id: string): number {
  let last = 0;
  for (const m of metrics) {
    if (m.name !== name) continue;
    if (m.kind === 'gauge' && (!id || m.labels?.id === id)) {
      if (m.op === 'set') last = m.value;
      else if (m.op === 'inc') last += m.value;
      else if (m.op === 'dec') last -= m.value;
    }
  }
  return last;
}

function perSource(metrics: readonly MetricRecord[]): Map<string, Counters> {
  const ids = new Set<string>();
  for (const m of metrics) {
    if (typeof m.labels?.id === 'string') ids.add(m.labels.id);
  }
  const out = new Map<string, Counters>();
  for (const id of ids) {
    out.set(id, {
      received: sumCounter(metrics, 'source.messages.received', id),
      processed: sumCounter(metrics, 'source.messages.processed', id),
      failed: sumCounter(metrics, 'source.messages.failed', id),
      dlq: sumCounter(metrics, 'source.messages.dlq', id),
      inflight: lastGauge(metrics, 'source.inflight', id),
    });
  }
  return out;
}

export const noEventLossAssertion: ChaosAssertion = {
  name: 'no-event-loss',
  check(snapshot: ChaosSnapshot): ChaosAssertionResult {
    const perId = perSource(snapshot.metrics);
    const offenders: Array<{
      id: string;
      received: number;
      processed: number;
      dlq: number;
      inflight: number;
      leaked: number;
    }> = [];
    for (const [id, c] of perId) {
      const leaked = c.received - (c.processed + c.dlq + c.inflight);
      if (leaked > 0) {
        offenders.push({
          id,
          received: c.received,
          processed: c.processed,
          dlq: c.dlq,
          inflight: c.inflight,
          leaked,
        });
      }
    }
    if (offenders.length === 0) {
      return {
        name: 'no-event-loss',
        ok: true,
        message: `every source balances received == processed + dlq + inflight (${perId.size} sources)`,
      };
    }
    return {
      name: 'no-event-loss',
      ok: false,
      message: `${offenders.length} source(s) leaked events`,
      details: { offenders },
    };
  },
};

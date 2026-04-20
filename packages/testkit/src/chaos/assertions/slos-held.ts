import type { MetricRecord } from '@declaragent/core';
import type { ChaosAssertion, ChaosAssertionResult, ChaosSnapshot } from '../types.js';

/**
 * Phase 6 slice-7 `slos-held` assertion.
 *
 * Checks the two Phase-6 SLOs the chaos soak exists to stress:
 *
 *   1. p99 outbound channel latency stays below `maxOutboundP99Ms`.
 *   2. DLQ rate stays below `maxDlqRate` (0.01 = 1 %).
 *
 * p99 is computed from the histogram observations captured in the
 * snapshot's metric records. DLQ rate is `source.messages.dlq` over
 * `source.messages.received`.
 */

export interface SlosHeldAssertionOptions {
  /** Max p99 channel outbound latency. Default 10 000 ms (chaos SLO). */
  maxOutboundP99Ms?: number;
  /** Max DLQ ratio (0..1). Default 0.01 (1 %). */
  maxDlqRate?: number;
}

function observationsOf(metrics: readonly MetricRecord[], name: string): number[] {
  const out: number[] = [];
  for (const m of metrics) {
    if (m.name === name && m.kind === 'histogram' && m.op === 'observe') {
      out.push(m.value);
    }
  }
  return out;
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(sorted.length * pct), sorted.length - 1);
  return sorted[idx] ?? 0;
}

function sumCounter(metrics: readonly MetricRecord[], name: string): number {
  let total = 0;
  for (const m of metrics) {
    if (m.name === name && m.kind === 'counter' && m.op === 'inc') {
      total += m.value;
    }
  }
  return total;
}

export function createSlosHeldAssertion(options: SlosHeldAssertionOptions = {}): ChaosAssertion {
  const maxP99 = options.maxOutboundP99Ms ?? 10_000;
  const maxDlq = options.maxDlqRate ?? 0.01;

  return {
    name: 'slos-held',
    check(snapshot: ChaosSnapshot): ChaosAssertionResult {
      const p99 = percentile(observationsOf(snapshot.metrics, 'channel.outbound.latency_ms'), 0.99);
      const received = sumCounter(snapshot.metrics, 'source.messages.received');
      const dlq = sumCounter(snapshot.metrics, 'source.messages.dlq');
      const dlqRate = received > 0 ? dlq / received : 0;
      const p99Ok = p99 <= maxP99;
      const dlqOk = dlqRate <= maxDlq;
      const ok = p99Ok && dlqOk;
      const message = ok
        ? `p99 ${p99.toFixed(0)} ms ≤ ${maxP99} ms; DLQ rate ${(dlqRate * 100).toFixed(2)}% ≤ ${(maxDlq * 100).toFixed(2)}%`
        : `SLO breach (p99=${p99.toFixed(0)}ms/${maxP99}ms, dlq=${(dlqRate * 100).toFixed(2)}%/${(maxDlq * 100).toFixed(2)}%)`;
      return {
        name: 'slos-held',
        ok,
        message,
        details: {
          p99Ms: p99,
          maxP99Ms: maxP99,
          dlqRate,
          maxDlqRate: maxDlq,
          receivedTotal: received,
          dlqTotal: dlq,
        },
      };
    },
  };
}

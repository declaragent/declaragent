/**
 * Per-run tracker: consumes events-on-bus and reconciles them against
 * the producer's sequence/timestamp headers. Reports:
 *
 *   processed     — total bus events observed
 *   unique        — distinct seq values seen
 *   duplicates    — events whose seq was already seen
 *   missing       — seq values in [0, expected) not yet seen
 *   latency stats — p50/p95/p99 over (now - sent)
 *
 * Offset-commit correctness, for slice-16 purposes, is "unique ==
 * expected && duplicates == 0 at steady state." A broker restart that
 * replays a few messages is considered acceptable as long as the
 * downstream skill is idempotent — in the harness the test skill is
 * keyed on seq, so duplicates are recorded but don't inflate `unique`.
 */

import type { AgentEvent, EventBus } from '@declaragent/core';
import { LOAD_SENT_HEADER, LOAD_SEQ_HEADER } from './kafka-producer.js';
import { LatencyRecorder } from './latency.js';

export interface LoadTrackerOptions {
  bus: EventBus;
  /**
   * Total messages expected across the run. Used to compute `missing`.
   * When the test runs until an external signal (no fixed count),
   * pass `Infinity` and ignore `missing`.
   */
  expected: number;
  /**
   * Optional injected clock for measuring elapsed time. Default: `Date.now`.
   */
  now?: () => number;
  /**
   * Only observe events whose `kind` matches. Default: all events.
   */
  kind?: string;
}

export interface LoadTrackerReport {
  processed: number;
  unique: number;
  duplicates: number;
  missing: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
  durationMs: number;
  latency: ReturnType<LatencyRecorder['summary']>;
  /** seq values seen > once. Cap at 100 so the report stays small. */
  duplicateExamples: readonly number[];
  /** seq values in [0, expected) that never arrived. Cap at 100. */
  missingExamples: readonly number[];
}

export class LoadTracker {
  private readonly bus: EventBus;
  private readonly expected: number;
  private readonly now: () => number;
  private readonly kindFilter?: string;
  private readonly seen = new Set<number>();
  private readonly dupCounts = new Map<number, number>();
  private readonly latency = new LatencyRecorder({ maxSamples: 1_000_000 });
  private processedCount = 0;
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  private detach: (() => void) | null = null;

  constructor(options: LoadTrackerOptions) {
    this.bus = options.bus;
    this.expected = options.expected;
    this.now = options.now ?? Date.now;
    if (options.kind !== undefined) this.kindFilter = options.kind;
  }

  start(): void {
    if (this.detach) return;
    this.detach = this.bus.subscribe('*', (event) => this.onEvent(event));
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
  }

  private onEvent(event: AgentEvent): void {
    if (this.kindFilter && event.kind !== this.kindFilter) return;
    const headers = extractHeaders(event);
    const seqRaw = headers[LOAD_SEQ_HEADER];
    const sentRaw = headers[LOAD_SENT_HEADER];
    if (seqRaw === undefined) return; // not one of our load messages
    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq < 0) return;

    const arrivedAt = this.now();
    this.processedCount += 1;
    if (this.firstAt === null) this.firstAt = arrivedAt;
    this.lastAt = arrivedAt;
    if (this.seen.has(seq)) {
      this.dupCounts.set(seq, (this.dupCounts.get(seq) ?? 1) + 1);
    } else {
      this.seen.add(seq);
    }
    if (sentRaw !== undefined) {
      const sent = Number(sentRaw);
      if (Number.isFinite(sent)) {
        const latency = arrivedAt - sent;
        if (latency >= 0) this.latency.record(latency);
      }
    }
  }

  /** Number of distinct sequence ids seen so far (cheap, no allocation). */
  uniqueCount(): number {
    return this.seen.size;
  }

  /** For test polling. */
  processedSoFar(): number {
    return this.processedCount;
  }

  report(): LoadTrackerReport {
    const durationMs =
      this.firstAt !== null && this.lastAt !== null ? this.lastAt - this.firstAt : 0;
    const duplicates = this.processedCount - this.seen.size;
    const missing: number[] = [];
    if (Number.isFinite(this.expected)) {
      for (let i = 0; i < this.expected && missing.length < 100; i++) {
        if (!this.seen.has(i)) missing.push(i);
      }
    }
    const dupExamples: number[] = [];
    for (const [seq, count] of this.dupCounts) {
      if (count > 1) dupExamples.push(seq);
      if (dupExamples.length >= 100) break;
    }
    return {
      processed: this.processedCount,
      unique: this.seen.size,
      duplicates,
      missing: Number.isFinite(this.expected) ? this.expected - this.seen.size : 0,
      firstEventAt: this.firstAt,
      lastEventAt: this.lastAt,
      durationMs,
      latency: this.latency.summary(),
      duplicateExamples: dupExamples,
      missingExamples: missing,
    };
  }
}

function extractHeaders(event: AgentEvent): Record<string, unknown> {
  // The harness expects the Kafka adapter to have populated
  // `raw.headers` and carried them through normalization into
  // `payload.headers`. BUT — our built-in passthrough normalizer in the
  // acceptance runner puts the full raw message (headers + value) into
  // `payload`. So we look in both places.
  const payload = event.payload as
    | { headers?: Record<string, unknown>; meta?: { headers?: Record<string, unknown> } }
    | undefined;
  if (payload?.headers && typeof payload.headers === 'object') {
    return payload.headers as Record<string, unknown>;
  }
  // Fall back to a top-level `meta.headers` if the normalizer stamped
  // it there.
  if (payload?.meta?.headers && typeof payload.meta.headers === 'object') {
    return payload.meta.headers as Record<string, unknown>;
  }
  return {};
}

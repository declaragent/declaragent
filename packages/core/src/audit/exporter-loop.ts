/**
 * SIEM audit export loop.
 *
 * Runs in-process alongside the `up` daemon. On a 10-second interval it:
 *
 *   1. Reads the persisted cursor via {@link TenantAuditSink.readExportCursor}.
 *   2. Pulls new audit rows with `sink.query({ sinceSeq, order: 'asc', limit })`.
 *   3. Hands the batch to the configured {@link AuditExporter.push}.
 *   4. On ack, advances the cursor by the acked count.
 *   5. On transient failure, re-queues (same rows re-fetched next tick)
 *      and increments a consecutive-failure counter.
 *   6. After {@link AuditExportLoopOptions.maxConsecutiveFailures} (default 5)
 *      the loop pauses and emits a Prometheus gauge so operators get an
 *      alert. Manual resume via `handle.resume()` or `up` restart.
 *
 * Atomicity: the cursor advances only after the vendor acks. The worst
 * case on a crash mid-batch is at-least-once delivery (vendor got the
 * rows, we restart, push them again) — every exporter envelope carries
 * the monotonic `seq`, so downstream dedup is cheap (`_id` in Elastic,
 * an index-time lookup in Splunk/Datadog).
 *
 * Back-pressure (0.7.4 — POST_ENTERPRISE_BACKLOG.md #11)
 * ------------------------------------------------------
 * An optional {@link BackpressureController} pauses NEW audit writes
 * when the oldest unshipped row's age exceeds
 * `backpressure.pauseAfterBacklogMs` (default 1 h). The loop evaluates
 * the threshold on a separate timer (`evaluateIntervalMs`, default
 * 30 s) so intake gating is decoupled from export cadence; the export
 * loop keeps draining at full speed while paused so the queue
 * eventually unblocks itself. The controller also resumes
 * automatically once the oldest unshipped row ages back under
 * threshold.
 *
 * Adaptive batch interval (0.7.4 — POST_ENTERPRISE_BACKLOG.md #12)
 * ---------------------------------------------------------------
 * At 10k tool-calls/sec a fixed 10 s interval produces 100k-row
 * batches that OOM vendor shippers. Instead, the loop runs a simple
 * proportional controller:
 *
 *   next = clamp(current * (targetRows / rowsShipped), min, max)
 *
 * A burst that ships `batchSize` rows (queue was deeper than the
 * batch cap) compresses the next interval toward `minIntervalMs`;
 * steady state where the batch comes back `targetRows`-sized stays at
 * the current cadence; quiet queues (few rows) relax toward
 * `maxIntervalMs`. Empty queues skip adjustment + stay at
 * `maxIntervalMs` so an idle tenant isn't polling every 200 ms.
 *
 * @since 0.6.x — Enterprise Production Plan §3 Item #10
 * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #11, #12
 */

import type { Histogram } from '../events/types.js';
import type { PrometheusRegistry } from '../observability/prometheus.js';
import type { Logger } from '../types/logger.js';
import type { BackpressureController } from './backpressure.js';
import { toExportEntry } from './exporters/exporter.js';
import type { AuditExporter } from './exporters/exporter.js';
import type { TenantAuditSink } from './types.js';

export interface AuditExportLoopBackpressureOptions {
  /** Enable back-pressure gating. Default `false` (opt-in). */
  enabled?: boolean;
  /**
   * Backlog-age threshold in ms. When the oldest unshipped audit row
   * is older than this, the controller pauses new writes. Default
   * `3_600_000` (1 h).
   */
  pauseAfterBacklogMs?: number;
  /**
   * How often to evaluate the threshold, in ms. Default `30_000`
   * (30 s). A small interval means the pause kicks in sooner after a
   * sustained outage but adds one SQLite `MIN(ts)` query per interval
   * — cheap even at 10k rps.
   */
  evaluateIntervalMs?: number;
  /**
   * Shared back-pressure controller. Construct via
   * {@link createBackpressureController} and pass the same instance to
   * the sink via `CreateSqliteAuditSinkOptions.backpressure`.
   */
  controller: BackpressureController;
}

export interface AuditExportLoopBatchOptions {
  /**
   * Minimum interval the proportional controller can shrink to. Default
   * `200` ms. Below this the vendor HTTP overhead dominates and we
   * start paying latency to ship a handful of rows.
   */
  minIntervalMs?: number;
  /**
   * Maximum interval the proportional controller can relax to. Default
   * `10_000` ms — matches the original fixed cadence so the adaptive
   * path never produces a *longer* gap than today's behaviour.
   */
  maxIntervalMs?: number;
  /**
   * Target batch size (rows). The controller's setpoint — we pick the
   * next interval so the next batch is approximately this size,
   * assuming steady-state arrival rate. Default `500` (matches
   * `batchSize` default; the controller never asks the sink for more
   * rows than `batchSize` per tick).
   */
  targetBatchRows?: number;
}

export interface AuditExportLoopOptions {
  sink: TenantAuditSink;
  exporter: AuditExporter;
  /** Tick interval in ms. Default 10_000. */
  intervalMs?: number;
  /** Max rows per batch. Default 500. */
  batchSize?: number;
  /** Consecutive failures before pause. Default 5. */
  maxConsecutiveFailures?: number;
  /** Initial backoff on transient failure (ms). Default 1_000. */
  initialBackoffMs?: number;
  /** Max backoff cap on transient failure (ms). Default 30_000. */
  maxBackoffMs?: number;
  /** Optional observability sinks. */
  logger?: Logger;
  metrics?: PrometheusRegistry;
  /** Clock injection for tests. */
  now?: () => number;
  /**
   * SIEM back-pressure. Pauses NEW audit writes when the oldest
   * unshipped row's age exceeds a configured threshold.
   *
   * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #11
   */
  backpressure?: AuditExportLoopBackpressureOptions;
  /**
   * Adaptive batch-interval controller. Adjusts the tick cadence based
   * on rows-shipped-per-batch so bursts compress + steady state relaxes.
   * Omitted = fixed-cadence behaviour (pre-0.7.4).
   *
   * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #12
   */
  batch?: AuditExportLoopBatchOptions;
}

export interface AuditExportLoopHandle {
  /** True when the loop is paused because of repeated push failures. */
  isPaused(): boolean;
  /** Clear the pause flag + failure counter so the next tick retries. */
  resume(): void;
  /** Stop the loop + release the interval timer. */
  stop(): Promise<void>;
  /**
   * Force an immediate tick, skipping the scheduler wait. Returns the
   * count of rows acked (0 when paused / nothing to push). Primarily
   * for tests; production callers should rely on the interval.
   */
  flushNow(): Promise<number>;
  /**
   * Force a back-pressure evaluation (reads the sink's oldest unshipped
   * row + flips the controller). Returns the observed backlog age in
   * ms, or `null` when the queue is empty. Primarily for tests;
   * production callers rely on the evaluator timer.
   *
   * @since 0.7.4
   */
  evaluateBackpressureNow(): Promise<number | null>;
  /**
   * Current tick cadence in ms. Reflects the adaptive controller's
   * latest decision when `batch` was supplied; otherwise returns the
   * fixed `intervalMs`. Useful for assertions in tests.
   *
   * @since 0.7.4
   */
  currentIntervalMs(): number;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_BP_PAUSE_AFTER_MS = 60 * 60 * 1_000;
const DEFAULT_BP_EVALUATE_MS = 30_000;
const DEFAULT_BATCH_MIN_INTERVAL_MS = 200;
const DEFAULT_BATCH_MAX_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_TARGET_ROWS = 500;

// Histogram bucket boundaries for batch rows — geometric up to 50k so
// the +Inf overflow only catches truly pathological spikes.
const BATCH_ROW_BUCKETS: readonly number[] = [
  1, 10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000,
];

export function startAuditExportLoop(options: AuditExportLoopOptions): AuditExportLoopHandle {
  const {
    sink,
    exporter,
    intervalMs = DEFAULT_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    maxConsecutiveFailures = DEFAULT_MAX_FAILURES,
    initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    logger,
    metrics,
    now = Date.now,
    backpressure,
    batch,
  } = options;

  if (typeof sink.readExportCursor !== 'function' || typeof sink.writeExportCursor !== 'function') {
    throw new Error(
      `audit-export-loop: sink ${sink.constructor?.name ?? '<anon>'} does not implement readExportCursor/writeExportCursor. Upgrade to the SQLite sink or implement the cursor methods.`,
    );
  }
  const read = sink.readExportCursor.bind(sink);
  const write = sink.writeExportCursor.bind(sink);

  // Metrics (lazy — only registered when a registry is supplied).
  const ackedCounter = metrics?.counter(
    'declaragent.audit.export.acked_total',
    'Audit rows acked by the SIEM exporter',
  );
  const failureCounter = metrics?.counter(
    'declaragent.audit.export.failures_total',
    'Audit export push failures by retryability',
  );
  const pausedGauge = metrics?.gauge(
    'declaragent.audit.export.paused',
    'Exporter paused after N consecutive failures (1=paused, 0=running)',
  );
  const lastSeqGauge = metrics?.gauge(
    'declaragent.audit.export.last_seq',
    "Highest audit seq the exporter has ack'd",
  );

  // #11 — back-pressure metrics
  const bpPausedTotalCounter = metrics?.counter(
    'declaragent.audit.backpressure.paused_total',
    'Number of times the audit-intake back-pressure gate has engaged',
  );
  const bpActiveGauge = metrics?.gauge(
    'declaragent.audit.backpressure.active',
    'Audit-intake back-pressure active (1=paused, 0=running)',
  );
  const bpDropCounter = metrics?.counter(
    'declaragent.audit.backpressure.drops_total',
    'Audit records dropped while back-pressure was active (drop policy)',
  );
  const bpBacklogMsGauge = metrics?.gauge(
    'declaragent.audit.backpressure.backlog_ms',
    'Age in ms of the oldest unshipped audit row (most recent evaluator sample)',
  );

  // #12 — adaptive batch metrics
  const batchIntervalGauge = metrics?.gauge(
    'declaragent.audit.batch.interval_ms',
    'Current exporter tick interval, in ms (adaptive when `batch` is configured)',
  );
  let batchRowsHist: Histogram | undefined;
  if (metrics) {
    batchRowsHist = metrics.histogram(
      'declaragent.audit.batch.rows',
      'Rows per audit export batch (0 = empty tick)',
      BATCH_ROW_BUCKETS,
    );
  }

  // Back-pressure wiring
  const bpOptions = backpressure?.enabled ? backpressure : undefined;
  const bpPauseAfterMs = bpOptions?.pauseAfterBacklogMs ?? DEFAULT_BP_PAUSE_AFTER_MS;
  const bpEvaluateMs = bpOptions?.evaluateIntervalMs ?? DEFAULT_BP_EVALUATE_MS;
  const bpController = bpOptions?.controller;
  if (bpController && metrics) {
    const labels = { exporter: exporter.name, vendor: exporter.vendor };
    bpController.bindMetrics({
      ...(bpActiveGauge && { pausedGauge: bpActiveGauge }),
      ...(bpPausedTotalCounter && { pausedTotalCounter: bpPausedTotalCounter }),
      ...(bpDropCounter && { dropCounter: bpDropCounter }),
      labels,
    });
  }

  // Adaptive batch wiring
  const batchEnabled = batch !== undefined;
  const batchMin = batch?.minIntervalMs ?? DEFAULT_BATCH_MIN_INTERVAL_MS;
  const batchMax = batch?.maxIntervalMs ?? DEFAULT_BATCH_MAX_INTERVAL_MS;
  const batchTarget = batch?.targetBatchRows ?? DEFAULT_BATCH_TARGET_ROWS;
  // Seed the adaptive cadence at the midpoint or the supplied fixed interval,
  // clamped. Matches operator intuition: "if I set intervalMs=5s, I expect
  // steady state to run near that".
  let currentInterval = batchEnabled
    ? Math.max(batchMin, Math.min(batchMax, intervalMs))
    : intervalMs;

  batchIntervalGauge?.set(currentInterval, {
    exporter: exporter.name,
    vendor: exporter.vendor,
  });

  let paused = false;
  let consecutiveFailures = 0;
  let nextTickBackoffMs = 0;
  let stopped = false;
  let ticking = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let bpTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void runTick();
    }, delayMs);
    // Don't keep the process alive just for the SIEM loop — if the
    // `up` daemon shuts down, the loop should not block exit.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  }

  function setPaused(next: boolean, reason?: string): void {
    paused = next;
    pausedGauge?.set(next ? 1 : 0, { exporter: exporter.name, vendor: exporter.vendor });
    if (next) {
      logger?.error('audit.export.paused', {
        exporter: exporter.name,
        vendor: exporter.vendor,
        consecutiveFailures,
        reason,
      });
    } else {
      logger?.info('audit.export.resumed', {
        exporter: exporter.name,
        vendor: exporter.vendor,
      });
    }
  }

  /**
   * Simple proportional controller for #12. We want the *next* batch
   * to land at `targetBatchRows`. The naive estimator is:
   *
   *   arrivalRatePerMs ≈ shipped / currentInterval
   *   nextInterval     ≈ targetRows / arrivalRatePerMs
   *                    = currentInterval * (targetRows / shipped)
   *
   * Clamped into [min, max]. `shipped === 0` skips adjustment (idle
   * queue) and `shipped === batchSize` implies the cap bit — pressure
   * was deeper than we could drain, so push hard toward `min`.
   */
  function adjustIntervalAfterTick(shipped: number): void {
    if (!batchEnabled) return;
    let next = currentInterval;
    if (shipped === 0) {
      // Idle queue → relax toward max.
      next = Math.min(batchMax, Math.max(batchMin, currentInterval * 2));
    } else if (shipped >= batchSize) {
      // Hit the batch cap → under-draining. Cut the interval hard.
      next = Math.max(batchMin, Math.floor(currentInterval / 2));
    } else {
      const ratio = batchTarget / shipped;
      next = Math.max(batchMin, Math.min(batchMax, Math.floor(currentInterval * ratio)));
    }
    if (next !== currentInterval) {
      currentInterval = next;
      batchIntervalGauge?.set(currentInterval, {
        exporter: exporter.name,
        vendor: exporter.vendor,
      });
    }
  }

  function effectiveTickInterval(): number {
    return batchEnabled ? currentInterval : intervalMs;
  }

  async function runTick(): Promise<number> {
    if (stopped || ticking) return 0;
    ticking = true;
    let acked = 0;
    try {
      if (paused) return 0;
      const cursor = await read(exporter.name);
      const sinceSeq = cursor?.lastSeq ?? 0;
      const stored = await sink.query({
        sinceSeq,
        order: 'asc',
        limit: batchSize,
      });
      // Record batch-size regardless of ack outcome — observability
      // should show the *attempt* size so bursts are visible even
      // when the vendor is throwing 5xx.
      batchRowsHist?.observe(stored.length, {
        exporter: exporter.name,
        vendor: exporter.vendor,
      });
      if (stored.length === 0) {
        // Nothing to push — reset any backoff so we come back on normal cadence.
        nextTickBackoffMs = 0;
        consecutiveFailures = 0;
        adjustIntervalAfterTick(0);
        return 0;
      }
      const entries = stored.map(toExportEntry);
      const result = await exporter.push(entries);
      if (result.ok) {
        acked = Math.min(result.acked, entries.length);
        if (acked > 0) {
          const nth = entries[acked - 1];
          if (nth) {
            await write(exporter.name, nth.seq);
            lastSeqGauge?.set(nth.seq, { exporter: exporter.name, vendor: exporter.vendor });
          }
          ackedCounter?.inc(acked, { exporter: exporter.name, vendor: exporter.vendor });
        }
        consecutiveFailures = 0;
        nextTickBackoffMs = 0;
        adjustIntervalAfterTick(acked);
        logger?.debug('audit.export.tick', {
          exporter: exporter.name,
          vendor: exporter.vendor,
          batchSize: entries.length,
          acked,
          firstSeq: entries[0]?.seq,
          lastSeq: entries[entries.length - 1]?.seq,
          intervalMs: currentInterval,
        });
      } else {
        failureCounter?.inc(1, {
          exporter: exporter.name,
          vendor: exporter.vendor,
          retryable: result.retryable ? 'true' : 'false',
        });
        consecutiveFailures += 1;
        logger?.warn('audit.export.push-failed', {
          exporter: exporter.name,
          vendor: exporter.vendor,
          retryable: result.retryable,
          consecutiveFailures,
          // result.error is vendor-redacted already.
          error: result.error,
        });
        if (!result.retryable || consecutiveFailures >= maxConsecutiveFailures) {
          setPaused(true, result.error);
        } else {
          nextTickBackoffMs = Math.min(
            Math.max(initialBackoffMs, nextTickBackoffMs * 2),
            maxBackoffMs,
          );
        }
      }
    } catch (err) {
      // An exporter or sink throw is treated as a retryable failure;
      // loop pauses if it keeps happening.
      failureCounter?.inc(1, {
        exporter: exporter.name,
        vendor: exporter.vendor,
        retryable: 'exception',
      });
      consecutiveFailures += 1;
      logger?.error('audit.export.exception', {
        exporter: exporter.name,
        vendor: exporter.vendor,
        consecutiveFailures,
        error: err instanceof Error ? err.message : String(err),
      });
      if (consecutiveFailures >= maxConsecutiveFailures) {
        setPaused(true, err instanceof Error ? err.message : String(err));
      } else {
        nextTickBackoffMs = Math.min(
          Math.max(initialBackoffMs, nextTickBackoffMs * 2),
          maxBackoffMs,
        );
      }
    } finally {
      ticking = false;
      if (!stopped) {
        const base = effectiveTickInterval();
        const delay = paused ? base * 6 : nextTickBackoffMs > 0 ? nextTickBackoffMs : base;
        scheduleNext(delay);
      }
    }
    // `now` is part of the options signature for future clock-skew
    // handling; reference it here so dead-code elimination doesn't
    // drop the export.
    void now;
    return acked;
  }

  async function evaluateBackpressure(): Promise<number | null> {
    if (!bpController) return null;
    if (typeof sink.oldestUnshippedMs !== 'function') return null;
    let oldest: number | null;
    try {
      oldest = await sink.oldestUnshippedMs(exporter.name);
    } catch (err) {
      logger?.warn('audit.backpressure.evaluate-failed', {
        exporter: exporter.name,
        vendor: exporter.vendor,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (oldest === null) {
      // Queue is empty — unconditionally resume.
      bpBacklogMsGauge?.set(0, { exporter: exporter.name, vendor: exporter.vendor });
      if (bpController.isPaused()) bpController.setPaused(false);
      return null;
    }
    const backlogMs = Math.max(0, now() - oldest);
    bpBacklogMsGauge?.set(backlogMs, { exporter: exporter.name, vendor: exporter.vendor });
    if (backlogMs >= bpPauseAfterMs) {
      bpController.setPaused(true, backlogMs);
    } else {
      if (bpController.isPaused()) bpController.setPaused(false, backlogMs);
    }
    return backlogMs;
  }

  function scheduleBackpressureEvaluation(): void {
    if (stopped || !bpController) return;
    bpTimer = setTimeout(() => {
      bpTimer = null;
      void (async () => {
        await evaluateBackpressure();
        scheduleBackpressureEvaluation();
      })();
    }, bpEvaluateMs);
    if (typeof (bpTimer as { unref?: () => void }).unref === 'function') {
      (bpTimer as { unref: () => void }).unref();
    }
  }

  // Kick off the first tick on the normal cadence. A zero-delay would
  // front-load a blocking HTTP call into the `up` boot sequence; one
  // interval later gives the rest of the daemon time to bind cleanly.
  scheduleNext(effectiveTickInterval());
  // Start the back-pressure evaluator if configured.
  if (bpController) {
    scheduleBackpressureEvaluation();
  }

  return {
    isPaused: () => paused,
    resume: () => {
      consecutiveFailures = 0;
      nextTickBackoffMs = 0;
      setPaused(false);
      // Fire a tick immediately rather than waiting for the next interval.
      if (timer) clearTimeout(timer);
      scheduleNext(0);
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (bpTimer) {
        clearTimeout(bpTimer);
        bpTimer = null;
      }
      // Let the currently-running tick (if any) finish before returning.
      while (ticking) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    flushNow: async () => runTick(),
    evaluateBackpressureNow: async () => evaluateBackpressure(),
    currentIntervalMs: () => effectiveTickInterval(),
  };
}

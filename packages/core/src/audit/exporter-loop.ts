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
 * @since 0.6.x — Enterprise Production Plan §3 Item #10
 */

import type { PrometheusRegistry } from '../observability/prometheus.js';
import type { Logger } from '../types/logger.js';
import { toExportEntry } from './exporters/exporter.js';
import type { AuditExporter } from './exporters/exporter.js';
import type { TenantAuditSink } from './types.js';

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
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

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

  let paused = false;
  let consecutiveFailures = 0;
  let nextTickBackoffMs = 0;
  let stopped = false;
  let ticking = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
      if (stored.length === 0) {
        // Nothing to push — reset any backoff so we come back on normal cadence.
        nextTickBackoffMs = 0;
        consecutiveFailures = 0;
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
        logger?.debug('audit.export.tick', {
          exporter: exporter.name,
          vendor: exporter.vendor,
          batchSize: entries.length,
          acked,
          firstSeq: entries[0]?.seq,
          lastSeq: entries[entries.length - 1]?.seq,
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
        const delay = paused
          ? intervalMs * 6
          : nextTickBackoffMs > 0
            ? nextTickBackoffMs
            : intervalMs;
        scheduleNext(delay);
      }
    }
    // `now` is part of the options signature for future clock-skew
    // handling; reference it here so dead-code elimination doesn't
    // drop the export.
    void now;
    return acked;
  }

  // Kick off the first tick on the normal cadence. A zero-delay would
  // front-load a blocking HTTP call into the `up` boot sequence; 10s
  // later gives the rest of the daemon time to bind cleanly.
  scheduleNext(intervalMs);

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
      // Let the currently-running tick (if any) finish before returning.
      while (ticking) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    flushNow: async () => runTick(),
  };
}

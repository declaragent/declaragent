/**
 * SIEM audit back-pressure controller.
 *
 * Shared stateful handle used by the audit sink + the export loop to
 * coordinate a pause on NEW audit writes when the export backlog (oldest
 * unshipped row) grows beyond a configured threshold (default 1h).
 *
 * Why this exists
 * ---------------
 * Today the export loop drains continuously — fine at low volume, but a
 * sustained vendor outage (Splunk HEC down, Elastic cluster unreachable)
 * backs up audit rows in SQLite without bound. On a busy single-host
 * tenant that's tens of MB per hour; on a fleet host it can run the disk
 * out in a working day. Back-pressure closes the valve at the intake
 * side so the disk doesn't silently fill while Prometheus dashboards
 * quietly show `audit.export.paused=1`.
 *
 * Policy
 * ------
 * The failure mode when paused is **fail-fast** — `sink.record()` throws
 * an {@link AuditBackpressureError}. The alternative (drop-and-log) would
 * silently punch holes in the hash chain, breaking `audit verify`. A
 * caller that genuinely prefers drop-on-backlog wraps the `record()`
 * call in its own try/catch and swallows the typed error. A dedicated
 * `drop` policy mode is also supported for callers wiring this
 * declaratively — it counts the drop via the provided metric and swallows
 * the error without throwing. Pick per deployment via
 * `CreateBackpressureControllerOptions.policy`; default `'fail-fast'`.
 *
 * Back-compat
 * -----------
 * The controller is opt-in on both {@link createSqliteAuditSink} and
 * {@link startAuditExportLoop}. When omitted, `record()` never throws
 * back-pressure errors + the export loop runs with its pre-0.7.4
 * cadence.
 *
 * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #11
 */

import type { Counter, Gauge } from '../events/types.js';
import type { Logger } from '../types/logger.js';

export type BackpressurePolicy = 'fail-fast' | 'drop';

export interface CreateBackpressureControllerOptions {
  /**
   * Failure mode when paused:
   *   - `'fail-fast'` (default): `sink.record()` throws
   *     {@link AuditBackpressureError}. Callers decide whether to log
   *     and swallow, or surface the failure upstream (recommended for
   *     tool-call audit, where silent drops break verify).
   *   - `'drop'`: `sink.record()` silently returns without persisting.
   *     Each drop increments the configured counter (when supplied) and
   *     logs a warning. Pick this for high-cardinality non-critical
   *     records where dropping is cheaper than back-pressuring the
   *     hot path.
   */
  policy?: BackpressurePolicy;
  /** Optional logger for state-transition messages. */
  logger?: Logger;
}

export interface BackpressureController {
  /** True while new writes should be rejected. */
  isPaused(): boolean;
  /** Effective policy (honoured by the sink when paused). */
  policy(): BackpressurePolicy;
  /**
   * Inspect the most recent state. `reasonMs` is the backlog age the
   * controller observed at the last transition (oldest unshipped row's
   * age, in ms) — `undefined` before the first evaluation.
   */
  state(): { paused: boolean; reasonMs?: number };
  /**
   * Flip the pause state. The loop evaluator calls this; application
   * code should not. `reasonMs` is the observed backlog age in ms. A
   * redundant call (same state) is a no-op.
   */
  setPaused(next: boolean, reasonMs?: number): void;
  /**
   * Register observability sinks. Called by the export loop once it has
   * a metrics registry in hand. Subsequent state transitions fire into
   * these. Idempotent.
   */
  bindMetrics(bindings: {
    pausedGauge?: Gauge;
    pausedTotalCounter?: Counter;
    dropCounter?: Counter;
    labels?: Readonly<Record<string, string>>;
  }): void;
  /**
   * Increment the drop counter. Called by the sink when running in
   * `'drop'` policy. No-op if no counter was bound.
   */
  recordDrop(): void;
}

/**
 * Thrown by {@link TenantAuditSink.record} when a back-pressure
 * controller is attached, paused, and the policy is `'fail-fast'`.
 * Typed so callers can `instanceof`-match without string-sniffing.
 */
export class AuditBackpressureError extends Error {
  readonly code = 'AUDIT_BACKPRESSURE' as const;
  readonly backlogMs?: number;
  constructor(message: string, backlogMs?: number) {
    super(message);
    this.name = 'AuditBackpressureError';
    if (backlogMs !== undefined) this.backlogMs = backlogMs;
  }
}

export function createBackpressureController(
  options: CreateBackpressureControllerOptions = {},
): BackpressureController {
  const policyValue: BackpressurePolicy = options.policy ?? 'fail-fast';
  const logger = options.logger;

  let paused = false;
  let reasonMs: number | undefined;
  let pausedGauge: Gauge | undefined;
  let pausedTotalCounter: Counter | undefined;
  let dropCounter: Counter | undefined;
  let metricLabels: Readonly<Record<string, string>> = {};

  return {
    isPaused: () => paused,
    policy: () => policyValue,
    state: () => (reasonMs === undefined ? { paused } : { paused, reasonMs }),
    setPaused(next, nextReasonMs) {
      if (next === paused) {
        // Track latest reason even on redundant calls so the gauge
        // reflects fresh backlog numbers on a sustained pause.
        if (next && nextReasonMs !== undefined) reasonMs = nextReasonMs;
        return;
      }
      paused = next;
      if (nextReasonMs !== undefined) reasonMs = nextReasonMs;
      pausedGauge?.set(next ? 1 : 0, metricLabels);
      if (next) {
        pausedTotalCounter?.inc(1, metricLabels);
        logger?.warn('audit.backpressure.paused', {
          policy: policyValue,
          backlogMs: reasonMs,
        });
      } else {
        logger?.info('audit.backpressure.resumed', {
          policy: policyValue,
          lastBacklogMs: reasonMs,
        });
        reasonMs = undefined;
      }
    },
    bindMetrics({ pausedGauge: pg, pausedTotalCounter: pc, dropCounter: dc, labels = {} }) {
      pausedGauge = pg;
      pausedTotalCounter = pc;
      dropCounter = dc;
      metricLabels = labels;
      // Prime the gauge so scrapers see `0` before the first transition.
      pg?.set(paused ? 1 : 0, metricLabels);
    },
    recordDrop() {
      dropCounter?.inc(1, metricLabels);
    },
  };
}

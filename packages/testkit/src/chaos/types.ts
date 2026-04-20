/**
 * Phase 6 slice-7 chaos harness types.
 *
 * Public contract for the chaos driver + fault + assertion library.
 * Kept separate from `driver.ts` so fault implementations can import
 * the types without a driver-runtime cycle.
 */

import type { Logger, MetricRecord, StoredAuditEntry } from '@declaragent/core';

// ── Fault kinds ──────────────────────────────────────────────────────────

export type ChaosFault =
  | { kind: 'kill-replica'; replicaId: string }
  | { kind: 'partition-broker'; broker: string; durationMs: number }
  | { kind: 'partition-channel'; channelId: string; durationMs: number }
  | { kind: 'bus-high-watermark'; excessFactor: number; durationMs: number }
  | { kind: 'expire-idempotency-cache' }
  | { kind: 'clock-skew'; offsetMs: number; durationMs: number }
  | { kind: 'network-latency'; target: string; extraMs: number; durationMs: number };

export type ChaosFaultKind = ChaosFault['kind'];

// ── Policy ───────────────────────────────────────────────────────────────

export interface ChaosPolicy {
  /** How often to tick the scheduler. */
  readonly intervalMs: number;
  /** Probability 0-1 that a tick fires a fault. */
  readonly probability: number;
  /** Eligible faults; a random entry is chosen on each firing. */
  readonly faults: readonly ChaosFault[];
  /** Hard cap on faults fired. Undefined = run forever. */
  readonly budget?: number;
}

// ── Target runtime bridge ────────────────────────────────────────────────

/**
 * `ChaosTargetRuntime` is the surface the driver talks to when it
 * executes a fault. Unit tests pass a stub; integration tests bridge
 * to a live daemon + Redpanda via Docker Compose; production runs
 * bridge to Kubernetes pod-kill APIs.
 *
 * Every method is optional — a unit test only implements the ones its
 * scenario needs. A fault whose target surface is unimplemented is
 * skipped with a warning instead of throwing.
 */
export interface ChaosTargetRuntime {
  /** Log seam shared with the driver. */
  readonly logger?: Logger;
  /** Force a replica exit by id. */
  killReplica?(replicaId: string): Promise<void>;
  /**
   * Block network to/from `broker` for `durationMs`. Returns a promise
   * that resolves when the partition window ends.
   */
  partitionBroker?(broker: string, durationMs: number): Promise<void>;
  /** Same semantics, for a channel adapter. */
  partitionChannel?(channelId: string, durationMs: number): Promise<void>;
  /**
   * Publish dummy events to overwhelm the bus's inflight-publish
   * watermark. `excessFactor` is how far above the high-watermark the
   * driver pushes (1.5 = 50 % over the mark).
   */
  pressureBus?(excessFactor: number, durationMs: number): Promise<void>;
  /** Force-clear the dispatcher's idempotency cache. */
  expireIdempotencyCache?(): Promise<void>;
  /**
   * Shift the active logical clock by `offsetMs` for `durationMs`.
   * After the window, the clock returns to ambient.
   */
  clockSkew?(offsetMs: number, durationMs: number): Promise<void>;
  /** Inject extra latency on outbound traffic to `target`. */
  networkLatency?(target: string, extraMs: number, durationMs: number): Promise<void>;
}

// ── Driver events + report ───────────────────────────────────────────────

/**
 * Emitted on every fault-cycle milestone so tests (and the report
 * writer) can assemble a timeline without snapshotting the driver's
 * internal state.
 */
export type ChaosEvent =
  | { kind: 'started'; ts: number; policy: ChaosPolicy }
  | { kind: 'fault.fire'; ts: number; fault: ChaosFault; seq: number }
  | { kind: 'fault.complete'; ts: number; fault: ChaosFault; seq: number; durationMs: number }
  | { kind: 'fault.error'; ts: number; fault: ChaosFault; seq: number; error: { message: string } }
  | { kind: 'budget-exhausted'; ts: number; budget: number }
  | { kind: 'stopped'; ts: number };

export interface FaultTimelineEntry {
  seq: number;
  fault: ChaosFault;
  firedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: { message: string };
}

export interface ChaosReport {
  startedAt: number;
  stoppedAt: number;
  totalMs: number;
  policy: ChaosPolicy;
  timeline: readonly FaultTimelineEntry[];
  assertionResults?: readonly ChaosAssertionResult[];
}

// ── Driver public API ────────────────────────────────────────────────────

export interface ChaosDriver {
  /** Begin firing faults per the policy. */
  start(): Promise<void>;
  /** Stop + emit a summary report. */
  stop(): Promise<ChaosReport>;
  /** Fire a specific fault immediately (test-only). */
  inject(fault: ChaosFault): Promise<void>;
  /** Subscribe to fault + recovery events. */
  onEvent(handler: (evt: ChaosEvent) => void): () => void;
}

// ── Snapshot + assertions ────────────────────────────────────────────────

/**
 * Input handed to every {@link ChaosAssertion}. Captures the state that
 * the plan's §7.3 assertion library needs to answer "did the SLO hold
 * through this fault cycle?".
 */
export interface ChaosSnapshot {
  /** Tenant context; undefined = default tenant / non-partitioned run. */
  tenantId?: string;
  /** Metrics recorded since the last snapshot. */
  metrics: readonly MetricRecord[];
  /** Audit entries observed during the run (ordered by seq). */
  auditRecords: readonly StoredAuditEntry[];
  /** Current bus inflight depth at snapshot time. */
  busDepth: number;
  /** DLQ depths keyed on source id. */
  dlqDepths: Readonly<Record<string, number>>;
  /** Counters a fault implementation or driver may surface. */
  counters?: Readonly<Record<string, number>>;
}

export interface ChaosAssertionResult {
  name: string;
  ok: boolean;
  /** One-line summary, surfaced in the markdown report. */
  message: string;
  /** Optional structured detail (values, thresholds, offending entries). */
  details?: Readonly<Record<string, unknown>>;
}

export interface ChaosAssertion {
  readonly name: string;
  check(snapshot: ChaosSnapshot): Promise<ChaosAssertionResult> | ChaosAssertionResult;
}

import type { Logger } from '@declaragent/core';
import type {
  ChaosDriver,
  ChaosEvent,
  ChaosFault,
  ChaosPolicy,
  ChaosReport,
  ChaosTargetRuntime,
  FaultTimelineEntry,
} from './types.js';

/**
 * Phase 6 slice-7 chaos driver.
 *
 * Deterministic, policy-driven fault firing. The driver itself is
 * infrastructure-free — every actual fault (replica-kill, partition,
 * clock-skew, etc.) routes through {@link ChaosTargetRuntime}, so the
 * same driver runs against a Kubernetes cluster OR an in-process stub
 * for unit tests.
 *
 * Scheduling semantics:
 *   - On each `intervalMs` tick, the driver samples `Math.random()`
 *     against `policy.probability`. A hit chooses one fault from
 *     `policy.faults` uniformly at random and fires it.
 *   - `policy.budget` caps the total number of firings; exhausting it
 *     emits `budget-exhausted` + stops the scheduler.
 *   - `inject(fault)` bypasses the schedule and fires immediately —
 *     test-only, never counted against the budget.
 */

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

export interface CreateChaosDriverOptions {
  policy: ChaosPolicy;
  runtime: ChaosTargetRuntime;
  /** Clock seam. Default: `Date.now`. */
  clock?: () => number;
  /** Timer seam. Bun + Node return a Timer; tests pass a deterministic scheduler. */
  // biome-ignore lint/suspicious/noExplicitAny: interval handle type differs by runtime
  setInterval?: (fn: () => void, ms: number) => any;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  clearInterval?: (handle: any) => void;
  /** RNG seam (0 ≤ r < 1). Defaults to `Math.random`. */
  random?: () => number;
  logger?: Logger;
}

export function createChaosDriver(options: CreateChaosDriverOptions): ChaosDriver {
  const policy = options.policy;
  const clock = options.clock ?? Date.now;
  const random = options.random ?? Math.random;
  const logger = options.logger ?? options.runtime.logger ?? NOOP_LOGGER;
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;

  if (policy.intervalMs <= 0) {
    throw new Error('chaos driver: policy.intervalMs must be positive');
  }
  if (policy.probability < 0 || policy.probability > 1) {
    throw new Error('chaos driver: policy.probability must be in [0,1]');
  }
  if (policy.faults.length === 0) {
    throw new Error('chaos driver: policy.faults must have at least one entry');
  }

  const handlers = new Set<(evt: ChaosEvent) => void>();
  const timeline: FaultTimelineEntry[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: opaque timer handle
  let timerHandle: any = null;
  let seqCounter = 0;
  let startedAt = 0;
  let stopped = false;
  let budgetExhausted = false;

  function fire(evt: ChaosEvent): void {
    for (const h of handlers) {
      try {
        h(evt);
      } catch (err) {
        logger.warn('chaos.event.handler.error', {
          err: err instanceof Error ? err.message : String(err),
          kind: evt.kind,
        });
      }
    }
  }

  async function runFault(fault: ChaosFault): Promise<void> {
    const seq = seqCounter++;
    const firedAt = clock();
    const entry: FaultTimelineEntry = { seq, fault, firedAt };
    timeline.push(entry);
    fire({ kind: 'fault.fire', ts: firedAt, fault, seq });
    try {
      await dispatchFault(fault, options.runtime);
      const completedAt = clock();
      entry.completedAt = completedAt;
      entry.durationMs = completedAt - firedAt;
      fire({
        kind: 'fault.complete',
        ts: completedAt,
        fault,
        seq,
        durationMs: entry.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.error = { message };
      fire({
        kind: 'fault.error',
        ts: clock(),
        fault,
        seq,
        error: { message },
      });
    }
  }

  function maybeFireOnTick(): void {
    if (stopped) return;
    if (budgetExhausted) return;
    // `random()` returns [0, 1); a `<` check makes probability=0 a
    // guaranteed skip and probability=1 a guaranteed fire.
    if (random() >= policy.probability) return;
    const fault = policy.faults[Math.floor(random() * policy.faults.length)];
    if (!fault) return;
    // If the next firing would exceed budget, emit budget-exhausted.
    if (policy.budget !== undefined && seqCounter >= policy.budget) {
      budgetExhausted = true;
      fire({ kind: 'budget-exhausted', ts: clock(), budget: policy.budget });
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
      return;
    }
    // Fire and forget — the driver shouldn't block the tick loop on
    // a long-running fault (partition-broker, for example).
    void runFault(fault);
  }

  return {
    async start(): Promise<void> {
      if (timerHandle !== null) return;
      startedAt = clock();
      stopped = false;
      fire({ kind: 'started', ts: startedAt, policy });
      timerHandle = setTimer(() => {
        maybeFireOnTick();
      }, policy.intervalMs);
    },

    async stop(): Promise<ChaosReport> {
      stopped = true;
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
      // Drain any in-flight fault promises by waiting for their
      // timeline entries to fill in. Bounded wait to keep the test
      // suite snappy; long-running faults would defer to `durationMs`.
      const deadline = clock() + 5000;
      while (
        timeline.some((e) => e.completedAt === undefined && e.error === undefined) &&
        clock() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const stoppedAt = clock();
      fire({ kind: 'stopped', ts: stoppedAt });
      return {
        startedAt,
        stoppedAt,
        totalMs: stoppedAt - startedAt,
        policy,
        timeline: [...timeline],
      };
    },

    async inject(fault: ChaosFault): Promise<void> {
      await runFault(fault);
    },

    onEvent(handler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

async function dispatchFault(fault: ChaosFault, runtime: ChaosTargetRuntime): Promise<void> {
  switch (fault.kind) {
    case 'kill-replica': {
      if (!runtime.killReplica) {
        throw new Error('runtime.killReplica not implemented');
      }
      await runtime.killReplica(fault.replicaId);
      return;
    }
    case 'partition-broker': {
      if (!runtime.partitionBroker) {
        throw new Error('runtime.partitionBroker not implemented');
      }
      await runtime.partitionBroker(fault.broker, fault.durationMs);
      return;
    }
    case 'partition-channel': {
      if (!runtime.partitionChannel) {
        throw new Error('runtime.partitionChannel not implemented');
      }
      await runtime.partitionChannel(fault.channelId, fault.durationMs);
      return;
    }
    case 'bus-high-watermark': {
      if (!runtime.pressureBus) {
        throw new Error('runtime.pressureBus not implemented');
      }
      await runtime.pressureBus(fault.excessFactor, fault.durationMs);
      return;
    }
    case 'expire-idempotency-cache': {
      if (!runtime.expireIdempotencyCache) {
        throw new Error('runtime.expireIdempotencyCache not implemented');
      }
      await runtime.expireIdempotencyCache();
      return;
    }
    case 'clock-skew': {
      if (!runtime.clockSkew) {
        throw new Error('runtime.clockSkew not implemented');
      }
      await runtime.clockSkew(fault.offsetMs, fault.durationMs);
      return;
    }
    case 'network-latency': {
      if (!runtime.networkLatency) {
        throw new Error('runtime.networkLatency not implemented');
      }
      await runtime.networkLatency(fault.target, fault.extraMs, fault.durationMs);
      return;
    }
  }
}

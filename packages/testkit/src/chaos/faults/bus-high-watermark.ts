import type { AgentEvent, EventBus } from '@declaragent/core';
import type { ChaosTargetRuntime } from '../types.js';

/**
 * Phase 6 slice-7 `bus-high-watermark` fault.
 *
 * Publishes dummy events on the supplied bus until the inflight count
 * crosses `excessFactor * highWatermark`, holds the pressure for
 * `durationMs`, then stops producing.
 *
 * Bus adapters with `busPressure` wiring will auto-pause during the
 * pressure window and resume afterwards — that's the observable state
 * transition the `slos-held` assertion looks for.
 */

export interface BusHighWatermarkFaultOptions {
  bus: EventBus;
  highWatermark: number;
  /**
   * Hook called for every dummy event before publish so a test can
   * stamp the event with a tenant id / correlation id.
   */
  stamp?: (event: AgentEvent) => AgentEvent;
  /** Inter-publish gap in ms. Default 2ms — tight enough to ramp quickly. */
  spacingMs?: number;
  /** Injected clock. */
  now?: () => number;
}

export function createBusHighWatermarkFault(
  opts: BusHighWatermarkFaultOptions,
): Required<Pick<ChaosTargetRuntime, 'pressureBus'>> {
  const spacing = opts.spacingMs ?? 2;
  const now = opts.now ?? Date.now;

  async function pressureBus(excessFactor: number, durationMs: number): Promise<void> {
    const target = Math.ceil(opts.highWatermark * Math.max(1, excessFactor));
    const deadline = now() + durationMs;

    // Ramp up: publish until we cross the target, using dummy events.
    let seq = 0;
    while (now() < deadline) {
      while (opts.bus.inflightCount() < target && now() < deadline) {
        const dummy: AgentEvent = {
          id: `chaos-pressure-${seq++}`,
          kind: 'self.wakeup',
          source: { type: 'self', reason: 'wakeup' },
          target: { type: 'broadcast' },
          timestamp: now(),
          payload: { chaos: true },
          auth: { kind: 'internal' },
        };
        const stamped = opts.stamp ? opts.stamp(dummy) : dummy;
        // Fire-and-forget to keep inflight elevated.
        void opts.bus.publish(stamped).catch(() => {
          /* subscribers may reject — that's fine for pressure */
        });
      }
      await sleep(spacing);
    }
    // Let the inflight settle before returning so the caller sees the
    // post-fault state (same reason the plan has onLow watermark logic).
    await opts.bus.drained();
  }

  return { pressureBus };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

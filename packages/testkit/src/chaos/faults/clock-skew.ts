import type { ChaosTargetRuntime } from '../types.js';

/**
 * Phase 6 slice-7 `clock-skew` fault.
 *
 * Temporarily shifts a mutable clock's `now()` return value forward or
 * backward. Exercised against idempotency TTLs, rotation windows, and
 * audit-retention pruners — they should absorb the skew without data
 * loss.
 *
 * Callers pass an {@link AdjustableClock} whose `setOffset(ms)` they
 * own. The default testkit offers `createMutableClock` for
 * convenience; production deployments own the real adjustable clock.
 */

export interface AdjustableClock {
  /** Shift the clock by `offsetMs` (relative to its current offset). */
  setOffset(offsetMs: number): void;
  /** Return the current clock value. */
  now(): number;
}

export interface ClockSkewFaultOptions {
  clock: AdjustableClock;
}

export function createClockSkewFault(
  opts: ClockSkewFaultOptions,
): Required<Pick<ChaosTargetRuntime, 'clockSkew'>> {
  async function clockSkew(offsetMs: number, durationMs: number): Promise<void> {
    opts.clock.setOffset(offsetMs);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    } finally {
      opts.clock.setOffset(-offsetMs);
    }
  }
  return { clockSkew };
}

/**
 * In-memory adjustable clock. Use for unit + integration tests. The
 * offset stacks — calling `setOffset(100)` twice moves the clock
 * forward 200 ms total.
 */
export function createMutableClock(initial = Date.now()): AdjustableClock & {
  advance(ms: number): void;
} {
  let base = initial;
  let offset = 0;
  return {
    now(): number {
      return base + offset;
    },
    setOffset(delta: number): void {
      offset += delta;
    },
    /** Advance the base (independent of skew). Useful for time-travel tests. */
    advance(ms: number): void {
      base += ms;
    },
  };
}

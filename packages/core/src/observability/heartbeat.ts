/**
 * Daemon liveness heartbeat (WS7).
 *
 * Before this, the shipped alert pack referenced a `DaemonHeartbeatTimeout`
 * pager keyed on a metric NO code emitted — so "the agent stopped responding"
 * could never page. {@link startHeartbeat} registers a gauge holding the
 * Unix-epoch SECONDS of the last loop tick and refreshes it on an interval, so
 * an operator can alert on staleness:
 *
 *     time() - declaragent_daemon_heartbeat_timestamp_seconds > 60
 *
 * The gauge is set immediately (so a scrape right after boot is fresh) and then
 * every `intervalMs`. The returned stop fn clears the timer — call it on
 * graceful shutdown so a clean `down` doesn't look like a hang.
 */

import type { MetricsRegistry } from '../events/types.js';

export const DAEMON_HEARTBEAT_METRIC = 'declaragent.daemon.heartbeat_timestamp_seconds';

export interface HeartbeatHandle {
  /** Stop refreshing the gauge + clear the timer. Idempotent. */
  stop(): void;
}

export interface StartHeartbeatOptions {
  metrics: MetricsRegistry;
  /** Refresh cadence. Default 10s. */
  intervalMs?: number;
  /** Clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Optional labels (e.g. `{ host }`). */
  labels?: Readonly<Record<string, string>>;
  /**
   * Timer seams (tests). A neutral handle type avoids the Bun `Timer` vs Node
   * `Timeout` type mismatch — the handle is opaque; only the matching
   * `clearIntervalFn` interprets it.
   */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export function startHeartbeat(opts: StartHeartbeatOptions): HeartbeatHandle {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? 10_000;
  const setI: (cb: () => void, ms: number) => unknown =
    opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearI: (handle: unknown) => void =
    opts.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const gauge = opts.metrics.gauge(
    DAEMON_HEARTBEAT_METRIC,
    "Unix-epoch seconds of the daemon loop's last heartbeat; alert on staleness.",
  );

  const beat = () => gauge.set(Math.floor(now() / 1000), opts.labels);
  beat(); // fresh immediately
  const timer = setI(beat, intervalMs);
  // Don't keep the event loop alive solely for the heartbeat.
  (timer as { unref?: () => void }).unref?.();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearI(timer);
    },
  };
}

/**
 * `declaragent down` — graceful shutdown of the active `up` process.
 *
 * Reads the pid from `~/.declaragent/up.pid`, sends SIGTERM, waits up
 * to 5s for a clean exit (the up process's own signal handler stops
 * sources + clears state), and if the process is still alive
 * escalates to SIGKILL + cleans up stale files.
 *
 * No-op with a clear message when nothing is up. Idempotent:
 * re-running `down` right after a successful one prints the same
 * "nothing up" line rather than erroring.
 *
 * @since 0.4.1
 */

import { clearUpState, isAlive, reapStaleState } from './up-lifecycle.js';

export interface DownIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: DownIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface DownDeps {
  io?: DownIO;
  /**
   * Override the signal sender — tests pass a mock so they don't
   * actually kill test processes.
   */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Clock override for the shutdown timeout. */
  now?: () => number;
  /** Poll interval override (ms). Default 150. */
  pollIntervalMs?: number;
  /** Grace period before escalating to SIGKILL (ms). Default 5000. */
  graceMs?: number;
}

export async function down(deps: DownDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollIntervalMs ?? 150;
  const graceMs = deps.graceMs ?? 5000;

  const state = reapStaleState();
  if (state === null) {
    io.out('nothing up.\n');
    return 0;
  }

  io.out(
    `stopping pid ${state.pid} (${state.agents.length} agent${state.agents.length === 1 ? '' : 's'})…\n`,
  );

  try {
    kill(state.pid, 'SIGTERM');
  } catch {
    // Process already gone between reap + signal — treat as success.
    clearUpState();
    io.out('✓ down\n');
    return 0;
  }

  const deadline = now() + graceMs;
  while (now() < deadline) {
    if (!isAlive(state.pid)) {
      clearUpState();
      io.out('✓ down\n');
      return 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  io.err(`pid ${state.pid} didn't exit within ${graceMs}ms — sending SIGKILL\n`);
  try {
    kill(state.pid, 'SIGKILL');
  } catch {
    // already gone
  }
  clearUpState();
  io.out('✓ down (forced)\n');
  return 0;
}

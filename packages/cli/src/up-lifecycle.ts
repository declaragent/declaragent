/**
 * Shared lifecycle state for `declaragent up` / `down` / `ps` / `logs`.
 *
 * Docker-Compose-style model: one `up` process per host owns every
 * agent's sources + drives their engine turns. Its pid lands in
 * `~/.declaragent/up.pid`; a human-readable snapshot of what's bound
 * lives in `~/.declaragent/up-state.json`; per-agent event logs are
 * appended to `~/.declaragent/logs/<agent-id>.log` so `logs -f` can
 * tail them independently of the owning terminal.
 *
 * Detach model: in `-d` mode, the parent re-spawns itself with the
 * `--__detached` sentinel, passing the same manifest args; the child
 * writes its own pid + state and `unref()`s from the parent, which
 * exits cleanly. No double-fork — Node's `child_process.spawn` with
 * `detached: true` + stdio `'ignore'` is enough for a session leader
 * on macOS/Linux.
 *
 * @since 0.4.1
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  type WriteStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.js';

export const DETACHED_SENTINEL = '--__detached';

export interface UpSourceSummary {
  readonly type: string;
  readonly id: string;
  /** Human-readable one-liner: "webhook /webhook/pr", "cron '0 9 * * *'". */
  readonly summary: string;
}

export interface UpAgentSummary {
  readonly id: string;
  /** Absolute path to the agent directory. */
  readonly path: string;
  readonly sources: readonly UpSourceSummary[];
}

export interface UpState {
  readonly version: 1;
  readonly pid: number;
  /** ISO timestamp of the up-process's start. */
  readonly startedAt: string;
  /** Absolute path to the fleet.yaml or agent.yaml that drove this `up`. */
  readonly manifestPath: string;
  readonly agents: readonly UpAgentSummary[];
}

// ── Paths ───────────────────────────────────────────────────────────────

export function upPidPath(dir = configDir()): string {
  return join(dir, 'up.pid');
}

export function upStatePath(dir = configDir()): string {
  return join(dir, 'up-state.json');
}

export function upLogsDir(dir = configDir()): string {
  const target = join(dir, 'logs');
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  return target;
}

export function upLogPath(agentId: string, dir = configDir()): string {
  return join(upLogsDir(dir), `${sanitizeFileName(agentId)}.log`);
}

/**
 * Where a detached `up -d` child's stdout + stderr land. Before
 * 0.4.11 these were routed to /dev/null via `stdio: 'ignore'`, which
 * meant any crash during the child's startup (yaml validation,
 * port-in-use, auth missing) was completely invisible. Piping them
 * here keeps the detach contract (parent exits, child runs
 * unattached) while preserving the crash story — `declaragent logs`
 * can also tail this file when state hasn't been written yet.
 */
export function upStartupLogPath(dir = configDir()): string {
  return join(dir, 'up-startup.log');
}

// ── State R/W ───────────────────────────────────────────────────────────

export function readUpState(dir = configDir()): UpState | null {
  const path = upStatePath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpState>;
    if (parsed.version !== 1 || typeof parsed.pid !== 'number') return null;
    return parsed as UpState;
  } catch {
    return null;
  }
}

export function writeUpState(state: UpState, dir = configDir()): void {
  writeFileSync(upStatePath(dir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  writeFileSync(upPidPath(dir), `${state.pid}\n`, 'utf8');
}

export function clearUpState(dir = configDir()): void {
  rmSync(upStatePath(dir), { force: true });
  rmSync(upPidPath(dir), { force: true });
}

// ── Process liveness ────────────────────────────────────────────────────

/**
 * `kill(pid, 0)` signals "probe without delivering" — throws ESRCH
 * when no such process, EPERM if the process exists but we can't
 * signal it. Both mean "alive enough for our purposes"; anything else
 * (typically ESRCH) means "dead". Caller can treat EPERM as alive.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * Drop stale state when the pid file points at a no-longer-alive
 * process — common after a crash or a `kill -9`. Callers use this
 * before deciding whether to refuse a new `up` or to proceed.
 */
export function reapStaleState(dir = configDir()): UpState | null {
  const s = readUpState(dir);
  if (!s) return null;
  if (isAlive(s.pid)) return s;
  clearUpState(dir);
  return null;
}

// ── Per-agent log stream ────────────────────────────────────────────────

export interface AgentLogger {
  /** Append a structured JSON-line entry. */
  write(record: Record<string, unknown>): void;
  /** Flush + close the underlying file handle. */
  close(): void;
}

/**
 * Open (append-mode) a log file for `agentId`. All writes are
 * newline-delimited JSON — `declaragent logs` interleaves them by
 * the `ts` field across agents when tailing `*`.
 */
export function openAgentLog(agentId: string, dir = configDir()): AgentLogger {
  const path = upLogPath(agentId, dir);
  const stream: WriteStream = createWriteStream(path, { flags: 'a' });
  // Swallow async stream errors — fd-open races during shutdown (tmpdir
  // already rm'd, broken pipe, etc.) shouldn't tank `up` or the test
  // runner. Writes are guarded synchronously below.
  stream.on('error', () => {});
  let closed = false;
  return {
    write(record) {
      if (closed) return;
      const payload = { ts: new Date().toISOString(), agent: agentId, ...record };
      try {
        stream.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // A broken pipe during shutdown shouldn't take the up process
        // down — swallow and let the stream cleanup take over.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        stream.end();
      } catch {
        // already closed
      }
    },
  };
}

// ── Detach helper ───────────────────────────────────────────────────────

export interface DetachOptions {
  /** Absolute path to the CLI binary (argv[0] in production). */
  launcher: string;
  /** Args to forward (sans any `-d` / `--detach` flag). */
  args: readonly string[];
}

/**
 * Re-exec the CLI in a detached child process, passing the
 * `--__detached` sentinel so the child knows not to detach again
 * recursively. The parent `unref()`s so it can exit while the child
 * keeps running.
 *
 * Child stdout + stderr are appended to `up-startup.log` — previously
 * they were piped to /dev/null, which meant any crash during child
 * startup (yaml validation, port-in-use, auth missing) was invisible.
 *
 * Returns the child pid; the caller prints it and exits.
 */
export function detachSelf(options: DetachOptions): number {
  const logPath = upStartupLogPath();
  // Open the log once so stdout + stderr share the handle; append
  // mode keeps prior-run traces for debugging.
  const logFd = openSync(logPath, 'a');
  const child: ChildProcess = spawn(options.launcher, [...options.args, DETACHED_SENTINEL], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // A fresh env is fine — the child reads the same config dir via
    // HOME, and we don't rely on any parent-shell state.
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error('failed to spawn detached process');
  }
  return child.pid;
}

/**
 * Poll {@link readUpState} for up to `timeoutMs` waiting for the
 * detached child to write its state file. When the child crashes
 * mid-startup the state never lands — returns `null` in that case so
 * the parent can surface a tail of the startup log.
 */
export async function waitForUpState(
  options: { pid: number; timeoutMs?: number; pollIntervalMs?: number; dir?: string } = {
    pid: 0,
  },
): Promise<UpState | null> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollMs = options.pollIntervalMs ?? 120;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readUpState(options.dir);
    if (state && (options.pid === 0 || state.pid === options.pid)) return state;
    if (options.pid !== 0 && !isAlive(options.pid)) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

// ── Internals ───────────────────────────────────────────────────────────

function sanitizeFileName(id: string): string {
  // Agent ids are already `[a-z0-9][a-z0-9_-]*`, but be defensive for
  // fleet ids + anything the user could rename.
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

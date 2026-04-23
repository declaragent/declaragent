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
  renameSync,
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
  /**
   * CLI version that wrote this state file. Populated from
   * `CLI_VERSION` in `packages/cli/src/version.ts` at `up` boot time.
   *
   * Absent on state written by pre-0.7.2 daemons — `readUpState`
   * returns whatever is on disk, so consumers MUST treat this as
   * optional and fall back to `'dev'` (matches `buildUpStatusSnapshot`
   * before #44 was wired).
   *
   * See: docs/POST_ENTERPRISE_BACKLOG.md #44.
   *
   * @since 0.7.2
   */
  readonly cliVersion?: string;
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

export interface AgentLogRotateResult {
  /** Absolute path of the renamed (archived) log file. */
  readonly archivedPath: string;
  /** Absolute path of the freshly-opened active log file (unchanged). */
  readonly activePath: string;
}

export interface AgentLogger {
  /** Append a structured JSON-line entry. */
  write(record: Record<string, unknown>): void;
  /** Flush + close the underlying file handle. */
  close(): void;
  /**
   * In-process log rotation (Enterprise backlog #22). Closes the
   * current write stream cleanly, renames the active log to
   * `<agentId>-<ISO>.log` (colons squashed so the filename is
   * portable across filesystems), and opens a fresh append-mode
   * stream at the original `<agentId>.log` path.
   *
   * Writes issued concurrently during rotation are buffered and
   * flushed to the new stream once it's open — no record is dropped
   * provided the caller hasn't closed the logger.
   *
   * External rotation (logrotate rename+create) is already handled
   * via inode re-check in {@link followOne}; this verb covers the
   * daemon-owned case (size-bound / time-bound rotation driven by
   * the `up` process itself).
   *
   * Returns the archived + active paths so the caller can report /
   * hand the archive to a shipper.
   *
   * @since 0.7.2 — POST_ENTERPRISE_BACKLOG.md #22
   */
  rotate(): Promise<AgentLogRotateResult>;
}

/**
 * Build the archive path for a rotated log. Replaces `:` with `-`
 * so the filename is legal on Windows + simpler to grep.
 *
 * Exported for tests; callers should use {@link AgentLogger.rotate}.
 */
export function rotatedAgentLogPath(agentId: string, when: Date, dir = configDir()): string {
  const iso = when.toISOString().replace(/:/g, '-');
  return join(upLogsDir(dir), `${sanitizeFileName(agentId)}-${iso}.log`);
}

/**
 * Open (append-mode) a log file for `agentId`. All writes are
 * newline-delimited JSON — `declaragent logs` interleaves them by
 * the `ts` field across agents when tailing `*`.
 */
export function openAgentLog(agentId: string, dir = configDir()): AgentLogger {
  const path = upLogPath(agentId, dir);
  let stream: WriteStream = openStream(path);
  let closed = false;
  // Rotation state. While `rotating` is true, `write()` enqueues the
  // serialised payload onto `pending` instead of touching the active
  // stream; the rotate() routine drains it onto the new stream once
  // the rename has completed.
  let rotating = false;
  const pending: string[] = [];

  function openStream(target: string): WriteStream {
    const s = createWriteStream(target, { flags: 'a' });
    // Swallow async stream errors — fd-open races during shutdown (tmpdir
    // already rm'd, broken pipe, etc.) shouldn't tank `up` or the test
    // runner. Writes are guarded synchronously below.
    s.on('error', () => {});
    return s;
  }

  function writeLine(line: string): void {
    try {
      stream.write(line);
    } catch {
      // A broken pipe during shutdown shouldn't take the up process
      // down — swallow and let the stream cleanup take over.
    }
  }

  return {
    write(record) {
      if (closed) return;
      const payload = { ts: new Date().toISOString(), agent: agentId, ...record };
      const line = `${JSON.stringify(payload)}\n`;
      if (rotating) {
        // Buffer until rotate() drains us onto the new stream. Order is
        // preserved because we push in call-order.
        pending.push(line);
        return;
      }
      writeLine(line);
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
    async rotate() {
      if (closed) {
        throw new Error(`openAgentLog(${agentId}).rotate(): logger is already closed`);
      }
      if (rotating) {
        // Collapse concurrent rotate() calls: wait until the in-flight
        // one clears so callers don't race into a half-renamed state.
        while (rotating) {
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      rotating = true;
      try {
        const archivedPath = rotatedAgentLogPath(agentId, new Date(), dir);
        // Drain the current stream before rename. `end()` flushes + closes;
        // `finish` fires once the kernel has the bytes.
        const current = stream;
        await new Promise<void>((resolveEnd) => {
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            resolveEnd();
          };
          try {
            current.once('finish', done);
            current.once('close', done);
            current.once('error', done);
            current.end();
          } catch {
            // If end() throws synchronously the stream is effectively gone;
            // don't hang rotation on a destroyed fd.
            done();
          }
        });
        // Rename BEFORE opening the new stream so the active path is free.
        // Missing source (e.g. someone deleted the file) is tolerated —
        // the rename is best-effort; the new stream is the critical bit.
        try {
          renameSync(path, archivedPath);
        } catch {
          // Silently swallow — an absent file means rotate was a no-op
          // file-wise, and we still want to reopen below.
        }
        stream = openStream(path);
        // Wait for the new fd to open before we hand control back. The
        // first synchronous `.write()` can land before `'open'` fires on
        // Bun/Node — writes are buffered internally, but the on-disk
        // file doesn't exist until open. Tests (and external tailers
        // watching via inode) reasonably expect the file to be present
        // once rotate() resolves.
        if (!existsSync(path)) {
          await new Promise<void>((resolveOpen) => {
            let settled = false;
            const done = (): void => {
              if (settled) return;
              settled = true;
              resolveOpen();
            };
            stream.once('open', done);
            stream.once('error', done);
            // Defensive short timeout — never block rotate() on a stuck
            // open() syscall. 250ms matches the test-harness patience.
            setTimeout(done, 250);
          });
        }
        // Drain buffered writes onto the new stream in call-order.
        while (pending.length > 0) {
          const line = pending.shift();
          if (line !== undefined) writeLine(line);
        }
        return { archivedPath, activePath: path };
      } finally {
        rotating = false;
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

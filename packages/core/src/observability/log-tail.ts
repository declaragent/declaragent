/**
 * Log-tail — incremental reader for the per-agent JSON-lines log files
 * that `declaragent up` appends to under `~/.declaragent/logs/<agent>.log`.
 *
 * Ships as the file-watching substrate for `docs/CONTROL_PLANE_PLAN.md`
 * §9 PR 1.2 (`/logs` SSE endpoint). The SSE route (see
 * {@link ./logs-sse-route.js}) consumes the async-iterable this module
 * returns and re-frames each line as a `data: …\n\n` SSE frame.
 *
 * Design choices:
 *
 *   - **Watch strategy:** uses `fs.watch` as the primary signal and
 *     falls back to a 1s `fs.stat` poll. `fs.watch` is fast but
 *     notoriously uneven across platforms — on macOS it doesn't always
 *     emit on same-inode appends, and on some network file systems it
 *     never emits at all. The poll catches both. On most Linux
 *     workloads the watch fires first and the poll is a no-op.
 *   - **Offset tracking:** each path keeps the last byte offset we
 *     successfully read. On wakeup we `stat` the file and read
 *     `(size - offset)` bytes. Partial trailing lines (no `\n`) are
 *     stashed and prepended on the next read so we never emit a half
 *     line.
 *   - **Rotation:** we compare `stat.ino` across wake-ups. If the
 *     inode changes (typical for `mv X X.old && touch X`) OR the file
 *     shrinks below `offset` (truncation), we reset `offset = 0` and
 *     re-open. When `fs.watch` returns a `rename` event the next poll
 *     cycle sees the new inode and does the rotation dance cleanly.
 *   - **Back-pressure:** this module does not buffer unbounded
 *     numbers of lines. The async iterator yields lines one at a
 *     time and the consumer is responsible for its own queue
 *     policy. See the SSE route for the drop-when-1024-deep rule.
 *
 * @since 0.7.0-slice.1 (PR 1.2)
 */

import { promises as fsp } from 'node:fs';
import { type FSWatcher, watch as fsWatch } from 'node:fs';

/**
 * One line emitted by {@link createLogTailer}. `line` is the raw
 * text (newline stripped); the tailer does not parse JSON — callers
 * that want structured records parse it themselves.
 */
export interface LogTailLine {
  /** Stable identifier of the source agent. Derived from the path's basename without extension. */
  readonly agentId: string;
  /** Absolute path the line was read from (useful for debugging multiple files per agent). */
  readonly path: string;
  /** The log line, without its trailing `\n`. */
  readonly line: string;
}

export interface CreateLogTailerOptions {
  /**
   * Absolute paths to tail. Each path maps 1:1 to an agent — the
   * basename (minus the final extension) is used as the `agentId`.
   */
  readonly paths: readonly LogTailPath[];
  /**
   * When provided, the tailer starts at byte 0 rather than the
   * current EOF. Useful for `?since=` queries that want to replay
   * recent history before following. The ISO/ms timestamp itself is
   * NOT used to seek — the tailer just reads the whole file and
   * lets the consumer filter. Large files should rely on the
   * event-store `/events` endpoint for historical replay.
   */
  readonly fromStart?: boolean;
  /**
   * Override for the polling interval. Tests set this to 50ms so
   * they don't wait a second per assertion. Production uses 1s.
   */
  readonly pollIntervalMs?: number;
  /**
   * Testing-only seam — override `fs.watch`. Returning `null` forces
   * the tailer into poll-only mode, mirroring the fallback path we
   * hit on network FS where `fs.watch` throws `ENOSYS`.
   */
  readonly watchFactory?: (path: string, onEvent: () => void) => FSWatcher | null;
}

/**
 * Per-path config. `agentId` defaults to the basename minus the
 * final extension, but callers can override when a single agent
 * spreads across multiple files (e.g. rotated `.1.log`, `.2.log`).
 */
export interface LogTailPath {
  readonly path: string;
  readonly agentId?: string;
}

/**
 * Handle for a running tailer. `destroy()` must be awaited on
 * shutdown; leaking watchers is how macOS runs out of file
 * descriptors under sustained test churn.
 */
export interface LogTailer extends AsyncIterable<LogTailLine> {
  /** Stop watching + polling, close all file handles. Idempotent. */
  destroy(): Promise<void>;
  /** True if `destroy()` has been called. */
  readonly closed: boolean;
}

interface PathState {
  readonly path: string;
  readonly agentId: string;
  offset: number;
  inode: number | null;
  partial: string;
  watcher: FSWatcher | null;
  /**
   * True once we've observed the file as missing (ENOENT) at least
   * once. If the file then appears, we treat it as "freshly
   * created" and read from byte 0 rather than EOF — operators
   * expect newly-written log files to replay, not silently drop
   * their first lines.
   */
  sawMissing: boolean;
}

/**
 * Start tailing the given files. Returns an async-iterable that
 * yields one {@link LogTailLine} per newline-terminated record.
 *
 * Not a generator — the tailer needs a resolve-able `next()` queue
 * so `fs.watch` callbacks can wake a waiting consumer without
 * re-entering the generator machinery.
 *
 * @example
 * ```ts
 * const tailer = createLogTailer({ paths: [{ path: '/tmp/a.log' }] });
 * for await (const { line } of tailer) {
 *   console.log(line);
 *   if (shouldStop) break;
 * }
 * await tailer.destroy();
 * ```
 */
export function createLogTailer(opts: CreateLogTailerOptions): LogTailer {
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const fromStart = opts.fromStart ?? false;
  const makeWatcher = opts.watchFactory ?? defaultWatchFactory;

  const queue: LogTailLine[] = [];
  const waiters: Array<(result: IteratorResult<LogTailLine>) => void> = [];
  let closed = false;

  const states: PathState[] = opts.paths.map((p) => ({
    path: p.path,
    agentId: p.agentId ?? basenameWithoutExt(p.path),
    offset: 0,
    inode: null,
    partial: '',
    watcher: null,
    sawMissing: false,
  }));

  // ── Internal helpers ───────────────────────────────────────────

  function push(line: LogTailLine): void {
    const w = waiters.shift();
    if (w) {
      w({ value: line, done: false });
    } else {
      queue.push(line);
    }
  }

  function resolveAllDone(): void {
    while (waiters.length > 0) {
      const w = waiters.shift();
      w?.({ value: undefined as unknown as LogTailLine, done: true });
    }
  }

  async function readIncremental(state: PathState): Promise<void> {
    if (closed) return;
    let stat: { size: number; ino: number };
    try {
      const s = await fsp.stat(state.path);
      stat = { size: s.size, ino: s.ino };
    } catch (err) {
      // File not yet created — not an error; wait for the next cycle.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Reset offset so a future create is picked up from the
        // start, not stale-offset into the middle of a new file.
        state.offset = 0;
        state.inode = null;
        state.partial = '';
        state.sawMissing = true;
        return;
      }
      return;
    }

    // Initialize offset on first sighting. Three cases:
    //   1. `fromStart` set → always read from byte 0.
    //   2. File already existed when the tailer booted → jump to
    //      EOF so the caller sees only new lines (`tail -f`
    //      semantics).
    //   3. File didn't exist at boot and just appeared (we
    //      previously saw ENOENT) → read from byte 0 so the
    //      newly-written content is surfaced. Operators running
    //      `up` after a crash expect freshly-created log files to
    //      replay, not silently drop their first lines.
    if (state.inode === null) {
      state.inode = stat.ino;
      state.offset = fromStart || state.sawMissing ? 0 : stat.size;
      if (state.offset === stat.size) return;
    }

    // Rotation detection: inode changed OR file shrank below offset.
    if (stat.ino !== state.inode || stat.size < state.offset) {
      state.inode = stat.ino;
      state.offset = 0;
      state.partial = '';
    }

    if (stat.size === state.offset) return;

    const toRead = stat.size - state.offset;
    let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      handle = await fsp.open(state.path, 'r');
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, state.offset);
      state.offset += bytesRead;
      const text = state.partial + buf.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      // Last element is either the partial trailer (size > 0) or '' if
      // the chunk ended cleanly at a newline. Stash it either way.
      state.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (closed) return;
        push({ agentId: state.agentId, path: state.path, line });
      }
    } catch {
      // Transient read failures are swallowed — the next poll will
      // retry. Taking the tailer down on a flaky disk is worse than
      // dropping a line.
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // already closed
        }
      }
    }
  }

  async function wakeAll(): Promise<void> {
    if (closed) return;
    // Serialize reads per-state so an fs.watch burst doesn't stack
    // multiple readers on the same path (which would duplicate
    // lines because they'd both see the same offset).
    for (const state of states) {
      await readIncremental(state);
    }
  }

  function scheduleWatcher(state: PathState): void {
    if (closed) return;
    try {
      const w = makeWatcher(state.path, () => {
        void readIncremental(state);
      });
      state.watcher = w;
    } catch {
      // fs.watch can throw ENOENT on files that don't exist yet; the
      // polling loop will catch up once the file lands.
      state.watcher = null;
    }
  }

  // ── Boot ───────────────────────────────────────────────────────

  // Initial read catches up any pre-existing content when `fromStart`
  // is set, and syncs the offset to EOF otherwise.
  void wakeAll();
  for (const state of states) {
    scheduleWatcher(state);
  }

  const pollTimer = setInterval(() => {
    void wakeAll();
  }, pollIntervalMs);
  // Polling shouldn't keep the event loop alive on its own — the
  // consumer's for-await is the anchor.
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  // ── Async iterator wiring ──────────────────────────────────────

  const iterator: AsyncIterator<LogTailLine> = {
    next(): Promise<IteratorResult<LogTailLine>> {
      if (queue.length > 0) {
        const value = queue.shift() as LogTailLine;
        return Promise.resolve({ value, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined as unknown as LogTailLine, done: true });
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    return(): Promise<IteratorResult<LogTailLine>> {
      void destroy();
      return Promise.resolve({ value: undefined as unknown as LogTailLine, done: true });
    },
  };

  async function destroy(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    for (const state of states) {
      if (state.watcher) {
        try {
          state.watcher.close();
        } catch {
          // already closed
        }
        state.watcher = null;
      }
    }
    resolveAllDone();
  }

  const tailer: LogTailer = {
    [Symbol.asyncIterator](): AsyncIterator<LogTailLine> {
      return iterator;
    },
    destroy,
    get closed() {
      return closed;
    },
  };
  return tailer;
}

// ── Helpers ──────────────────────────────────────────────────────

function basenameWithoutExt(path: string): string {
  const slashIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const base = slashIdx === -1 ? path : path.slice(slashIdx + 1);
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return base; // keep ".hidden" intact
  return base.slice(0, dotIdx);
}

const defaultWatchFactory: NonNullable<CreateLogTailerOptions['watchFactory']> = (
  path,
  onEvent,
) => {
  try {
    const w = fsWatch(path, { persistent: false }, () => {
      try {
        onEvent();
      } catch {
        // swallow — downstream errors shouldn't kill the watcher
      }
    });
    // `fs.watch` emits 'error' when the file vanishes on Linux. We
    // quietly absorb it — the polling loop will re-bind on next
    // re-create.
    w.on('error', () => {
      try {
        w.close();
      } catch {
        // already closed
      }
    });
    return w;
  } catch {
    return null;
  }
};

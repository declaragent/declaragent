import { type FSWatcher, watch as chokidarWatch } from 'chokidar';
import { stampTenantId } from '../../tenancy/stamp.js';
import { assertEventTarget } from '../target-validate.js';
import type {
  AgentEvent,
  EventSourceAdapter,
  EventSourceInstance,
  EventTarget,
  SourceDependencies,
} from '../types.js';

// ── Public types ─────────────────────────────────────────────────────────

export type FileChangeKind = 'add' | 'change' | 'unlink';

export interface FileWatchTriggerConfig {
  id: string;
  /** Glob array. Each pattern is passed through to chokidar. */
  paths: readonly string[];
  /** Which change kinds to publish. Defaults to all three. */
  events?: readonly FileChangeKind[];
  /** Debounce window in ms. Default 250. */
  debounceMs?: number;
  /** Where the emitted event routes. */
  target: EventTarget;
}

/** Minimal chokidar-ish watcher surface. Real chokidar satisfies this. */
export interface FileWatcherLike {
  on(event: 'add', cb: (path: string, stats?: unknown) => void): unknown;
  on(event: 'change', cb: (path: string, stats?: unknown) => void): unknown;
  on(event: 'unlink', cb: (path: string) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  close(): Promise<void>;
}

export interface FileWatchAdapterOptions {
  /** Test override: bypass setTimeout. */
  setTimer?: (delayMs: number, fn: () => void) => () => void;
  /** Test override: bypass real chokidar. */
  watchFactory?(paths: readonly string[]): FileWatcherLike;
}

// ── Debouncer ────────────────────────────────────────────────────────────

interface PendingFire {
  cancel: () => void;
  change: FileChangeKind;
  stats?: unknown;
}

/**
 * Per-path debouncer. Coalesces rapid events on the same path into one
 * delivery after `debounceMs` of silence. Atomic-write rename-dance
 * typically lands as `change`→`change` within a few ms; this collapses
 * them. The latest change kind wins — so a `change`→`unlink` flurry
 * reports `unlink`.
 */
export class PerPathDebouncer {
  private readonly pending = new Map<string, PendingFire>();

  constructor(
    private readonly debounceMs: number,
    private readonly setTimer: (delayMs: number, fn: () => void) => () => void,
    private readonly onFire: (path: string, change: FileChangeKind, stats?: unknown) => void,
  ) {}

  observe(path: string, change: FileChangeKind, stats?: unknown): void {
    const existing = this.pending.get(path);
    if (existing) existing.cancel();
    const cancel = this.setTimer(this.debounceMs, () => {
      const entry = this.pending.get(path);
      if (!entry) return;
      this.pending.delete(path);
      this.onFire(path, entry.change, entry.stats);
    });
    this.pending.set(path, { cancel, change, stats });
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) entry.cancel();
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

// ── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_TIMER: NonNullable<FileWatchAdapterOptions['setTimer']> = (delayMs, fn) => {
  const t = setTimeout(fn, delayMs);
  return () => clearTimeout(t);
};

export const DEFAULT_DEBOUNCE_MS = 250;

// ── Config validation ───────────────────────────────────────────────────

const VALID_CHANGES = new Set<FileChangeKind>(['add', 'change', 'unlink']);

function assertTriggerConfig(config: unknown): asserts config is FileWatchTriggerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('file-watch trigger config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('file-watch trigger config requires non-empty "id"');
  }
  if (!Array.isArray(c.paths) || c.paths.length === 0) {
    throw new Error('file-watch trigger config requires non-empty "paths" array');
  }
  for (const p of c.paths) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new Error('file-watch trigger config "paths" entries must be non-empty strings');
    }
  }
  if (c.events !== undefined) {
    if (!Array.isArray(c.events)) {
      throw new Error('file-watch trigger config "events" must be an array');
    }
    for (const e of c.events) {
      if (typeof e !== 'string' || !VALID_CHANGES.has(e as FileChangeKind)) {
        throw new Error(
          `file-watch trigger config "events" entry must be one of add|change|unlink, got ${String(e)}`,
        );
      }
    }
  }
  if (c.debounceMs !== undefined) {
    if (typeof c.debounceMs !== 'number' || c.debounceMs < 0) {
      throw new Error('file-watch trigger config "debounceMs" must be a non-negative number');
    }
  }
  assertEventTarget(c.target, 'file-watch');
}

// ── Glob → regex (minimal) ───────────────────────────────────────────────
// Chokidar v4+ dropped native glob support; callers pass directory paths
// and filter in event handlers. We support the common glob subset:
// `**` (any sequence of path segments), `*` (non-slash), and `?` (one char).
// Not supported: brace expansion `{a,b}`, character classes `[abc]`, or
// negation `!…`. Add picomatch if those become needed.

export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c !== undefined && '.+^$(){}|\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

/** Longest prefix of `glob` that contains no glob magic characters. */
export function extractWatchRoot(glob: string): string {
  const idx = glob.search(/[*?[\]{}!]/);
  if (idx === -1) return glob;
  const prefix = glob.slice(0, idx);
  const lastSlash = prefix.lastIndexOf('/');
  return lastSlash === -1 ? '.' : prefix.slice(0, lastSlash);
}

// ── Default chokidar factory ─────────────────────────────────────────────

function defaultWatchFactory(paths: readonly string[]): FileWatcherLike {
  // Compute dedup'd watch roots from the configured glob patterns, then
  // compile matchers for the glob patterns themselves. Emitted paths are
  // filtered against the matchers — chokidar delivers everything under
  // the root.
  const roots = Array.from(new Set(paths.map(extractWatchRoot)));
  const matchers = paths.map((p) => globToRegExp(p));

  const watcher: FSWatcher = chokidarWatch(roots, {
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    persistent: true,
  });

  function pathMatches(p: string): boolean {
    return matchers.some((re) => re.test(p));
  }

  return {
    on(event, cb) {
      if (event === 'error') {
        watcher.on('error', ((err: unknown) => {
          (cb as (e: Error) => void)(err instanceof Error ? err : new Error(String(err)));
        }) as (err: unknown) => void);
        return undefined;
      }
      watcher.on(
        event as 'add' | 'change' | 'unlink',
        ((path: string, stats?: unknown) => {
          if (!pathMatches(path)) return;
          (cb as (p: string, s?: unknown) => void)(path, stats);
        }) as (...args: unknown[]) => void,
      );
      return undefined;
    },
    async close() {
      await watcher.close();
    },
  };
}

// ── Adapter factory ──────────────────────────────────────────────────────

export function createFileWatchAdapter(
  opts: FileWatchAdapterOptions = {},
): EventSourceAdapter<FileWatchTriggerConfig> {
  const setTimer = opts.setTimer ?? DEFAULT_TIMER;
  const watchFactory = opts.watchFactory ?? defaultWatchFactory;

  return {
    type: 'file-watch',
    validateConfig(config: unknown): asserts config is FileWatchTriggerConfig {
      assertTriggerConfig(config);
    },
    async create(
      config: FileWatchTriggerConfig,
      deps: SourceDependencies,
    ): Promise<EventSourceInstance> {
      const allowedChanges = new Set<FileChangeKind>(config.events ?? ['add', 'change', 'unlink']);
      const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;

      let watcher: FileWatcherLike | null = null;
      let started = false;
      let stopped = false;
      let paused = false;
      let eventsPublished = 0;
      let lastEventAt: number | null = null;

      async function publish(path: string, change: FileChangeKind, stats?: unknown): Promise<void> {
        if (paused || stopped) return;
        if (!allowedChanges.has(change)) return;
        const now = Date.now();
        const event: AgentEvent<{ path: string; change: FileChangeKind; stats?: unknown }> = {
          id: crypto.randomUUID(),
          kind: 'file.changed',
          source: {
            type: 'file-watch',
            path,
            change: change === 'unlink' ? 'delete' : change === 'add' ? 'add' : 'modify',
          },
          target: config.target,
          timestamp: now,
          payload: stats !== undefined ? { path, change, stats } : { path, change },
          auth: { kind: 'trigger', triggerId: config.id },
        };
        try {
          await deps.bus.publish(stampTenantId(event, deps.tenant));
          eventsPublished += 1;
          lastEventAt = now;
        } catch (err) {
          deps.logger.warn('file-watch.publish.error', {
            triggerId: config.id,
            path,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const debouncer = new PerPathDebouncer(debounceMs, setTimer, (path, change, stats) => {
        void publish(path, change, stats);
      });

      return {
        id: config.id,
        type: 'file-watch',
        async start() {
          if (started) return;
          started = true;
          stopped = false;

          watcher = watchFactory(config.paths);
          watcher.on('add', (path, stats) => debouncer.observe(path, 'add', stats));
          watcher.on('change', (path, stats) => debouncer.observe(path, 'change', stats));
          watcher.on('unlink', (path) => debouncer.observe(path, 'unlink'));
          watcher.on('error', (err) => {
            deps.logger.error('file-watch.error', {
              triggerId: config.id,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        },
        async stop() {
          if (!started) return;
          stopped = true;
          started = false;
          debouncer.cancelAll();
          const w = watcher;
          watcher = null;
          if (w) await w.close();
        },
        async pause() {
          paused = true;
        },
        async resume() {
          paused = false;
        },
        async health() {
          if (!started) return { status: 'degraded', details: stopped ? 'stopped' : 'not-started' };
          if (paused) return { status: 'degraded', details: 'paused' };
          return { status: 'ok' };
        },
        metrics() {
          return { eventsPublished, lastEventAt };
        },
      };
    },
  };
}

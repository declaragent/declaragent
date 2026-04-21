/**
 * In-process event-source lifecycle for `declaragent run <dir>`.
 *
 * **What this unlocks (PR #2 of USABILITY_PLAN.md Phase A.1):**
 * scaffolded agents with `event-sources.yaml` — webhook listeners,
 * cron timers, file-watchers — now actually bind + fire in the same
 * process the REPL runs in. Before 0.3.5 the yaml was on disk but
 * nothing ever read it outside the long-horizon daemon path.
 *
 * **Scope for PR #2:**
 *   - webhook / cron / file-watch adapters start in-process
 *   - events land in the session event store (visible via
 *     `declaragent events list`)
 *   - clean stop when the REPL exits
 *
 * **Not in scope (tracked for PR #3):**
 *   - Routing `target: { kind: 'skill' }` through the full event
 *     dispatcher so the model auto-reacts to events. Today the
 *     agent's skills are only invoked when the user prompts them
 *     conversationally in the REPL.
 *   - kafka / nats / sqs / amqp / mqtt — those adapters live in
 *     separate npm packages and need external brokers, so they're
 *     a separate install + config story.
 *
 * @since 0.3.5
 */

import { Database } from 'bun:sqlite';
import {
  type AgentEvent,
  type ConfiguredSource,
  type EventBus,
  type EventSourceAdapter,
  type EventSourceInstance,
  type EventStore,
  type Logger,
  createCronAdapter,
  createEventBus,
  createEventStore,
  createFileWatchAdapter,
  createWebhookAdapter,
  validateEventSourcesConfig,
} from '@declaragent/core';
import { configDir, sessionsDbPath } from './paths.js';

/** Source types we can bind in-process without an external broker. */
const IN_PROCESS_TYPES = ['webhook', 'cron', 'file-watch'] as const;
type InProcessType = (typeof IN_PROCESS_TYPES)[number];

/**
 * Adapter map used both for yaml validation and for instance creation.
 * Source adapters in external packages (kafka, nats, etc.) are
 * deliberately not included here — they surface as "unknown type"
 * warnings without failing the load.
 */
function builtinAdapters(): Record<InProcessType, EventSourceAdapter<unknown>> {
  return {
    webhook: createWebhookAdapter() as EventSourceAdapter<unknown>,
    cron: createCronAdapter() as EventSourceAdapter<unknown>,
    'file-watch': createFileWatchAdapter() as EventSourceAdapter<unknown>,
  };
}

export interface StartAgentSourcesOptions {
  /**
   * Path to the agent's `event-sources.yaml` (or `.json`). When the
   * file is missing, `startAgentSources` returns a no-op lifecycle
   * with `sources: []` — callers can treat that as "skill-only mode".
   */
  configPath: string;
  logger?: Logger;
  /**
   * Optional per-event hook the REPL can use to surface activity
   * inline (phase-3). When unset (today) events only land in the
   * event store.
   */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Override the session-store path. Defaults to `sessionsDbPath()`.
   * Tests point this at a tmp file.
   */
  storePath?: string;
  /**
   * Whether to subscribe a "record every event" handler against the
   * event store. Default `true` for backwards compat (pre-0.4.15
   * callers assumed the events table would auto-fill). `declaragent
   * up` sets this `false` when it wires its own dispatcher — the
   * dispatcher owns recording via `handleInternal` step 2.5 and will
   * otherwise see its own just-recorded row as a duplicate, marking
   * every event as `outcome: duplicate`. @since 0.4.15
   */
  recordToStore?: boolean;
}

export interface StartAgentSourcesResult {
  readonly started: ReadonlyArray<{
    readonly type: string;
    readonly id: string;
    readonly summary: string;
  }>;
  /**
   * Live event bus the sources publish to. Exposed so callers
   * (`declaragent up`) can attach a dispatcher + engine + skill
   * registry that routes webhook/cron events into real agent turns.
   * Before this landed (0.4.11), events were recorded to the store
   * but sat as `outcome: pending` — nothing pulled them off for
   * dispatch. @since 0.4.11
   */
  readonly bus?: EventBus;
  /**
   * Event store the bus writes to. The dispatcher needs this to
   * `markOutcome` after a skill turn completes (moving events from
   * `pending` to `dispatched`). @since 0.4.11
   */
  readonly eventStore?: EventStore;
  readonly unknownTypes: readonly { readonly index: number; readonly type: string }[];
  readonly validationErrors: readonly {
    readonly index: number;
    readonly type: string;
    readonly message: string;
  }[];
  /** Graceful stop — calls `stop()` on every instance, closes the store. */
  stop(): Promise<void>;
}

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

/**
 * Parse + validate `event-sources.yaml`, spin up a bus + the
 * in-process adapters, and wire the bus to the session event store
 * so `declaragent events list` reflects live activity.
 *
 * Returns a lifecycle handle — call `.stop()` before exit.
 */
export async function startAgentSources(
  options: StartAgentSourcesOptions,
): Promise<StartAgentSourcesResult> {
  const logger = options.logger ?? NOOP_LOGGER;
  const adapters = builtinAdapters();
  const report = await validateEventSourcesConfig({
    path: options.configPath,
    adapters,
  });

  // Halt early on adapter-level validation failures — a broken
  // config would otherwise leave half-started sources.
  if (report.errors.length > 0) {
    throw new Error(
      `event-sources.yaml validation failed:\n${report.errors
        .map((e) => `  entry[${e.index}] type="${e.type}": ${e.message}`)
        .join('\n')}`,
    );
  }

  // DB + event store. One handle per REPL; closed on stop().
  const storePath = options.storePath ?? sessionsDbPath();
  const db = new Database(storePath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  const eventStore: EventStore = createEventStore({ db });

  const bus = createEventBus({ logger });

  // Subscribe once: every event is optionally persisted to the
  // event store + optionally forwarded to the REPL's `onEvent` hook.
  //
  // Why `recordToStore` is configurable: when `declaragent up` wires
  // its own dispatcher, the dispatcher records the event via
  // `handleInternal` step 2.5 and then checks `findDuplicate` for
  // dedup. If we ALSO pre-record here, the dispatcher finds the row
  // it just wrote (direct-id hit) and marks every event as
  // `outcome: duplicate`. Callers that own a dispatcher pass `false`.
  const recordToStore = options.recordToStore ?? true;
  const unsubscribe = bus.subscribe('*', async (event: AgentEvent) => {
    if (recordToStore) {
      try {
        await eventStore.record(event);
      } catch (err) {
        logger.warn('event-store.record-failed', { err: String(err) });
      }
    }
    if (options.onEvent) {
      try {
        options.onEvent(event);
      } catch {
        // Listener errors must not crash the bus; swallow.
      }
    }
  });

  const instances: EventSourceInstance[] = [];
  const started: Array<{ type: string; id: string; summary: string }> = [];

  for (const src of report.sources) {
    if (!isInProcessType(src.type)) {
      // External-broker adapter (kafka/nats/…). Skipped with a hint
      // that matches validateEventSourcesConfig's unknownTypes path.
      continue;
    }
    const adapter = adapters[src.type];
    try {
      const inst = await adapter.create(src.config, {
        bus,
        logger,
        configDir: configDir(),
      });
      await inst.start();
      instances.push(inst);
      started.push({
        type: src.type,
        id: inst.id,
        summary: summariseSource(src),
      });
    } catch (err) {
      logger.error('source.start-failed', {
        type: src.type,
        err: err instanceof Error ? err.message : String(err),
      });
      // Attempt cleanup of anything we did start before re-throwing,
      // so a partial start doesn't leak ports/watchers.
      for (const prior of instances) {
        try {
          await prior.stop('startup-abort');
        } catch {
          // swallow
        }
      }
      db.close();
      throw err;
    }
  }

  return {
    started,
    bus,
    eventStore,
    unknownTypes: report.unknownTypes,
    validationErrors: report.errors,
    stop: async () => {
      for (const inst of instances) {
        try {
          await inst.stop('repl-exit');
        } catch (err) {
          logger.warn('source.stop-failed', {
            type: inst.type,
            id: inst.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      unsubscribe();
      db.close();
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function isInProcessType(type: string): type is InProcessType {
  return (IN_PROCESS_TYPES as readonly string[]).includes(type);
}

/**
 * One-line human summary rendered in the REPL startup banner
 * ("webhook :7777/webhook/contracts", "cron 0 9 * * *",
 * "file-watch /tmp/inbox"). Inspect the config loosely — each
 * source type has a slightly different shape.
 */
function summariseSource(src: ConfiguredSource): string {
  const cfg = (src.config ?? {}) as Record<string, unknown>;
  switch (src.type) {
    case 'webhook': {
      const path = typeof cfg.path === 'string' ? cfg.path : `/webhook/${cfg.id ?? 'default'}`;
      return `webhook ${path}`;
    }
    case 'cron': {
      const schedule = typeof cfg.schedule === 'string' ? cfg.schedule : '?';
      return `cron "${schedule}"`;
    }
    case 'file-watch': {
      // The adapter's config uses `paths: string[]` (the canonical
      // field). Earlier drafts used `dir` / `path`; those fall back
      // for legacy configs. Fall back to the id when no path info is
      // present so `ps` never renders a raw `?`.
      if (Array.isArray(cfg.paths) && cfg.paths.length > 0) {
        const first = cfg.paths[0];
        const label = typeof first === 'string' ? first : '?';
        const extra = cfg.paths.length > 1 ? ` (+${cfg.paths.length - 1} more)` : '';
        return `file-watch ${label}${extra}`;
      }
      const watchDir =
        typeof cfg.dir === 'string'
          ? cfg.dir
          : typeof cfg.path === 'string'
            ? cfg.path
            : typeof cfg.id === 'string'
              ? cfg.id
              : '?';
      return `file-watch ${watchDir}`;
    }
    default:
      return src.type;
  }
}

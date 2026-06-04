import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import {
  type DispatchOutcome,
  type EventKind,
  type EventStore,
  type EventStoreListFilter,
  createEventStore,
} from '@declaragent/core';
import { connectDaemonClient } from './daemon-client.js';
import { daemonSocketPath, sessionsDbPath } from './paths.js';

export interface AdminCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: AdminCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/**
 * Deps handed to each command. Production wires real SQLite + the
 * on-disk socket path; tests inject in-memory fixtures.
 */
export interface EventsCliDeps {
  io?: AdminCliIO;
  /** Inject a store. When omitted, opens `sessionsDbPath()` read-only. */
  store?: EventStore;
  /** Daemon socket path. Defaults to `daemonSocketPath()`. */
  socketPath?: string;
}

function resolveStore(deps: EventsCliDeps): { store: EventStore; close(): void } {
  if (deps.store) {
    return { store: deps.store, close: () => {} };
  }
  const path = sessionsDbPath();
  const db = new Database(path, { create: true, readwrite: true });
  return {
    store: createEventStore({ db }),
    close() {
      db.close();
    },
  };
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

function formatOutcome(outcome: DispatchOutcome | undefined): string {
  if (!outcome) return 'pending';
  switch (outcome.kind) {
    case 'dispatched':
      return `dispatched→${outcome.sessionId}`;
    case 'broadcast':
      return 'broadcast';
    case 'queued':
      return `queued:${outcome.reason}`;
    case 'duplicate':
      return `duplicate@${new Date(outcome.firstSeenAt).toISOString()}`;
    case 'rejected':
      return `rejected:${outcome.reason}${outcome.details ? ` (${outcome.details})` : ''}`;
  }
}

export interface EventsListArgs {
  kind?: EventKind;
  last?: number;
  correlation?: string;
  outcome?: DispatchOutcome['kind'] | 'pending';
  /**
   * High-level convenience filter. Currently recognizes `'circuit-open'`
   * which matches `rejected` outcomes whose reason is `circuit-open` — the
   * states a Slice-3 circuit breaker emits when short-circuiting dispatch.
   * Combinable with `--kind` / `--correlation`; overrides `--outcome`.
   * @since 0.6.0-slice.3 (PR 3.2)
   */
  state?: 'circuit-open';
}

/** `declaragent events list [--kind <k>] [--last <n>] [--correlation <id>] [--outcome <k> | --state <s>]` */
export async function eventsList(args: EventsListArgs, deps: EventsCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const { store, close } = resolveStore(deps);
  try {
    const filter: EventStoreListFilter = {};
    if (args.kind !== undefined) filter.kind = args.kind;
    if (args.correlation !== undefined) filter.correlationId = args.correlation;
    if (args.state === 'circuit-open') {
      // The store only filters by outcome.kind; narrow to 'rejected' and
      // post-filter for `reason === 'circuit-open'` below.
      filter.outcomeKind = 'rejected';
    } else if (args.outcome !== undefined) {
      filter.outcomeKind = args.outcome;
    }
    if (args.last !== undefined) filter.limit = args.last;

    let rows = await store.list(filter);
    if (args.state === 'circuit-open') {
      rows = rows.filter(
        (r) => r.outcome?.kind === 'rejected' && r.outcome.reason === 'circuit-open',
      );
    }
    if (rows.length === 0) {
      io.out('no events.\n');
      return 0;
    }
    io.out(`events (${rows.length}):\n`);
    for (const r of rows) {
      const sourceId =
        'triggerId' in r.event.source && typeof r.event.source.triggerId === 'string'
          ? r.event.source.triggerId
          : r.event.source.type;
      io.out(
        `  ${formatTimestamp(r.event.timestamp)}  ${r.event.kind.padEnd(18)}  ${r.event.source.type}:${sourceId.padEnd(18)}  ${formatOutcome(r.outcome).padEnd(30)}  ${r.event.id}\n`,
      );
    }
    return 0;
  } finally {
    close();
  }
}

/** `declaragent events show <id>` */
export async function eventsShow(id: string, deps: EventsCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const { store, close } = resolveStore(deps);
  try {
    const record = await store.get(id);
    if (!record) {
      io.err(`✗ event "${id}" not found — list known ids with \`declaragent events list\`.\n`);
      return 1;
    }
    io.out(JSON.stringify(record, null, 2));
    io.out('\n');
    return 0;
  } finally {
    close();
  }
}

export interface EventsReplayRangeArgs {
  source: string;
  from: number;
  to?: number;
  limit?: number;
  filter?: string;
  /** Defaults to true. When false, replay counts events without dispatching. */
  dispatch?: boolean;
}

/**
 * `declaragent events replay-range --source <id> --from <ms> [--to <ms>] [--filter <expr>] [--limit <n>]`
 *
 * Calls the source's `replay()` method via the daemon, and (by default)
 * routes each replayed event back through the dispatcher with a fresh
 * id. Requires the adapter to implement `replay()` — currently Kafka
 * does; other adapters return a clear error.
 */
export async function eventsReplayRange(
  args: EventsReplayRangeArgs,
  deps: EventsCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const socketPath = deps.socketPath ?? daemonSocketPath();
  if (!existsSync(socketPath)) {
    io.err(`✗ daemon not running (no socket at ${socketPath})\n`);
    return 1;
  }
  const client = await connectDaemonClient(socketPath);
  try {
    const resp = await client.call({
      id: 'cli-events-replay-range',
      method: 'replay-range',
      params: {
        sourceId: args.source,
        fromMs: args.from,
        ...(args.to !== undefined && { toMs: args.to }),
        ...(args.limit !== undefined && { limit: args.limit }),
        ...(args.filter !== undefined && { filterExpr: args.filter }),
        dispatch: args.dispatch ?? true,
      },
    });
    if (resp.method !== 'replay-range') {
      io.err(
        `✗ unexpected response method "${resp.method}" (wanted "replay-range"). Restart the daemon with \`declaragent daemon\` and retry.\n`,
      );
      return 1;
    }
    if ('error' in resp) {
      io.err(`✗ replay-range failed: ${resp.error.message}\n`);
      return 1;
    }
    io.out(
      `replayed ${resp.result.replayed} event(s) from source "${args.source}" — dispatched ${resp.result.dispatched}.\n`,
    );
    for (const o of resp.result.outcomes) {
      io.out(`  ${o.eventId}  →  ${formatOutcome(o.outcome)}\n`);
    }
    return 0;
  } finally {
    client.close();
  }
}

/**
 * `declaragent events replay <id>` — re-publish a historic event through
 * the running daemon's dispatcher. Requires the daemon to be up since
 * the dispatcher lives there.
 */
export async function eventsReplay(id: string, deps: EventsCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const { store, close } = resolveStore(deps);
  try {
    const record = await store.get(id);
    if (!record) {
      io.err(`✗ event "${id}" not found — list known ids with \`declaragent events list\`.\n`);
      return 1;
    }
    const socketPath = deps.socketPath ?? daemonSocketPath();
    if (!existsSync(socketPath)) {
      io.err(`✗ daemon not running (no socket at ${socketPath})\n`);
      return 1;
    }
    const client = await connectDaemonClient(socketPath);
    try {
      // Stamp a fresh id so the dispatcher doesn't dedupe against the
      // stored copy. Preserve everything else.
      const replayEvent = { ...record.event, id: `replay:${crypto.randomUUID()}` };
      const resp = await client.call({
        id: 'cli-events-replay',
        method: 'send-event',
        params: { event: replayEvent },
      });
      if (resp.method !== 'send-event') {
        io.err(
          `✗ unexpected response method "${resp.method}" (wanted "send-event"). Restart the daemon with \`declaragent daemon\` and retry.\n`,
        );
        return 1;
      }
      if ('error' in resp) {
        io.err(`✗ replay failed: ${resp.error.message}\n`);
        return 1;
      }
      io.out(`replayed ${id} → ${formatOutcome(resp.result.outcome)}\n`);
      io.out(`new event id: ${replayEvent.id}\n`);
      return 0;
    } finally {
      client.close();
    }
  } finally {
    close();
  }
}

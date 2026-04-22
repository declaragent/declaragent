/**
 * Dispatch DLQ admin verbs — the read + acknowledge surface over the
 * `rejected_events` table shipped in Slice 5 / PR 5.1.
 *
 * Why a separate file from {@link dlq-cli.ts}: the existing `dlq-*`
 * verbs talk to the daemon via a control socket because source-level
 * DLQ state lives inside the adapter instance. The dispatch DLQ lives
 * in the shared SQLite file and is readable from any process — no
 * daemon required. Keeping the two file-scoped avoids mixing an IPC
 * client with a direct-SQLite read.
 *
 * Active requeue (`dlq requeue --kind dispatch <id>`) is DEFERRED to a
 * follow-up: it needs a control socket on the up-process so we can
 * publish the requeued event onto the live bus. For 0.6.0 we ship
 * `list` / `show` / `drop` (abandon) so operators can audit + prune
 * the DLQ between restarts.
 *
 * @since 0.6.0-slice.5 (PR 5.2)
 */

import { Database } from 'bun:sqlite';
import type { EventRejectionListFilter, EventStore } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { sessionsDbPath } from './paths.js';

export interface DispatchDlqIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: DispatchDlqIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface DispatchDlqDeps {
  io?: DispatchDlqIO;
  /** Inject a store. When omitted, opens `sessionsDbPath()` read-only-ish. */
  store?: EventStore;
}

function resolveStore(deps: DispatchDlqDeps): { store: EventStore; close(): void } {
  if (deps.store) return { store: deps.store, close: () => {} };
  const path = sessionsDbPath();
  const db = new Database(path, { create: true, readwrite: true });
  return {
    store: createEventStore({ db }),
    close() {
      db.close();
    },
  };
}

export interface DispatchDlqListArgs {
  /** `--reason <r>` — filter to a single rejection reason. */
  reason?: string;
  /** `--min-attempts <n>` — surface only poison-style entries. */
  minAttempts?: number;
  /** `--since <ms>` — only entries with `last_seen_ms >= ms`. */
  sinceMs?: number;
  /** `--limit <n>` — cap results. Default 200. */
  limit?: number;
}

/**
 * `declaragent dlq list --kind dispatch [--reason <r>] [--min-attempts <n>]
 *   [--since <ms>] [--limit <n>]`
 */
export async function dlqDispatchList(
  args: DispatchDlqListArgs,
  deps: DispatchDlqDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const { store, close } = resolveStore(deps);
  try {
    const filter: EventRejectionListFilter = {};
    if (args.reason !== undefined) filter.reason = args.reason;
    if (args.minAttempts !== undefined) filter.minAttempts = args.minAttempts;
    if (args.sinceMs !== undefined) filter.sinceMs = args.sinceMs;
    if (args.limit !== undefined) filter.limit = args.limit;

    const rows = await store.listRejections(filter);
    if (rows.length === 0) {
      io.out('dispatch DLQ is empty.\n');
      return 0;
    }
    io.out(`dispatch DLQ (${rows.length}):\n`);
    for (const r of rows) {
      const last = new Date(r.lastSeenMs).toISOString();
      const attempts = `×${r.attemptCount}`.padEnd(5);
      io.out(`  ${last}  ${attempts}  ${String(r.rejectionReason).padEnd(14)}  ${r.eventId}\n`);
    }
    return 0;
  } finally {
    close();
  }
}

/** `declaragent dlq show --kind dispatch <eventId>` */
export async function dlqDispatchShow(
  eventId: string,
  deps: DispatchDlqDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const { store, close } = resolveStore(deps);
  try {
    const rejection = await store.getRejection(eventId);
    if (!rejection) {
      io.err(`✗ no dispatch DLQ entry for "${eventId}"\n`);
      return 1;
    }
    const eventRec = await store.get(eventId);
    io.out(
      JSON.stringify(
        {
          rejection,
          event: eventRec?.event ?? null,
          lastOutcome: eventRec?.outcome ?? null,
        },
        null,
        2,
      ),
    );
    io.out('\n');
    return 0;
  } finally {
    close();
  }
}

/**
 * `declaragent dlq drop --kind dispatch <eventId>`
 *
 * Acknowledge / abandon — removes the DLQ ledger row without trying to
 * requeue. The event's outcome in the `events` table stays intact (the
 * rejection is still the historical truth); we just stop surfacing it
 * in `dlq list`. Useful when a deployment fix resolved the underlying
 * skill bug but the operator doesn't want to re-run the old event.
 */
export async function dlqDispatchDrop(
  eventId: string,
  deps: DispatchDlqDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const { store, close } = resolveStore(deps);
  try {
    const removed = await store.deleteRejection(eventId);
    if (!removed) {
      io.err(`✗ no dispatch DLQ entry for "${eventId}" — nothing to drop\n`);
      return 1;
    }
    io.out(`dropped dispatch DLQ entry for "${eventId}".\n`);
    return 0;
  } finally {
    close();
  }
}

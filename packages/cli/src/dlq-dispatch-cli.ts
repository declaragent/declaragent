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
 * `list` / `show` / `drop` operate directly on the SQLite store from
 * the CLI process — no running daemon required. `requeue` (Enterprise
 * Production Plan §3 item #3) is different: it has to re-publish onto
 * the live bus, which only exists inside the `up` daemon. The CLI
 * connects over the per-agent control socket bound by `up` and asks
 * it to perform the requeue.
 *
 * @since 0.6.0-slice.5 (PR 5.2); `requeue` added 0.6.x (EPP §3 #3).
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { EventRejectionListFilter, EventStore } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { resolveAgentControlSocketPath, withControlSocketClient } from './control-socket-client.js';
import { sessionsDbPath } from './paths.js';
import { readUpState } from './up-lifecycle.js';

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

// ── requeue ─────────────────────────────────────────────────────────────

/**
 * Exit codes surfaced by {@link dlqDispatchRequeue}. The CLI dispatcher
 * maps these to `process.exit(code)` so scripts can distinguish the
 * "already requeued / never rejected" path (idempotence) from a true
 * failure.
 *
 *   0 — requeue succeeded.
 *   1 — connection / daemon error (socket unreachable, bus missing, etc).
 *   2 — `dlq-miss`: no rejection row for this id (likely already requeued).
 *   3 — `event-miss`: row is in the DLQ but the original event body is
 *       gone (vacuumed). Operator can't recover this one from SQLite.
 *   4 — ambiguous target (multiple agents up, no `--agent` given).
 */
export type DlqDispatchRequeueExitCode = 0 | 1 | 2 | 3 | 4;

export interface DispatchDlqRequeueArgs {
  readonly eventId: string;
  /**
   * Agent id to target. Required when more than one agent is currently
   * up. When only one agent is up, the CLI picks it implicitly.
   */
  readonly agentId?: string;
  /**
   * Override the control socket path resolver. Tests inject this so
   * they can point the CLI at a socket bound inside a tmp HOME.
   */
  readonly resolveSocket?: (agentId: string) => string;
}

export interface DispatchDlqRequeueDeps {
  io?: DispatchDlqIO;
  /**
   * Override the up-state reader. Tests can inject a fixed set of
   * agents instead of depending on `~/.declaragent/up-state.json`.
   */
  readUpState?: typeof readUpState;
}

/**
 * `declaragent dlq requeue --kind dispatch <eventId> [--agent <id>]`
 *
 * Connects to the per-agent control socket bound by `declaragent up`
 * and sends a `dlq.requeue` op with the target event id. The `up`
 * daemon handles the actual re-publish + deleteRejection inside its
 * process — see `packages/core/src/events/dlq.ts#requeue`.
 *
 * Idempotence: the second call for the same id will hit the `dlq-miss`
 * branch because the first call already deleted the rejection row. We
 * surface that as exit code 2 (not 0) so automation can tell the
 * difference between a fresh requeue and a silent re-attempt.
 */
export async function dlqDispatchRequeue(
  args: DispatchDlqRequeueArgs,
  deps: DispatchDlqRequeueDeps = {},
): Promise<DlqDispatchRequeueExitCode> {
  const io = deps.io ?? STDIO_IO;
  const readState = deps.readUpState ?? readUpState;
  const resolveSocket = args.resolveSocket ?? ((id: string) => resolveAgentControlSocketPath(id));

  // Resolve which agent's socket to hit. Dispatch DLQ lives in the
  // shared SQLite store, but the live bus is per-agent — we need to
  // know which `up` instance owns it. Prefer an explicit `--agent`;
  // fall back to the only running agent when there's exactly one.
  let targetAgent: string;
  if (args.agentId !== undefined) {
    targetAgent = args.agentId;
  } else {
    const state = readState();
    const agents = state?.agents ?? [];
    if (agents.length === 0) {
      io.err(
        '✗ no agents are up — start one with `declaragent up` before requeuing a dispatch-DLQ event\n',
      );
      return 1;
    }
    if (agents.length > 1) {
      const names = agents.map((a) => a.id).join(', ');
      io.err(
        `✗ multiple agents are up (${names}); pass --agent <id> to pick which one requeues "${args.eventId}"\n`,
      );
      return 4;
    }
    // Exactly one agent up — safe to pick it implicitly.
    const only = agents[0];
    if (!only) {
      // Redundant for the type-checker given the length check above.
      io.err('✗ could not resolve target agent from up-state\n');
      return 1;
    }
    targetAgent = only.id;
  }

  const socketPath = resolveSocket(targetAgent);
  if (!existsSync(socketPath)) {
    io.err(
      `✗ control socket for agent "${targetAgent}" not found at ${socketPath} — is \`declaragent up\` running?\n`,
    );
    return 1;
  }

  // The requeue call distinguishes four exit codes (see the doc comment
  // above), so we can't fold this into the silent `tryFetchControlSocketStatus`
  // path. We use `withControlSocketClient` for the lifecycle (always-close)
  // and keep the rich response narrowing inline.
  try {
    return await withControlSocketClient(socketPath, { timeoutMs: 2000 }, async (client) => {
      const response = await client.call({
        id: `cli-dlq-requeue-${args.eventId}`,
        op: 'dlq.requeue',
        params: { eventId: args.eventId },
      });

      // The response is the discriminated union the core control socket
      // ships. Narrow by the op tag, then by whether an error or result
      // slot was populated.
      if (response.op !== 'dlq.requeue') {
        io.err(
          `✗ unexpected control-socket response op "${response.op}" for dlq.requeue — daemon version mismatch?\n`,
        );
        return 1 as DlqDispatchRequeueExitCode;
      }
      if ('error' in response) {
        // Transport-level / handler-level errors — e.g. ENOBUS when the
        // daemon was booted without a live bus wired.
        io.err(`✗ requeue failed: ${response.error.code} — ${response.error.message}\n`);
        return 1 as DlqDispatchRequeueExitCode;
      }
      const result = response.result;
      if (result.ok) {
        io.out(
          `✓ requeued "${result.eventId}" on agent "${targetAgent}" (attempts before requeue: ${result.attemptsBeforeRequeue})\n`,
        );
        return 0 as DlqDispatchRequeueExitCode;
      }
      // Typed-error branch: the daemon ran the helper, but the row was
      // either absent (idempotence) or half-deleted (event-miss).
      if (result.reason === 'dlq-miss') {
        io.err(`✗ ${result.message}\n`);
        return 2 as DlqDispatchRequeueExitCode;
      }
      if (result.reason === 'event-miss') {
        io.err(`✗ ${result.message}\n`);
        return 3 as DlqDispatchRequeueExitCode;
      }
      // Defensive: the RequeueRejectionReason union is a fixed pair today
      // but we keep the fall-through explicit so adding a reason can't
      // silently degrade to exit 1.
      io.err(`✗ requeue failed: ${result.message}\n`);
      return 1 as DlqDispatchRequeueExitCode;
    });
  } catch (err) {
    // `withControlSocketClient` surfaces connect errors unchanged; we
    // treat them all as "could not reach the daemon" (exit 1). The
    // earlier `existsSync(socketPath)` check catches the common case
    // of an unbound socket; this branch handles timeouts + mid-call
    // disconnects.
    io.err(
      `✗ could not connect to agent "${targetAgent}" control socket: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

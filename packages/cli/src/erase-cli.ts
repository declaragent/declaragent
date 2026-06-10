/**
 * WS8 — `declaragent erase --user <platformUserId>` GDPR right-to-erasure verb.
 *
 * Composes the per-store erasure paths over the daemon's actual SQLite handles:
 * the audit sink (`audit.db`, tombstoned — chain stays verifiable) + the event
 * store (`sessions.db`, hard-deleted). Reports per-store counts and exits 0 even
 * when nothing matched (erasure is idempotent — re-running a DSR is safe).
 *
 * Before this verb, the only erasure surface was `audit erase --user`, which
 * scrubbed audit records only; a subject's events had no deletion path. This
 * verb closes that by running `eraseSubject` across both stores.
 *
 * Store opening is injectable so the verb logic (arg parse → compose → report →
 * exit code) is unit-testable without touching disk.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { EventStore, TenantAuditSink } from '@declaragent/core';
import { createEventStore, createSqliteAuditSink, eraseSubject } from '@declaragent/core';
import { auditDbPath, sessionsDbPath } from './paths.js';

export interface EraseCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: EraseCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface EraseUserArgs {
  user?: string;
  reason?: string;
  json?: boolean;
}

export interface EraseCliDeps {
  io?: EraseCliIO;
  /** Audit DB path override; defaults to `${configDir}/audit.db`. */
  auditDbPath?: string;
  /** Events/sessions DB path override; defaults to `${configDir}/sessions.db`. */
  eventsDbPath?: string;
  /** Injected audit sink (tests). When set, the audit DB is not opened from disk. */
  auditSink?: TenantAuditSink;
  /** Injected event stores (tests). When set, the events DB is not opened from disk. */
  eventStores?: readonly EventStore[];
}

/** `declaragent erase --user <platformUserId> [--reason R] [--json]` */
export async function eraseUser(args: EraseUserArgs, deps: EraseCliDeps = {}): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  if (!args.user) {
    io.err('usage: declaragent erase --user <platformUserId> [--reason R] [--json]\n');
    return 1;
  }

  // Resolve the audit sink: injected, else open the on-disk audit.db when present.
  let auditSink = deps.auditSink;
  if (!auditSink) {
    const path = deps.auditDbPath ?? auditDbPath();
    if (existsSync(path)) {
      try {
        auditSink = await createSqliteAuditSink({ path });
      } catch (err) {
        io.err(`✗ failed to open audit database: ${err instanceof Error ? err.message : err}\n`);
        return 1;
      }
    }
  }

  // Resolve the event store: injected, else open the on-disk sessions.db when present.
  let eventStores = deps.eventStores;
  let openedDb: Database | undefined;
  if (!eventStores) {
    const path = deps.eventsDbPath ?? sessionsDbPath();
    if (existsSync(path)) {
      openedDb = new Database(path, { create: false });
      eventStores = [createEventStore({ db: openedDb })];
    } else {
      eventStores = [];
    }
  }

  try {
    const result = await eraseSubject(
      args.user,
      {
        ...(auditSink !== undefined && { auditSink }),
        eventStores,
      },
      { ...(args.reason !== undefined && { reason: args.reason }) },
    );

    if (args.json) {
      io.out(`${JSON.stringify({ platformUserId: args.user, ...result }, null, 2)}\n`);
    } else {
      io.out(
        `✓ erased subject "${args.user}": ${result.auditRecords} audit record${result.auditRecords === 1 ? '' : 's'} + ${result.events} event${result.events === 1 ? '' : 's'}\n`,
      );
    }
    return 0;
  } finally {
    openedDb?.close();
  }
}

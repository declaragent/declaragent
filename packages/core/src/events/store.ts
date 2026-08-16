import type { Database } from 'bun:sqlite';
import type { AgentEvent, DispatchOutcome, EventKind } from './types.js';

export interface EventStoreRecord {
  event: AgentEvent;
  recordedAt: number;
  outcome?: DispatchOutcome;
  outcomeAt?: number;
}

export interface EventStoreListFilter {
  kind?: EventKind;
  correlationId?: string;
  /** Only return events at or after this ms-epoch. */
  sinceMs?: number;
  /** Only return events whose outcome matches. `"pending"` → outcome is NULL. */
  outcomeKind?: DispatchOutcome['kind'] | 'pending';
  /** Max rows. Defaults to 200; pass a larger number for admin/export flows. */
  limit?: number;
}

/**
 * Dispatch-DLQ row (Slice 5 / PR 5.1). One row per event that the
 * dispatcher has rejected at least once. The full event body stays in
 * the `events` table — this overlay holds only requeue-ledger state.
 *
 * `attemptCount` starts at 1 on first rejection and increments each
 * time the dispatcher re-rejects a requeued copy. The poison threshold
 * lives in the CLI (not the store) so the admin tool can decide policy
 * without the store needing to know about it.
 */
export interface EventRejectionRecord {
  eventId: string;
  rejectionReason: DispatchOutcome extends { kind: 'rejected'; reason: infer R } ? R : string;
  /** Free-form details from the latest attempt's rejection outcome. */
  details?: string;
  attemptCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface EventRejectionListFilter {
  /** Filter by rejection reason (e.g. 'circuit-open', 'rate-limit'). */
  reason?: string;
  /** Only return rejections whose `lastSeenMs` is at or after this ms-epoch. */
  sinceMs?: number;
  /**
   * Require `attemptCount >= this`. Default 1 (all rejections). Pass a
   * higher value to surface "poison" events that have been requeued
   * repeatedly without success.
   */
  minAttempts?: number;
  /** Max rows. Defaults to 200. */
  limit?: number;
}

export interface EventStore {
  /** Insert a row for the event. Outcome defaults to NULL (in-flight). */
  record(event: AgentEvent): Promise<void>;
  /** Update `outcome` + `outcome_at` on the existing row. */
  markOutcome(id: string, outcome: DispatchOutcome): Promise<void>;
  /** Lookup by primary key. */
  get(id: string): Promise<EventStoreRecord | undefined>;
  /**
   * Return the earliest prior event that would make this one a duplicate:
   * (1) same id, or (2) same `(idempotencyKey, sourceType)` within `withinMs`.
   *
   * Returns `undefined` when no match exists.
   */
  findDuplicate(event: AgentEvent, withinMs: number): Promise<EventStoreRecord | undefined>;
  /** Filtered enumeration. Used by admin CLI (slice 11). */
  list(filter?: EventStoreListFilter): Promise<readonly EventStoreRecord[]>;
  /** Delete rows older than `olderThanMs` ago. Returns affected row count. */
  vacuum(olderThanMs?: number): Promise<number>;

  // ── Dispatch DLQ (Slice 5 / PR 5.1) ────────────────────────────────────

  /**
   * Record a dispatch rejection. First call for an event inserts a new
   * row with `attemptCount = 1`; subsequent calls upsert — bumping
   * `attemptCount` + `lastSeenMs` and updating the latest reason.
   *
   * The caller passes the outcome kind + optional details; the store
   * never interprets them beyond storing the strings.
   */
  upsertRejection(
    eventId: string,
    reason: string,
    details: string | undefined,
    nowMs?: number,
  ): Promise<void>;

  /** Single lookup. Returns `undefined` when the event was never rejected. */
  getRejection(eventId: string): Promise<EventRejectionRecord | undefined>;

  /** Filtered enumeration — powers `declaragent dlq list --kind dispatch`. */
  listRejections(filter?: EventRejectionListFilter): Promise<readonly EventRejectionRecord[]>;

  /**
   * Remove an event's rejection record. Called after a successful
   * requeue completes (dispatched outcome on the new copy) so the
   * DLQ reflects only events currently stuck. Returns true when a
   * row was deleted, false when no record existed.
   */
  deleteRejection(eventId: string): Promise<boolean>;

  /**
   * WS8 — GDPR right-to-erasure for EVENT rows. Hard-deletes every event whose
   * `meta.principal.platformUserId` matches `platformUserId` (plus any rejection
   * rows for those events), returning the count erased. Complements the audit
   * sink's `erasePlatformUser` (which tombstones audit records) and the session
   * store's erase — a full subject erasure composes all three. Returns 0 when
   * nothing matched. Hard delete (not tombstone): unlike the tamper-evident
   * audit chain, the event ledger has no hash chain to preserve.
   *
   * @since 0.7.6 — production-readiness WS8
   */
  eraseByPlatformUser(platformUserId: string): Promise<number>;
}

export interface CreateEventStoreOptions {
  db: Database;
  /** Default vacuum horizon. 30 days per §8 of PHASE_3_PLAN. */
  defaultRetentionMs?: number;
}

export const DEFAULT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const EVENT_STORE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_json TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_json TEXT NOT NULL,
    auth_kind TEXT NOT NULL,
    auth_json TEXT NOT NULL,
    payload_json TEXT,
    correlation_id TEXT,
    caused_by TEXT,
    idempotency_key TEXT,
    meta_json TEXT,
    ts INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    outcome TEXT,
    outcome_json TEXT,
    outcome_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_events_idempotency
    ON events(idempotency_key, source_type)
    WHERE idempotency_key IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_events_correlation
    ON events(correlation_id)
    WHERE correlation_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_events_ts
    ON events(ts);

  CREATE INDEX IF NOT EXISTS idx_events_kind
    ON events(kind);

  CREATE INDEX IF NOT EXISTS idx_events_outcome
    ON events(outcome);

  -- Slice 5 / PR 5.1 — dispatch DLQ overlay. Narrow on purpose: the
  -- full event body lives in \`events\`; this table just tracks retry
  -- ledger state so operators can enumerate rejected events and
  -- requeue them without scanning the much larger events table.
  CREATE TABLE IF NOT EXISTS rejected_events (
    event_id TEXT PRIMARY KEY,
    rejection_reason TEXT NOT NULL,
    details TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_rejected_events_reason
    ON rejected_events(rejection_reason);

  CREATE INDEX IF NOT EXISTS idx_rejected_events_last_seen
    ON rejected_events(last_seen_ms);
`;

interface EventRow {
  id: string;
  kind: string;
  source_type: string;
  source_json: string;
  target_type: string;
  target_json: string;
  auth_kind: string;
  auth_json: string;
  payload_json: string | null;
  correlation_id: string | null;
  caused_by: string | null;
  idempotency_key: string | null;
  meta_json: string | null;
  ts: number;
  recorded_at: number;
  outcome: string | null;
  outcome_json: string | null;
  outcome_at: number | null;
}

function rowToRecord(row: EventRow): EventStoreRecord {
  const event: AgentEvent = {
    id: row.id,
    kind: row.kind as AgentEvent['kind'],
    source: JSON.parse(row.source_json) as AgentEvent['source'],
    target: JSON.parse(row.target_json) as AgentEvent['target'],
    auth: JSON.parse(row.auth_json) as AgentEvent['auth'],
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    timestamp: row.ts,
  };
  if (row.meta_json) {
    const meta = JSON.parse(row.meta_json) as AgentEvent['meta'];
    if (meta !== undefined) event.meta = meta;
  }
  const record: EventStoreRecord = {
    event,
    recordedAt: row.recorded_at,
  };
  if (row.outcome_json) {
    record.outcome = JSON.parse(row.outcome_json) as DispatchOutcome;
  }
  if (row.outcome_at !== null) record.outcomeAt = row.outcome_at;
  return record;
}

export function createEventStore(options: CreateEventStoreOptions): EventStore {
  const { db } = options;
  const retentionMs = options.defaultRetentionMs ?? DEFAULT_EVENT_RETENTION_MS;

  db.exec(EVENT_STORE_SCHEMA);

  const insert = db.prepare(
    `INSERT INTO events (
      id, kind, source_type, source_json, target_type, target_json,
      auth_kind, auth_json, payload_json, correlation_id, caused_by,
      idempotency_key, meta_json, ts, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    'UPDATE events SET outcome = ?, outcome_json = ?, outcome_at = ? WHERE id = ?',
  );
  const getById = db.prepare<EventRow, [string]>('SELECT * FROM events WHERE id = ?');
  const findByKey = db.prepare<EventRow, [string, string, number]>(
    `SELECT * FROM events
       WHERE idempotency_key = ?
         AND source_type = ?
         AND ts >= ?
       ORDER BY ts ASC
       LIMIT 1`,
  );
  const vacuumStmt = db.prepare('DELETE FROM events WHERE ts < ?');

  // ── Dispatch-DLQ statements (Slice 5 / PR 5.1) ───────────────────────
  // Upsert pattern: first rejection inserts attempt=1; subsequent
  // rejections bump attempt_count + last_seen_ms. Using a raw INSERT
  // OR REPLACE would overwrite first_seen_ms on every call — not what
  // we want for the retry ledger — so we spell out the ON CONFLICT
  // clause to preserve first_seen_ms across updates.
  const upsertRejectionStmt = db.prepare(
    `INSERT INTO rejected_events (
        event_id, rejection_reason, details,
        attempt_count, first_seen_ms, last_seen_ms
      ) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        rejection_reason = excluded.rejection_reason,
        details          = excluded.details,
        attempt_count    = attempt_count + 1,
        last_seen_ms     = excluded.last_seen_ms`,
  );
  interface RejectionRow {
    event_id: string;
    rejection_reason: string;
    details: string | null;
    attempt_count: number;
    first_seen_ms: number;
    last_seen_ms: number;
  }
  const getRejectionStmt = db.prepare<RejectionRow, [string]>(
    'SELECT * FROM rejected_events WHERE event_id = ?',
  );
  const deleteRejectionStmt = db.prepare('DELETE FROM rejected_events WHERE event_id = ?');

  function rowToRejection(row: RejectionRow): EventRejectionRecord {
    const record: EventRejectionRecord = {
      eventId: row.event_id,
      rejectionReason: row.rejection_reason as EventRejectionRecord['rejectionReason'],
      attemptCount: row.attempt_count,
      firstSeenMs: row.first_seen_ms,
      lastSeenMs: row.last_seen_ms,
    };
    if (row.details !== null) record.details = row.details;
    return record;
  }

  async function recordInternal(event: AgentEvent): Promise<void> {
    const meta = event.meta ?? {};
    const recordedAt = Date.now();
    insert.run(
      event.id,
      event.kind,
      event.source.type,
      JSON.stringify(event.source),
      event.target.type,
      JSON.stringify(event.target),
      event.auth.kind,
      JSON.stringify(event.auth),
      event.payload !== undefined ? JSON.stringify(event.payload) : null,
      meta.correlationId ?? null,
      meta.causedBy ?? null,
      meta.idempotencyKey ?? null,
      event.meta ? JSON.stringify(event.meta) : null,
      event.timestamp,
      recordedAt,
    );
  }

  return {
    async record(event: AgentEvent): Promise<void> {
      await recordInternal(event);
    },

    async markOutcome(id: string, outcome: DispatchOutcome): Promise<void> {
      update.run(outcome.kind, JSON.stringify(outcome), Date.now(), id);
    },

    async get(id: string): Promise<EventStoreRecord | undefined> {
      const row = getById.get(id);
      return row ? rowToRecord(row) : undefined;
    },

    async findDuplicate(
      event: AgentEvent,
      withinMs: number,
    ): Promise<EventStoreRecord | undefined> {
      // 1) Direct id hit.
      const byId = getById.get(event.id);
      if (byId) return rowToRecord(byId);

      // 2) (idempotency_key, source_type) hit within the window.
      const key = event.meta?.idempotencyKey;
      if (!key) return undefined;
      const since = Date.now() - withinMs;
      const row = findByKey.get(key, event.source.type, since);
      return row ? rowToRecord(row) : undefined;
    },

    async list(filter: EventStoreListFilter = {}): Promise<readonly EventStoreRecord[]> {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filter.kind !== undefined) {
        clauses.push('kind = ?');
        params.push(filter.kind);
      }
      if (filter.correlationId !== undefined) {
        clauses.push('correlation_id = ?');
        params.push(filter.correlationId);
      }
      if (filter.sinceMs !== undefined) {
        clauses.push('ts >= ?');
        params.push(filter.sinceMs);
      }
      if (filter.outcomeKind !== undefined) {
        if (filter.outcomeKind === 'pending') {
          clauses.push('outcome IS NULL');
        } else {
          clauses.push('outcome = ?');
          params.push(filter.outcomeKind);
        }
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filter.limit ?? 200;
      const sql = `SELECT * FROM events ${where} ORDER BY ts DESC LIMIT ?`;
      params.push(limit);
      const stmt = db.prepare<EventRow, Array<string | number>>(sql);
      const rows = stmt.all(...params);
      return rows.map(rowToRecord);
    },

    async vacuum(olderThanMs?: number): Promise<number> {
      const cutoff = Date.now() - (olderThanMs ?? retentionMs);
      const result = vacuumStmt.run(cutoff);
      return result.changes;
    },

    async upsertRejection(
      eventId: string,
      reason: string,
      details: string | undefined,
      nowMs?: number,
    ): Promise<void> {
      const now = nowMs ?? Date.now();
      upsertRejectionStmt.run(eventId, reason, details ?? null, now, now);
    },

    async getRejection(eventId: string): Promise<EventRejectionRecord | undefined> {
      const row = getRejectionStmt.get(eventId);
      return row ? rowToRejection(row) : undefined;
    },

    async listRejections(
      filter: EventRejectionListFilter = {},
    ): Promise<readonly EventRejectionRecord[]> {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filter.reason !== undefined) {
        clauses.push('rejection_reason = ?');
        params.push(filter.reason);
      }
      if (filter.sinceMs !== undefined) {
        clauses.push('last_seen_ms >= ?');
        params.push(filter.sinceMs);
      }
      if (filter.minAttempts !== undefined) {
        clauses.push('attempt_count >= ?');
        params.push(filter.minAttempts);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filter.limit ?? 200;
      const sql = `SELECT * FROM rejected_events ${where} ORDER BY last_seen_ms DESC LIMIT ?`;
      params.push(limit);
      const stmt = db.prepare<RejectionRow, Array<string | number>>(sql);
      const rows = stmt.all(...params);
      return rows.map(rowToRejection);
    },

    async deleteRejection(eventId: string): Promise<boolean> {
      const result = deleteRejectionStmt.run(eventId);
      return result.changes > 0;
    },

    async eraseByPlatformUser(platformUserId: string): Promise<number> {
      // Match on meta.principal.platformUserId (stamped by channel adapters).
      const ids = db
        .prepare<{ id: string }, [string]>(
          "SELECT id FROM events WHERE json_extract(meta_json, '$.principal.platformUserId') = ?",
        )
        .all(platformUserId)
        .map((r) => r.id);
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => '?').join(',');
      // Drop any DLQ rows for those events first (FK-less, so order is for
      // tidiness), then hard-delete the events.
      db.prepare(`DELETE FROM rejected_events WHERE event_id IN (${placeholders})`).run(...ids);
      const result = db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).run(...ids);
      return result.changes;
    },
  };
}

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
  };
}

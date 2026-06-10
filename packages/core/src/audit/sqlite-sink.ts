import { Database } from 'bun:sqlite';
import type { Logger } from '../types/logger.js';
import { AuditBackpressureError, type BackpressureController } from './backpressure.js';
import { canonicalizeRecord, computeRecordHash, verifyEntries } from './chain-verify.js';
import type {
  EraseOptions,
  ErasedAuditRecord,
  ExportCursor,
  RetentionPruneOptions,
  StoredAuditEntry,
  TenantAuditQuery,
  TenantAuditRecord,
  TenantAuditRecordKind,
  TenantAuditSink,
  VerifyReport,
} from './types.js';

/**
 * Phase 6 slice-5 sqlite-backed {@link TenantAuditSink}.
 *
 * Every record lands in a single append-only table with a SHA-256 hash
 * chain. The schema is deliberately minimal — one table, two indexes —
 * so the sink can be swapped for Postgres / Kafka later without
 * leaking storage details into callers.
 *
 * Threading model: `bun:sqlite` is synchronous + single-threaded, which
 * matches our daemon's single-process model. All public methods are
 * async for interface symmetry but perform a single synchronous
 * transaction internally.
 */

export interface CreateSqliteAuditSinkOptions {
  /** `:memory:` for tests, absolute path in production. */
  path: string;
  /** Injected clock (only used for timestamps the caller omits). */
  now?: () => number;
  /**
   * Optional SIEM back-pressure controller. When supplied, `record()`
   * consults {@link BackpressureController.isPaused} before every write:
   *
   *   - `policy = 'fail-fast'` (default): throws {@link AuditBackpressureError}.
   *   - `policy = 'drop'`:   silently drops + increments the controller's
   *     drop counter (see {@link createBackpressureController}).
   *
   * Opt-in — undefined preserves pre-0.7.4 behaviour (unbounded intake).
   *
   * @since 0.7.4 — POST_ENTERPRISE_BACKLOG.md #11
   */
  backpressure?: BackpressureController;
  /**
   * Optional logger threaded into the back-pressure `'drop'` path. The
   * controller uses this for transition logs too, so most deployments
   * will pass the same logger to the controller itself; this is here
   * for the rare case where the sink wants extra visibility on drops.
   */
  logger?: Logger;
}

interface RowShape {
  seq: number;
  ts: number;
  tenant_id: string;
  kind: string;
  record_json: string;
  prev_hash: string;
  record_hash: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit_records (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    record_json TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    record_hash TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts
    ON audit_records (tenant_id, ts);
  CREATE INDEX IF NOT EXISTS idx_audit_tenant_kind
    ON audit_records (tenant_id, kind);

  /*
   * Forward-only cursor table used by the SIEM export loop (Enterprise
   * Production Plan §3 Item #10). One row per configured exporter.
   * last_seq is the highest audit_records.seq the downstream vendor
   * has acknowledged; the exporter advances only after ack, so a
   * crash between push + advance re-pushes on restart (at-least-once).
   */
  CREATE TABLE IF NOT EXISTS audit_export_cursor (
    exporter_name TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

function tenantIdOf(record: TenantAuditRecord): string {
  if (record.kind === 'tenant_boundary_violation') return record.sourceTenantId;
  return record.tenantId;
}

export async function createSqliteAuditSink(
  options: CreateSqliteAuditSinkOptions,
): Promise<TenantAuditSink> {
  const db = new Database(options.path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  const now = options.now ?? Date.now;
  const backpressure = options.backpressure;
  const logger = options.logger;

  const tailStmt = db.prepare('SELECT record_hash FROM audit_records ORDER BY seq DESC LIMIT 1');
  function latestHash(): string {
    const row = tailStmt.get() as { record_hash: string } | null;
    return row?.record_hash ?? '';
  }

  const insertStmt = db.prepare(
    `INSERT INTO audit_records (ts, tenant_id, kind, record_json, prev_hash, record_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  async function record(input: TenantAuditRecord): Promise<void> {
    // Back-pressure gate — when the SIEM backlog is too old, either
    // fail-fast to surface the outage or drop + log depending on the
    // controller's configured policy. See `backpressure.ts`.
    if (backpressure?.isPaused()) {
      const { reasonMs } = backpressure.state();
      if (backpressure.policy() === 'drop') {
        backpressure.recordDrop();
        logger?.warn('audit.backpressure.drop', {
          kind: input.kind,
          backlogMs: reasonMs,
        });
        return;
      }
      throw new AuditBackpressureError(
        `audit sink paused — SIEM export backlog exceeds threshold${
          reasonMs !== undefined ? ` (oldest unshipped row age ${reasonMs}ms)` : ''
        }`,
        reasonMs,
      );
    }
    const ts = (input as { ts?: number }).ts ?? now();
    const stamped: TenantAuditRecord = { ...input, ts } as TenantAuditRecord;
    const json = canonicalizeRecord(stamped);
    const prev = latestHash();
    const hash = await computeRecordHash(prev, stamped);
    insertStmt.run(ts, tenantIdOf(stamped), stamped.kind, json, prev, hash);
  }

  function rowToEntry(row: RowShape): StoredAuditEntry {
    const record = JSON.parse(row.record_json) as TenantAuditRecord;
    return {
      seq: row.seq,
      record,
      prevHash: row.prev_hash,
      recordHash: row.record_hash,
    };
  }

  async function query(q: TenantAuditQuery = {}): Promise<readonly StoredAuditEntry[]> {
    const conditions: string[] = [];
    const args: (string | number)[] = [];
    if (q.tenantId) {
      conditions.push('tenant_id = ?');
      args.push(q.tenantId);
    }
    if (q.kind) {
      const kinds = Array.isArray(q.kind) ? q.kind : [q.kind];
      const placeholders = kinds.map(() => '?').join(',');
      conditions.push(`kind IN (${placeholders})`);
      for (const k of kinds) args.push(k);
    }
    if (q.sinceMs !== undefined) {
      conditions.push('ts >= ?');
      args.push(q.sinceMs);
    }
    if (q.untilMs !== undefined) {
      conditions.push('ts <= ?');
      args.push(q.untilMs);
    }
    if (q.search) {
      conditions.push('record_json LIKE ?');
      args.push(`%${q.search}%`);
    }
    if (q.sinceSeq !== undefined) {
      conditions.push('seq > ?');
      args.push(q.sinceSeq);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = q.order === 'desc' ? 'DESC' : 'ASC';
    const limit = q.limit ?? 1000;
    const offset = q.offset ?? 0;
    args.push(limit);
    args.push(offset);
    const sql = `SELECT * FROM audit_records ${where} ORDER BY seq ${order} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...args) as RowShape[];
    return rows.map(rowToEntry);
  }

  async function erase(options: EraseOptions): Promise<number> {
    const rows = db.prepare('SELECT * FROM audit_records ORDER BY seq ASC').all() as RowShape[];
    const update = db.prepare(
      `UPDATE audit_records
         SET kind = ?,
             record_json = ?
         WHERE seq = ?`,
    );
    let erased = 0;
    const tx = db.transaction((targets: RowShape[]) => {
      for (const row of targets) {
        const original = JSON.parse(row.record_json) as TenantAuditRecord;
        if (!options.matches(original)) continue;
        const tombstone: ErasedAuditRecord = {
          kind: 'erased',
          ts: row.ts,
          tenantId: row.tenant_id,
          originalKind: row.kind,
          erasedAt: now(),
          reason: options.reason,
        };
        update.run('erased', canonicalizeRecord(tombstone), row.seq);
        erased += 1;
      }
    });
    tx(rows);
    return erased;
  }

  async function verify(tenantId?: string): Promise<VerifyReport> {
    const rows = tenantId
      ? (db
          .prepare('SELECT * FROM audit_records WHERE tenant_id = ? ORDER BY seq ASC')
          .all(tenantId) as RowShape[])
      : (db.prepare('SELECT * FROM audit_records ORDER BY seq ASC').all() as RowShape[]);
    return verifyEntries(rows.map(rowToEntry));
  }

  async function prune(opts: RetentionPruneOptions): Promise<number> {
    const clock = opts.now ?? now;
    const cutoff = clock() - opts.retentionDays * 24 * 60 * 60 * 1000;
    // WS8 — retention pruning TOMBSTONES expired rows rather than DELETEing
    // them. The hash chain is global (`prev = latestHash()`), so a hard delete
    // orphaned the next row's `prevHash` and broke `verify()` (the audit's
    // "prune breaks verify" finding). Tombstoning scrubs the PII payload —
    // satisfying retention/data-minimization — while preserving the row's
    // seq/prevHash/recordHash so the chain still verifies. Mirrors `erase()`.
    // Already-tombstoned rows are skipped so re-running prune is idempotent.
    const rows = db
      .prepare(
        "SELECT * FROM audit_records WHERE tenant_id = ? AND ts < ? AND kind != 'erased' ORDER BY seq ASC",
      )
      .all(opts.tenantId, cutoff) as RowShape[];
    const update = db.prepare('UPDATE audit_records SET kind = ?, record_json = ? WHERE seq = ?');
    let pruned = 0;
    const tx = db.transaction((targets: RowShape[]) => {
      for (const row of targets) {
        const tombstone: ErasedAuditRecord = {
          kind: 'erased',
          ts: row.ts,
          tenantId: row.tenant_id,
          originalKind: row.kind,
          erasedAt: clock(),
          reason: `retention:${opts.retentionDays}d`,
        };
        update.run('erased', canonicalizeRecord(tombstone), row.seq);
        pruned += 1;
      }
    });
    tx(rows);
    return pruned;
  }

  // ── Export cursor (SIEM loop, §3 Item #10) ─────────────────────────────
  const readCursorStmt = db.prepare(
    'SELECT exporter_name, last_seq, updated_at FROM audit_export_cursor WHERE exporter_name = ?',
  );
  const writeCursorStmt = db.prepare(
    `INSERT INTO audit_export_cursor (exporter_name, last_seq, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(exporter_name) DO UPDATE SET
       last_seq = CASE WHEN excluded.last_seq > audit_export_cursor.last_seq
                       THEN excluded.last_seq
                       ELSE audit_export_cursor.last_seq END,
       updated_at = CASE WHEN excluded.last_seq > audit_export_cursor.last_seq
                         THEN excluded.updated_at
                         ELSE audit_export_cursor.updated_at END`,
  );

  const oldestUnshippedStmt = db.prepare('SELECT MIN(ts) AS ts FROM audit_records WHERE seq > ?');
  async function oldestUnshippedMs(exporterName: string): Promise<number | null> {
    const cursor = await readExportCursor(exporterName);
    const sinceSeq = cursor?.lastSeq ?? 0;
    const row = oldestUnshippedStmt.get(sinceSeq) as { ts: number | null } | null;
    if (!row || row.ts === null) return null;
    return row.ts;
  }

  async function readExportCursor(exporterName: string): Promise<ExportCursor | null> {
    const row = readCursorStmt.get(exporterName) as {
      exporter_name: string;
      last_seq: number;
      updated_at: number;
    } | null;
    if (!row) return null;
    return {
      exporterName: row.exporter_name,
      lastSeq: row.last_seq,
      updatedAt: row.updated_at,
    };
  }

  async function writeExportCursor(exporterName: string, lastSeq: number): Promise<void> {
    writeCursorStmt.run(exporterName, lastSeq, now());
  }

  async function close(): Promise<void> {
    db.close();
  }

  return {
    record,
    query,
    erase,
    verify,
    prune,
    readExportCursor,
    writeExportCursor,
    oldestUnshippedMs,
    close,
  };
}

/**
 * Minimal sentinel so consumers can guard on "is the record a tombstone".
 */
export function isErasedRecord(record: TenantAuditRecord): record is ErasedAuditRecord {
  return record.kind === 'erased';
}

export type { TenantAuditRecordKind };

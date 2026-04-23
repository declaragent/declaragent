-- Authoritative audit-sink schema reference.
--
-- The runtime schema is applied by `createSqliteAuditSink` in
-- `sqlite-sink.ts` via `CREATE TABLE IF NOT EXISTS`. This file mirrors
-- it verbatim so operators + compliance auditors have a single text
-- artefact to review without reading through TypeScript source.
--
-- Changes here MUST be mirrored in `sqlite-sink.ts`'s `SCHEMA` constant
-- (and vice versa). The TS constant wins at runtime — this .sql is
-- documentation.
--
-- Enterprise Production Plan §3 Item #10 adds `audit_export_cursor` for
-- the SIEM export loop.

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

-- Forward-only cursor table used by the SIEM export loop.
-- One row per configured exporter; `last_seq` is the highest
-- `audit_records.seq` the downstream vendor has acknowledged.
-- The loop advances only after ack, so a crash between push and
-- advance re-pushes on restart (at-least-once delivery).
CREATE TABLE IF NOT EXISTS audit_export_cursor (
  exporter_name TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

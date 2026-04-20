---
'@declaragent/core': minor
---

Phase 6 slice 5: audit sink unification + tamper-evidence.

- **Unified record union**. `TenantAuditRecord` in
  `packages/core/src/audit/types.ts` folds in `tool_call` (Phase 1),
  `channel_event` / `channel_tool_call` / `channel_outbound` (Phase 5),
  `secret_access` (Phase 6 slice 3), plus new `tenant_boundary_violation`
  and `quota_exceeded` kinds. Each record carries a `tenantId` for the
  partitioned sink.
- **Sqlite-backed sink** (`createSqliteAuditSink`). Single append-only
  table with monotonic `seq`, per-tenant + per-kind indexes, and a
  chained SHA-256 (`record_hash = SHA-256(prevHash \n canonicalize(record))`).
  Canonicalization deep-sorts keys so the chain is deterministic even
  after a round-trip through JSON.parse.
- **Chain-verify**. `verifyEntries(...)` walks any iterable of
  `StoredAuditEntry` and detects `hash-mismatch` / `prev-hash-mismatch`
  violations at the seq that first broke. Consumable standalone (CLIs,
  JSON exports) as well as via `sink.verify(tenantId?)`.
- **Right-to-erasure**. `erase()` replaces matching records with
  `{ kind: 'erased', ... }` tombstones while leaving the stored
  `recordHash` untouched — chain-verify stays green. Convenience
  helpers: `erasePlatformUser`, `eraseBySession`, `eraseByCorrelation`.
- **Retention prune**. `sink.prune({ tenantId, retentionDays })`
  deletes rows older than the tenant's retention window.
- **Tests**. Round-trip every record kind; two tamper vectors (flip a
  byte in `record_json`, overwrite `prev_hash`) — both surface the
  expected `seq`; erasure leaves a tombstone + keeps the chain
  verifiable; retention prune is tenant-scoped.

---
'@declaragent/core': minor
---

Phase 7 slice 0.1: tenant-keyed session store.

First of the four Phase-6 carry-over PRs that slice 0 needs to unblock
GA. Session storage now keys on `(tenantId, sessionId)` instead of
`sessionId` alone.

- **Schema bump**. `sessions` grows a `tenant_id TEXT NOT NULL DEFAULT
  '__default__'` column plus a `(tenant_id, id)` index. Pre-v1.0
  databases migrate in place via `ALTER TABLE ADD COLUMN` on first open
  — every legacy row lands on the implicit default tenant, preserving
  Phase-1-through-5 single-tenant behaviour exactly.
- **API surface**. `SqliteSessionStore.create / open / list / delete`
  all accept an optional `{ tenantId }` scope. Omitting it falls back
  to `DEFAULT_TENANT_ID`, so existing callers (CLI `app.tsx`, skill
  runner, dispatcher) compile + run unchanged.
- **Cross-tenant enforcement**. `open(id, { tenantId })` and
  `delete(id, { tenantId })` throw `TenantBoundaryError` when the row
  exists but belongs to a different tenant; `list` filters to the
  requested tenant. A session-scoped error code surfaces as
  `TENANT_BOUNDARY` with the offending `resource: 'session'`.
- **`SessionMetadata.tenantId`** is exposed for CLI surfaces (slice
  0.3's forthcoming `declaragent tenants list` consumer).
- **Tests**. New test suites cover the pre-v1.0 migration (fixture
  seeded through the old schema, reopened through the new store),
  idempotent re-open, tenant-isolated `list`/`open`, and cross-tenant
  `open`/`delete` boundary throws.

Follow-ups in the rest of slice 0: daemon `startDaemon` per-tenant
branch + `tenants.yaml` auto-load (0.2); `declaragent tenants / audit
/ secrets` CLI verbs (0.3); per-tenant metrics-label auto-stamping in
the Prometheus exporter (0.4).

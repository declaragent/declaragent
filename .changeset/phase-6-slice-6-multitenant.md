---
'@declaragent/core': minor
---

Phase 6 slice 6: multi-tenant runtime primitives.

- **`tenants.yaml` loader** (`loadTenantsConfig`). Zod-validated config
  with `version` / `strategy.bus` (per-tenant or shared-with-filter) /
  `tenants[]` entries carrying `id`, `displayName`, `residency`,
  `auditRetentionDays`, `quotas`, `labels`, `extensions.allow/deny`,
  and `secretScopes`. Env expansion runs through the bootstrap
  secret resolver; duplicate ids + invalid id patterns are rejected.
- **EventBus tenant scope**. `createEventBus` grows `tenantScope` +
  `filterSubscribersByTenant` options. Publishes with a mismatched
  `meta.tenantId` throw `TenantBoundaryError`; missing ids are
  stamped automatically. Shared-bus + per-tenant-bus strategies share
  the same test suite.
- **Registry scoping** (`scopeRegistry`). Returns an
  `ExtensionRegistryView` that filters the global registry by a
  tenant's `{ allow, deny }` globs. Deny always wins. Uses the Phase-1
  permission-gate glob matcher.
- **TenantRuntime assembler** (`createTenantRuntime` /
  `createDefaultTenantRuntime`). Binds `TenantContext` + `EventBus` +
  scoped registry view + quota tracker + optional audit sink. The
  default-tenant variant preserves Phase-1-through-5 behaviour
  bit-for-bit.
- **Quota tracker** (`createQuotaTracker`). In-memory counters for
  `maxActiveSessions`, `maxConcurrentToolCalls`, `maxEventIngressPerSec`,
  and `dailyTokenUSD`. Breaches throw `QuotaExceededError` and (when
  an audit sink is wired) write a `quota_exceeded` record.
- **Deferred to a follow-up**: session-key `(tenantId, sessionId)`
  migration, daemon's `startDaemon` per-tenant branch, `declaragent
  tenants list / diff` CLI, and per-tenant metrics-label auto-stamping
  in the Prometheus exporter. None block slice 7 (chaos harness).

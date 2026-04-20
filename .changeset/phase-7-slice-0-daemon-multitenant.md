---
'@declaragent/core': minor
---

Phase 7 slice 0.2: daemon per-tenant branch + engine quota wiring.

Second of the Phase-6 carry-over PRs. Multi-tenant runtime primitives
from slice 6 are now reachable through the daemon's public surface.

- **`startDaemon({ tenants })`**. Accepts an optional `readonly
  LoadedTenant[]` — typically produced by `loadTenantsConfig` — and
  builds one `TenantRuntime` per entry via `createTenantRuntime`. Each
  tenant gets its own `EventBus` bound to its scope; the dispatcher
  attaches to every bus so events published by sources land in the
  dispatcher regardless of which tenant's bus they entered on.
- **`daemon.tenants: ReadonlyMap<string, TenantRuntime>`**. Always
  populated — single-tenant deployments contain one entry for the
  implicit `__default__` tenant that shares the primary bus.
  `tenants.get(id).bus` / `.quotas` / `.registry` expose each tenant's
  isolated runtime to admin surfaces.
- **`sendEvent` tenant routing**. In multi-tenant mode, an event
  carrying a `meta.tenantId` unknown to the daemon is rejected with
  `{ kind: 'rejected', reason: 'unauthorized', details: 'unknown
  tenant "..."' }`. Events with no `meta.tenantId` remain dispatcher-
  routed (backward compatible).
- **`tenantAudit` factory option**. An optional `(tenant) =>
  TenantAuditSink` callback lets the daemon wire quota-breach and
  tenant-boundary audit records per tenant.
- **Engine: `EngineConfig.quotas`**. When supplied, every tool call
  in the engine loop acquires a slot on `maxConcurrentToolCalls`
  before execution and releases it in `finally`. A `QuotaExceededError`
  produces an `[EQUOTA]` tool result (permission-deny semantics — the
  loop continues with other tool blocks, and `permissions.recordDenial`
  feeds the escalation counter).
- **Graceful shutdown**. `doShutdown` now detaches the dispatcher from
  every tenant bus and calls `runtime.close()` on each tenant runtime.
- **Tests**. New daemon suite `startDaemon — multi-tenant` covers the
  default-tenant fallback, two-tenant boot, `sendEvent` routing for
  known + unknown tenants, and the `tenantAudit` factory wiring
  through a `quota_exceeded` audit record. Engine suite `engine —
  tenant quota wiring (slice 0.2)` covers the EQUOTA path and the
  high-limit happy path.

Remaining slice 0 work:
- 0.3 — `declaragent tenants / audit / secrets` CLI verbs.
- 0.4 — per-tenant Prometheus `constLabels` auto-stamping.

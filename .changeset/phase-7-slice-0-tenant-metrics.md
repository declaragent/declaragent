---
'@declaragent/core': minor
---

Phase 7 slice 0.4: per-tenant Prometheus metrics auto-stamping.

Last of the Phase-6 carry-over PRs. `createPrometheusRegistry` already
accepted `constLabels`; the daemon now wires one registry per tenant,
pre-stamped with `constLabels: { tenant_id: tenant.id }`. Dashboards +
alert rules in `packages/testkit/alerts/` that key on `tenant_id` light
up automatically — the work is in the daemon, not the rules.

- **`TenantRuntime.metrics`**. New optional field exposes a
  `PrometheusRegistry` per tenant. Adapters that write to the shared
  `deps.metrics` surface now emit samples that carry the tenant label
  with no additional work.
- **`CreateTenantRuntimeOptions.metrics`**. Callers pass in the pre-
  built registry; the runtime stores it for downstream consumers.
- **`StartDaemonOptions.tenantMetricsStrategy`**. Controls how the
  daemon provisions registries when `tenants` is supplied:
  - `'per-tenant'` (default when `tenants` is non-empty) — one
    registry per tenant, each with `constLabels: { tenant_id }`.
  - `'shared'` — one registry shared across every tenant. Useful for
    `shared-with-filter` bus deployments where the adapter stamps the
    tenant label itself.
  - `'none'` — opt out entirely.
- **`StartDaemonOptions.createTenantMetricsRegistry`**. Factory hook
  for tests + custom deployments that want to pre-populate buckets or
  inject extra const labels beyond `tenant_id`.
- **Tests** added to `daemon.test.ts`:
  - per-tenant registries are distinct, scrape output carries the
    correct `tenant_id` label, and write-time labels merge with the
    const label.
  - `strategy: 'none'` leaves `runtime.metrics` undefined.
  - `strategy: 'shared'` returns the same registry for every tenant,
    with caller-supplied `tenant_id` labels surviving the scrape.
  - single-tenant default runtime remains metrics-free unless
    explicitly opted into shared mode.

**Slice 0 complete** — the multi-tenant primitives from Phase 6 now
surface end-to-end through CLI, runtime, and metrics. Phase 7 moves
on to slice 1 (release automation skeleton) next.

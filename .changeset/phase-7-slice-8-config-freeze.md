---
'@declaragent/cli': minor
'@declaragent/core': minor
---

Phase 7 slice 8: config freeze + `declaragent migrate`.

- **`declaragent migrate` verb** (`packages/cli/src/migrate-cli.ts`).
  Walks pre-v1.0 configs forward. Dry-run by default; `--apply`
  writes. Every migration is idempotent. Covers three surfaces:
  - **`agent.yaml`** — stamps `schemaVersion: 1` when absent; bumps
    `0` / `"0.9"` / legacy pre-v1.0 markers up to `1`. Leaves
    unknown future versions (>= 2) untouched.
  - **`tenants.yaml`** — advises only. When multi-tenant hints
    exist on disk but no `tenants.yaml` is present, prints a
    pointer to `declaragent tenants diff` + hand-authoring.
    Never writes a tenant topology automatically.
  - **`sessions.db`** — read-only pre-flight that confirms the
    Phase-7-slice-0.1 on-open migration will add the `tenant_id`
    column and backfill the default tenant on next daemon/CLI
    open.
- **Pure transforms** exported from
  `packages/cli/src/migrate-transforms.ts` for reuse + tests:
  `migrateAgentYaml`, `migrateTenantsYaml`, `migrateSessionSchema`.
- **Frozen surfaces — `@since 1.0.0` JSDoc tags** added to every
  public type the spec pins: `AgentSpec`, `SessionHandle`,
  `SessionLedger`, `TurnStatus`, `ToolContext`, `Tool`,
  `PendingToolCall`, `CompletedToolCall`, `ToolError`, `ToolEvent`,
  `TenantContext`, `TenantQuotas`, `TenantResidency`,
  `AgentEvent`, `AgentEventMeta`, `EventKind`,
  `SourceDependencies`, `EventSourceAdapter`, `ChannelAdapter`,
  `ChannelDependencies`, `TenantAuditRecord`,
  `TenantAuditRecordKind`, `TenantAuditSink`, `PluginManifest`.
- **Conformance test**
  (`packages/core/src/conformance.test.ts`). Minimal-surface
  fixtures assert `satisfies ChannelAdapter<unknown>` /
  `EventSourceAdapter<unknown>` — a new required field on either
  contract refuses to compile.
- **`docs/VERSIONING.md`** documents the v1.0 stability contract
  and the release cadence.

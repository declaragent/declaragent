---
'@declaragent/core': minor
---

Phase 6 slice 1: tenancy primitives. New `TenantContext`, `TenantRuntime`, `TenantBoundaryError`, `DEFAULT_TENANT_CONTEXT`, and `stampTenantId` exports land under `@declaragent/core`. `SourceDependencies`, `ChannelDependencies`, and `ToolContext` grow an optional `tenant?: TenantContext` field; when set, `BaseSourceInstance`, `BaseChannelInstance`, the engine's `turn.started` / `assistant.message` / `assistant.final` emits, and the built-in webhook / cron / file-watch adapters auto-stamp `event.meta.tenantId`. Fully backward-compatible: every Phase-1-through-5 caller keeps working under the implicit default tenant.

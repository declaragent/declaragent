# Versioning policy

Declaragent follows [Semantic Versioning 2.0.0][semver]. This document
pins the stability contract for v1.0 and later.

## Frozen surfaces

At v1.0.0 the following are stable and covered by SemVer:

- **`agent.yaml`** — every field validated by the root schema
  (`schemaVersion: 1`). New optional fields land in minors; removals
  and renames require a major.
- **TypeScript types** exported from `@declaragent/core`:
  `AgentSpec`, `ToolContext`, `Tool`, `PendingToolCall`,
  `CompletedToolCall`, `ToolError`, `ToolEvent`, `SessionHandle`,
  `SessionLedger`, `TurnStatus`, `TenantContext`, `TenantQuotas`,
  `TenantResidency`, `AgentEvent`, `AgentEventMeta`, `EventKind`,
  `SourceDependencies`, `EventSourceAdapter`, `ChannelAdapter`,
  `ChannelDependencies`, `TenantAuditRecord`, `TenantAuditRecordKind`,
  `TenantAuditSink`, `PluginManifest`.
- **CLI verbs + flags** — the shipped command surface (`init`,
  `tenants`, `audit`, `secrets`, `migrate`, `deploy`, `events`,
  `mailbox`, `dlq`, `mcp`, `channels`, `source-adapters`, `plugin`,
  `skill`) is frozen. Breaking renames require a major; new verbs
  and new optional flags land in minors.
- **Event kinds** — the `AgentEvent['kind']` union is frozen.
  Additional kinds land in minors; removals or kind renames require
  a major.
- **Audit record `kind` values** — `TenantAuditRecord['kind']` is
  frozen under the same policy.
- **Adapter contracts** — `ChannelAdapter<C>` and
  `EventSourceAdapter<C>` are frozen. A new required field on either
  interface is a major; new optional fields land in minors. A
  compile-time conformance test
  (`packages/core/src/conformance.test.ts`) enforces this.
- **Plugin manifest schema** — `PluginManifest` shape and the
  `plugin.json` loader's accepted fields are frozen.

Every frozen TypeScript type carries an `@since 1.0.0` JSDoc tag in
source.

## Release cadence

- `v1.0.x` — patches. Bug fixes, docs, non-breaking dependency bumps.
- `v1.X.0` — minor features. New optional fields, new adapters, new
  event kinds, new CLI verbs, new audit record kinds.
- `vX.0.0` — breaking changes. Removed or renamed fields, removed
  verbs, changed signatures.

Pre-releases follow `v1.0.0-rc.N`. Each release candidate gets a
one-day soak against the Phase-6 chaos suite and the pen-test-fixed
surface before promotion.

## Migrations

`declaragent migrate` walks pre-v1.0 configs forward. It is:

- **Idempotent** — running twice is a no-op.
- **Dry-run by default** — `--apply` is required to write.
- **Additive** — never touches fields the user set; only stamps
  `schemaVersion` and reports tenant/database drift.

A future major (`v2.0.0`) will ship the corresponding `migrate` rule
the same release it makes the breaking change. Users running the new
CLI against an old config get a clear pre-flight from `migrate`
before the daemon or REPL refuses to start.

## Security patches

Security fixes land on the latest minor line and are backported to
the prior minor for ninety days after the next minor release. CVE
disclosures follow the window in `docs/SECURITY.md`.

[semver]: https://semver.org/spec/v2.0.0.html

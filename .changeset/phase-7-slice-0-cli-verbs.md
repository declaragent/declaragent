---
'@declaragent/cli': minor
---

Phase 7 slice 0.3: `declaragent tenants / audit / secrets` CLI verbs.

Third of the Phase-6 carry-over PRs. The multi-tenant + audit + secrets
primitives are now driveable from a terminal without writing a script.
Every verb ships a `--json` flag for scripted workflows.

**`declaragent tenants …`**

- `list [--json]` — summary of every tenant declared in `tenants.yaml`
  (strategy + id + displayName + residency + quota count).
- `show <id> [--json]` — full context for one tenant: quotas, labels,
  extension allow/deny, secret scopes.
- `diff [--json]` — parses the local config and reports the tenants that
  would be loaded. Live-vs-disk drift surfacing needs a daemon
  control-plane method and is tracked for slice 0.5.

**`declaragent audit …`**

- `query [--tenant X] [--kind Y] [--since ms] [--until ms] [--limit N]
  [--json]` — runs `TenantAuditSink.query` against the default sqlite
  sink at `${configDir}/audit.db`.
- `verify [--tenant X] [--json]` — runs chain-verify; exit 0 on
  `ok: true`, 1 on violations (with the first 10 violation messages on
  stderr).
- `erase --user <platformUserId> [--reason R] [--json]` — wraps
  `erasePlatformUser`. Prints the tombstone count.
- `prune --tenant <id> --retention-days <N> [--json]` — wraps
  `TenantAuditSink.prune`.

**`declaragent secrets …`**

- `list [--provider <name>] [--json]` — prints providers declared in
  `secrets.yaml`. Enumerating individual refs per provider needs a
  provider-surface change and is tracked for slice 0.5.
- `describe <ref> [--json]` — splits the ref into `(provider, path)`,
  calls `provider.metadata()` when available, prints version / TTL /
  last-rotated. Providers without metadata support surface a clear
  "not supported" line.
- `rotate <ref> [--tenant X] [--reason R] [--json]` — verifies provider
  reachability via one `resolve()` call, then writes a `secret_access`
  audit record (`outcome: 'resolved'`). Real rotation stays
  provider-owned (Vault / AWS-SM rotate themselves); the CLI traces the
  moment in the audit chain.

**Paths**

- `tenantsConfigPath()` → `${configDir}/tenants.yaml`
- `secretsConfigPath()` → `${configDir}/secrets.yaml`
- `auditDbPath()` → `${configDir}/audit.db`

**Tests**

- `tenants-cli.test.ts` — 9 tests covering list/show/diff happy paths +
  one error per verb (missing config, unknown id, loader throws).
- `audit-cli.test.ts` — 8 tests covering query (unfiltered + filtered +
  missing DB), verify (intact chain + violations), erase (channel
  records + sink-open error), and prune (retention window).
- `secrets-cli.test.ts` — 8 tests covering list (human + JSON +
  unknown provider error), describe (metadata + no-metadata +
  unknown provider), and rotate (audit entry + resolve-fail abort).

**Remaining slice 0:** 0.4 — per-tenant Prometheus `constLabels`
auto-stamping in the daemon's metrics exporter.

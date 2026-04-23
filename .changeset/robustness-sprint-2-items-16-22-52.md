---
'@declaragent/cli': patch
---

Robustness sprint 2 — shared audit-sink singleton, `up-cli` tenant wiring, in-process log rotation.

- **#52 — Dedupe SIEM loop + `/audit` route** (`packages/cli/src/audit-sink-singleton.ts`, `up-cli.ts`):
  Module-level `getOrOpenSharedAuditSink({ path })` memoises `createSqliteAuditSink` handles by absolute path. Concurrent first-time callers share the in-flight open promise; release is idempotent and clears the cache so a subsequent `up` in the same process opens a fresh handle. `up-cli` now opens its shared audit sink through this helper, guaranteeing the `/audit` route, per-agent rate-limit gate, and SIEM export loop share one SQLite connection even if a future caller lands a second `createSqliteAuditSink` call-site on the same DB.

- **#16 — `TenantAuditSink` threaded through `up-cli` engine path** (`up-cli.ts`):
  The `attachDispatcherToAgent` engine construction now passes `DEFAULT_TENANT_CONTEXT` explicitly so single-process deployments key `rate_limited` audit records and quota tracking on the same `tenantId` fleet-run uses. No behavioural change for existing fleets (engine previously defaulted `undefined` → `'default'` inside the loop); the explicit wiring makes the symmetry obvious and keeps downstream SIEM queries portable between `up` and `fleet run` topologies.

- **#22 — In-process log rotation for `openAgentLog`** (`up-lifecycle.ts`):
  `openAgentLog(agentId, dir)` now returns a logger with a `rotate()` method that flushes the active stream, renames the log to `<agentId>-<ISO>.log` (colons squashed to `-` for Windows portability), and opens a fresh append-mode stream at the original path. Writes issued concurrently during rotation are buffered and drained onto the new stream — no records dropped. Complements the external-rotation inode re-check already in `logs-cli.ts`. Tests cover archive-plus-active, post-rotation tail, buffered concurrent writes, and the closed-logger guard.

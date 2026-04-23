---
'@declaragent/core': patch
'@declaragent/plugin-agent-rpc': patch
'@declaragent/cli': patch
---

**Security sprint follow-ups from `POST_ENTERPRISE_BACKLOG.md` — items #8 + #9.**

- **#8 — `AUTH_REJECTED` promoted to `RPC_ERROR_CODES`.** Previously the envelope auth-reject path in `packages/cli/src/fleet-run.ts` stamped a bare `'AUTH_REJECTED'` string on the response envelope. The constant now lives on `@declaragent/core`'s canonical `RPC_ERROR_CODES` map alongside `AUTH_FAILED`, `VERSION_SKEW`, etc. The wire value is intentionally preserved (unprefixed `'AUTH_REJECTED'`) for back-compat with 3.0.0 receivers that pattern-match the literal — callers migrating should import `RPC_ERROR_CODES.AUTH_REJECTED` from `@declaragent/core`. Covered by `packages/core/src/rpc/errors.test.ts`.

- **#9 — Capability schema-violation audit cardinality pinned per-envelope.** The emit contract on `CapabilitySchemaViolationEmitter` (in `@declaragent/plugin-agent-rpc`) + the `capability_schema_violation` audit record (in `@declaragent/core`) was already batched per envelope, but the decision was only implicit. Added explicit `POST_ENTERPRISE_BACKLOG.md #9` JSDoc + a regression test in `request-agent.test.ts` that trips 3 violations in one payload and asserts the emitter fires exactly once with all violations in the array. This caps SIEM volume under bad-actor / mass-rejection traffic — a single misconfigured envelope can trip every field in a large schema, and a per-violation emit would multiply audit rows by the schema's field count.

No breaking changes. `@declaragent/cli` patch bump picks up the `RPC_ERROR_CODES.AUTH_REJECTED` wire swap in `fleet-run.ts`.

---
'@declaragent/cli': patch
'@declaragent/core': patch
---

feat(control-plane): Slice 6b — `fleet dlq drop/requeue` cross-host mutations (#50 follow-up)

Slice 3 shipped snapshot fan-out across `fleet.yaml#hosts[]` at 0.7.4. Slice 6a
added live `fleet logs -f` multiplex at 0.7.5. This closes the remaining half
with destructive mutations over the same control-plane transport.

**Core:**

- New `dlqDropRoute(store, { onAudit? })` bound at `POST /dlq/drop?kind=dispatch&id=<id>`.
- New `dlqRequeueRoute({ store, bus }, { onAudit? })` bound at `POST /dlq/requeue?kind=dispatch&id=<id>`.
  Mirrors the semantics of the per-agent `dlq.requeue` control-socket op over HTTP.
- New `DlqOperationAuditRecord` audit kind. Wired into the shared `TenantAuditSink` via `onAudit`
  so every operator-initiated drop/requeue leaves a hash-chained receipt with `op`, `host` (added
  by the cross-host CLI before rendering), `initiator` (from `x-declaragent-initiator`), and
  `attemptsBeforeOp`.
- 200 on success, 404 with typed `reason` (`not-found` / `dlq-miss` / `event-miss`) for
  idempotent no-ops, 400 on missing / invalid params.

**CLI:**

- `CrossHostControlPlaneClient` extended with `dropDlqEntry(host, args)` + `requeueDlqEntry(host, args)`.
  Both treat 404 as a typed-miss body (no throw) so callers can distinguish fresh mutations from
  silent retries.
- `declaragent fleet dlq drop --id <id> [--kind dispatch] [--host <name> | --all-hosts --yes] [--json]`
  and `declaragent fleet dlq requeue ...` verbs. Default is single-host; fleets with >1 host
  refuse to fan out without explicit `--host <name>` OR `--all-hosts` (which requires a
  confirmation prompt, bypassable with `--yes`). Exit codes: 0 success / 1 partial failure /
  2 ambiguous target / 3 user cancelled.
- One-host fleets skip the ambiguity check and drop/requeue directly.

No breaking changes. `declaragent up` binds the new routes automatically when an event store
is available; operators using a reverse-proxy need to allow `POST /dlq/drop` and `POST /dlq/requeue`
(same loopback-by-default / auth-by-config posture as every other control-plane endpoint).

---
'@declaragent/testkit': minor
---

Phase 6 slice 7: chaos harness + assertions.

- **`ChaosDriver`** (`packages/testkit/src/chaos/driver.ts`). Deterministic
  policy-driven fault firing with injectable clock / RNG / scheduler.
  `policy.probability`, `policy.budget`, and `inject(fault)` all covered.
  `onEvent` streams a `started` / `fault.fire` / `fault.complete` /
  `fault.error` / `budget-exhausted` / `stopped` timeline. `stop()`
  returns the full `ChaosReport`.
- **Seven fault implementations** under
  `packages/testkit/src/chaos/faults/`:
  - In-memory: `bus-high-watermark`, `expire-idempotency-cache`,
    `clock-skew` (with a companion `createMutableClock`),
    `network-latency` (wraps a caller-supplied `fetch`).
  - Infrastructure-shaped: `kill-replica`, `partition-broker`,
    `partition-channel` — each ships an `InMemory…` implementation for
    unit tests and an interface (`ReplicaKiller`, `BrokerPartitioner`,
    `ChannelPartitioner`) callers plug K8s/Docker shell hooks into.
  - `composeRuntimes(logger, ...fragments)` helper stitches the
    per-fault fragments into the single `ChaosTargetRuntime` the driver
    dispatches to.
- **Five assertions** under `assertions/`:
  - `no-event-loss` — per-source `received == processed + dlq + inflight`.
  - `no-cross-tenant-leak` — audit records all match the scoped tenant
    and zero `tenant_boundary_violation` records surface.
  - `no-secret-in-logs` — watched values never appear in logs or audit.
  - `slos-held` — p99 channel-outbound latency + DLQ rate stay within
    configurable thresholds (10 s / 1 % defaults).
  - `dedup-never-drops` — every correlation id appears in the audit
    log exactly once.
- **Report writers** — `renderChaosReportJson` + `renderChaosReportMarkdown`
  produce diff-friendly JSON + human-scan markdown tables (assertions +
  fault timeline).
- **Tests** — 28 unit tests covering every fault, every assertion, the
  driver's scheduler + budget + inject + error-propagation paths, and
  both report renderers.

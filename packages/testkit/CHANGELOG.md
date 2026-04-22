# @declaragent/testkit

## 3.0.0

### Patch Changes

- 8bddcc1: **Slice 7 of 0.6.0 production hardening — fleet RPC over Kafka.**

  ### @declaragent/plugin-agent-rpc

  New `createKafkaTransport({ brokers, clientId?, groupId?, kafkajsModule?, logger? })` at `packages/plugin-agent-rpc/src/kafka-transport.ts`. Constructs an `RpcTransport` whose `publish()` routes through a Kafka producer and whose `subscribe()` spins a per-topic consumer.

  Key design points:

  - **`kafkajs` is loaded dynamically** via a computed-specifier `import()`, so `plugin-agent-rpc` doesn't declare `kafkajs` as a dep. Hosts that want Kafka install `kafkajs` themselves; hosts that use the memory transport pay no weight.
  - **Per-topic consumers** mirror `MemoryTransport`'s subscription semantics — one topic's lifecycle never blocks another's rebalance.
  - **Envelope wire format** reuses core's `encodeEnvelope` / `decodeEnvelope` so Kafka payloads round-trip the same validation as memory-bus messages.

  Unit coverage (`kafka-transport.test.ts`): 7 tests against a mocked `KafkaJSModule` covering publish wire format, subscribe delivery, multi-subscriber unsub, close lifecycle, post-close reject, empty-brokers guard, and malformed-payload swallow.

  ### @declaragent/testkit

  New `packages/testkit/src/fleet-integration/kafka-rpc.test.ts`. Gated behind `FLEET_INTEGRATION=1` + `KAFKA_BROKERS` so the default `bun test` run stays broker-free. When enabled: spins two transports against a live Redpanda, sends a request, asserts the round-trip completes within 2s.

  Also adds `@declaragent/plugin-agent-rpc` to testkit's peer deps (needed for the new harness).

  ### .github/workflows/nightly-integration.yml

  Runs the integration test nightly at 08:00 UTC against a Redpanda service spun up via the existing `packages/source-kafka/test/fixtures/docker-compose.yml`. Failures open a `nightly-flake`-labeled issue rather than blocking unrelated PRs. Configurable retry count (default 3) absorbs transient broker flakes without hiding real regressions.

  ### Intentional deferrals

  - **Full `declaragent fleet run` boot over Kafka** — the current integration test proves the transport layer. End-to-end `RequestAgent` dispatch through live LLM handlers needs a provider-mock scaffold that grew out of scope. Tracked for Slice 7.5 / post-0.6.0.
  - **Chaos scenarios** — broker crash, partition rebalance, consumer-lag recovery. Same post-0.6 track.
  - **Soak proof** — the plan asked for 7 consecutive green nightlies before beta → rc. Can't verify that from a single PR; first nightly run gates the promotion. AGENTS.md reflects the gap honestly: infrastructure ✅, soak 🟡.

  Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 7.

- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
  - @declaragent/core@0.4.0
  - @declaragent/plugin-agent-rpc@3.0.0
  - @declaragent/source-kafka@3.0.0

## 2.0.0

### Patch Changes

- Updated dependencies [da8f330]
- Updated dependencies [579362c]
- Updated dependencies [778f505]
- Updated dependencies [a4ba7a4]
- Updated dependencies [9a6c64f]
  - @declaragent/core@0.3.0
  - @declaragent/source-kafka@2.0.0

## 1.0.0

### Minor Changes

- 4309000: Phase 6 slice 2: observability maturation.

  - **Prometheus exposition**. New `createPrometheusRegistry()` +
    `startPrometheusExporter()` in `@declaragent/core`. Registry is a
    stateful `MetricsRegistry` that retains per-(metric, label-set) state
    so scrapes produce a point-in-time snapshot. Exporter binds a Bun
    HTTP server (default `127.0.0.1:9464/metrics`) with localhost-only
    gating. Metric-name normalization maps dotted internal identifiers
    (`source.messages.processed`) to Prometheus-valid wire names
    (`source_messages_processed`).
  - **Alert rule files**. `packages/testkit/alerts/` ships six rule
    documents (channels, event-sources, whatsapp-windows, security,
    chaos-assertions, daemon) keyed on metrics emitted by Phase-4 and -5.
    Every alert includes `severity`, `summary`, `description`, and
    `runbook_url` — locked in by a new `packages/testkit/test/alerts.test.ts`.
  - **Runbooks**. 23 operator runbooks under `docs/runbooks/` following
    the §4.4 Symptom → Cause → Mitigation → RCA → Post-incident template.
  - **Correlation-id audit**. `ToolContext` grows an optional
    `correlationId` field; the engine threads `input.causedBy` through.
    The Agent tool now inherits the parent's correlation id on sub-agent
    spawn instead of re-rooting on the parent session id.
  - Wires `yaml` (2.8.3) as a runtime dep of `@declaragent/testkit`.

- 4309000: Phase 6 slice 7: chaos harness + assertions.

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

- 4309000: Phase 6 slice 8: release gate + threat-model signoff. Phase-closer.

  - **`.github/workflows/release-gate.yml`**. Merges to `main` block on
    failure in any of: chaos:quick smoke, tenant isolation tests, secret-
    leak property tests, HMAC anti-pattern guard, or osv-scanner's
    CRITICAL findings. A final summary job wires the individual concerns
    into a single release-gate verdict.
  - **`chaos:quick` runner**
    (`packages/testkit/scripts/chaos-quick.ts`). In-process smoke test
    that injects every fault kind once against the in-memory runtime
    stubs, runs the `no-event-loss` / `no-cross-tenant-leak` /
    `dedup-never-drops` assertions, and writes dual JSON + markdown
    reports with a timestamped name. `bun run chaos:quick` exits non-
    zero on any assertion or timeline failure.
  - **Fault-factory return types tightened**. Every `createXxxFault`
    factory now returns `Required<Pick<ChaosTargetRuntime, 'xxx'>>`
    instead of the optional-method picked form — the tests no longer
    need `?.` guards and the typechecker catches missing implementations
    at compose-time.
  - **`docs/THREAT_MODEL.md`**. STRIDE walkthrough per component (core
    engine, event bus + sources, channel adapters, built-in tools, MCP
    client, secret resolver, daemon + control plane, audit sink) with
    each threat paired to its mitigation + residual risk. Cross-links to
    every Phase-6 slice that added a mitigation.
  - **`docs/PEN_TEST_SIGNOFF.md`** template. Engagement scope, findings
    table, reviewer attribution placeholders, and a residual-risk sign-
    off matrix. Populated by the third-party firm at engagement close.
  - **`docs/runbooks/phase-6-exit-criteria.md`**. The close-out runbook
    for every soak run: what attestation folder to produce, which
    assertions are MUST-pass vs. retrospective-only, which Grafana
    snapshots to capture, and the tag + announce protocol.

  **Phase 6 is closed**. Every slice (1 — tenancy primitives, 2 —
  observability, 3 — secrets, 4 — security hardening, 5 — audit, 6 —
  multi-tenant primitives, 7 — chaos, 8 — release gate) landed with
  green CI. 1477 tests pass across the monorepo with the full Phase-6
  assertion surface in place.

### Patch Changes

- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
  - @declaragent/core@0.2.0
  - @declaragent/source-kafka@1.0.0

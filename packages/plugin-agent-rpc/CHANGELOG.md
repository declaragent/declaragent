# @declaragent/plugin-agent-rpc

## 4.0.1

### Patch Changes

- 11c494d: feat(transport): `createJetStreamTransport` for at-least-once RPC with replay (#23)

  Adds a new transport factory alongside `createNatsTransport` + `createKafkaTransport` that uses NATS JetStream for persistent, at-least-once request/response delivery — the right default when RPC envelopes represent side-effectful actions ("charge this card") rather than telemetry.

  Shape mirrors the Kafka transport: per-topic durable consumers, explicit ack on handler success, nak on handler throw (JetStream redelivers after `ackWaitMs`), and `term` on malformed payloads. Publish is server-acked via `js.publish()`. The envelope + pending-registry contract is unchanged — callers plug this into `transportFactories` exactly like the existing factories.

  Options cover the common production knobs: `stream` + `durableName` (operator-provisioned), `ackWaitMs` (default 30s), `maxDeliver` (default 5), `replay: 'instant' | 'original'`, `deliverPolicy: 'all' | 'last' | 'new'` (default `'new'`), plus the usual `subjectPrefix` / auth fields. `kind: 'nats'` is preserved — JetStream is an overlay on the same wire protocol, and introducing a fourth `RpcTransportKind` would ripple through every loader + builder type enum for no operational gain.

  Unit tests cover publish/subscribe/ack/nak/term, unsubscribe tearing down the consume loop, subject prefixing, replay-policy passthrough, and bind-to-existing consumer semantics. A live-broker test lives at `packages/testkit/src/fleet-integration/jetstream-rpc.test.ts` behind `FLEET_INTEGRATION=1 NATS_INTEGRATION=1`; it asserts round-trip latency + handler-throws-then-redelivery.

- Updated dependencies [c8e87e6]
- Updated dependencies [e9abb80]
  - @declaragent/core@0.5.1

## 4.0.0

### Patch Changes

- 8651c54: `createNatsTransport` now accepts `queueGroups` as either a blanket string (same semantics as the legacy `queueGroup`) or a per-topic `Record<topic, group>` map. Real fleets routinely mix load-balanced and fan-out topologies on one NATS cluster — `agents.beta.requests` needs a shared queue so replicas load-balance, while `agents.broadcast.health` needs no queue so every replica sees the heartbeat. A single construction-time queue group can't express both; the new shape does.

  Backward compatible: the pre-existing `queueGroup` option keeps working and now acts as the fallback for topics unlisted in `queueGroups`. An explicit empty-string entry opts that topic out of any queue group. Addresses post-enterprise backlog item #25.

- 2e60de4: **Security sprint follow-ups from `POST_ENTERPRISE_BACKLOG.md` — items #8 + #9.**

  - **#8 — `AUTH_REJECTED` promoted to `RPC_ERROR_CODES`.** Previously the envelope auth-reject path in `packages/cli/src/fleet-run.ts` stamped a bare `'AUTH_REJECTED'` string on the response envelope. The constant now lives on `@declaragent/core`'s canonical `RPC_ERROR_CODES` map alongside `AUTH_FAILED`, `VERSION_SKEW`, etc. The wire value is intentionally preserved (unprefixed `'AUTH_REJECTED'`) for back-compat with 3.0.0 receivers that pattern-match the literal — callers migrating should import `RPC_ERROR_CODES.AUTH_REJECTED` from `@declaragent/core`. Covered by `packages/core/src/rpc/errors.test.ts`.

  - **#9 — Capability schema-violation audit cardinality pinned per-envelope.** The emit contract on `CapabilitySchemaViolationEmitter` (in `@declaragent/plugin-agent-rpc`) + the `capability_schema_violation` audit record (in `@declaragent/core`) was already batched per envelope, but the decision was only implicit. Added explicit `POST_ENTERPRISE_BACKLOG.md #9` JSDoc + a regression test in `request-agent.test.ts` that trips 3 violations in one payload and asserts the emitter fires exactly once with all violations in the array. This caps SIEM volume under bad-actor / mass-rejection traffic — a single misconfigured envelope can trip every field in a large schema, and a per-violation emit would multiply audit rows by the schema's field count.

  No breaking changes. `@declaragent/cli` patch bump picks up the `RPC_ERROR_CODES.AUTH_REJECTED` wire swap in `fleet-run.ts`.

- Updated dependencies [1bc842d]
- Updated dependencies [b69d717]
- Updated dependencies [2e60de4]
  - @declaragent/core@0.5.0

## 3.0.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
- Updated dependencies [8bddcc1]
  - @declaragent/core@0.4.0

## 2.0.0

### Patch Changes

- Updated dependencies [da8f330]
- Updated dependencies [579362c]
- Updated dependencies [778f505]
- Updated dependencies [a4ba7a4]
- Updated dependencies [9a6c64f]
  - @declaragent/core@0.3.0

## 1.0.0

### Minor Changes

- 4309000: Fleet slice 7 — all-or-nothing deploy polish + version-skew wiring.

  Closes the RPC + deploy loop for FLEET_PLAN.md §8.2 / §8.3 / §14.8 —
  fleets can now detect and optionally reject callers running an older
  code version than the receiver will accept.

  **`@declaragent/core`**

  New module `packages/core/src/fleet/version-skew.ts`:

  - `FLEET_VERSION_HEADER` — constant `'x-fleet-version'`.
  - `FLEET_VERSION_ENV` — constant `'DECLARAGENT_FLEET_VERSION'`.
  - `parseFleetVersion(raw)` → parses `vMAJOR.MINOR.PATCH-sha` or
    returns undefined.
  - `compareFleetVersions(a, b)` → `-1 | 0 | 1` over `(major, minor, patch)`
    (sha is informational and ignored — a rolling deploy mid-flip doesn't
    spuriously register skew).
  - `stampFleetVersionHeader(envelope, version)` — non-mutating clone that
    adds `x-fleet-version` to `headers`.
  - `readFleetVersionHeader(envelope)` — extractor.
  - `checkFleetVersionSkew({callerVersion, selfVersion, minFleetVersion?})`
    → `{status: 'match' | 'older-caller' | 'newer-caller' | 'rejected' | 'unknown', caller?, self?, message?}`.
    `minFleetVersion` is a hard gate: caller below it returns `rejected`
    regardless of self's version.
  - `injectFleetVersionEnv(env, version)` / `readFleetVersionFromEnv(env)`
    — env-var helpers for deploy adapters.

  Also: `RPC_ERROR_CODES.VERSION_SKEW = 'EVERSION_SKEW'` — the code
  receivers return when rejecting a too-old caller (§14.8).

  **`@declaragent/plugin-agent-rpc`**

  - `createRequestAgentTool({...fleetVersion?})` — new **opt-in** option.
    When supplied, every outbound request envelope carries
    `headers: { 'x-fleet-version': <value> }`. Omit to leave envelopes
    unstamped (the default — §14.8 says the stamp is opt-in per
    `fleet.yaml → rpc.stampFleetVersion: true`).

  **`@declaragent/cli`**

  - `startFleetDaemon({...selfFleetVersion?})` — new option lets tests
    inject the receiver's version without touching ambient env.
    Production callers let it default to
    `readFleetVersionFromEnv(process.env)`.
  - `fleet-run` workers now consult `fleet.manifest.rpc.minFleetVersion`
    - the caller's `x-fleet-version` header on every request:
    * `match` / `older-caller` / `unknown` → proceed silently.
    * `newer-caller` → process the request + increment `versionSkewNewer`
      - log `fleet.version.skew agent=… caller=… self=…`.
    * `rejected` → respond with `{ok: false, error: {code: 'EVERSION_SKEW'}}`
      - increment `versionRejected` + log `fleet.version.skew.reject`.
  - `FleetAgentWorkerMetrics` gains `versionRejected` + `versionSkewNewer`.
  - `fleet-deploy-cli.DeployContext` gains `injectedEnv:
Record<string, string>` containing `DECLARAGENT_FLEET_VERSION` (§8.2).
    The in-memory deploy target records the env map per agent on
    `envForAgent` so tests can assert the contract.

  **Out of scope for slice 7 (noted):** `fleet status --history` already
  lists deploy records (slice 5); a Prometheus `fleet.version.skew`
  histogram is a follow-up — slice 7 emits the signal via the stdio
  logger until the metrics registry wire-up lands.

  **Tests.** 27 new: 23 `version-skew.test.ts` units (parse/compare/stamp/
  read/check/env), 3 `fleet-run.test.ts` integration (reject older,
  accept newer with metric, unstamped passes through), 1 `fleet-deploy-
cli.test.ts` assertion that `DECLARAGENT_FLEET_VERSION` flows into
  adapter env.

  **Next.** Slice 8 — `fleet status` + live health.

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

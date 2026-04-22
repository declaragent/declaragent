---
'@declaragent/plugin-agent-rpc': minor
'@declaragent/testkit': patch
---

**Slice 7 of 0.6.0 production hardening — fleet RPC over Kafka.**

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

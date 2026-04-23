---
'@declaragent/plugin-agent-rpc': patch
---

feat(transport): `createJetStreamTransport` for at-least-once RPC with replay (#23)

Adds a new transport factory alongside `createNatsTransport` + `createKafkaTransport` that uses NATS JetStream for persistent, at-least-once request/response delivery — the right default when RPC envelopes represent side-effectful actions ("charge this card") rather than telemetry.

Shape mirrors the Kafka transport: per-topic durable consumers, explicit ack on handler success, nak on handler throw (JetStream redelivers after `ackWaitMs`), and `term` on malformed payloads. Publish is server-acked via `js.publish()`. The envelope + pending-registry contract is unchanged — callers plug this into `transportFactories` exactly like the existing factories.

Options cover the common production knobs: `stream` + `durableName` (operator-provisioned), `ackWaitMs` (default 30s), `maxDeliver` (default 5), `replay: 'instant' | 'original'`, `deliverPolicy: 'all' | 'last' | 'new'` (default `'new'`), plus the usual `subjectPrefix` / auth fields. `kind: 'nats'` is preserved — JetStream is an overlay on the same wire protocol, and introducing a fourth `RpcTransportKind` would ripple through every loader + builder type enum for no operational gain.

Unit tests cover publish/subscribe/ack/nak/term, unsubscribe tearing down the consume loop, subject prefixing, replay-policy passthrough, and bind-to-existing consumer semantics. A live-broker test lives at `packages/testkit/src/fleet-integration/jetstream-rpc.test.ts` behind `FLEET_INTEGRATION=1 NATS_INTEGRATION=1`; it asserts round-trip latency + handler-throws-then-redelivery.

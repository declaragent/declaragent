---
'@declaragent/plugin-agent-rpc': patch
---

feat(transport): `createSqsTransport` for at-least-once RPC over Amazon SQS (#24a)

Third broker in the at-least-once family alongside `createKafkaTransport` (#7 / Slice 7) and `createJetStreamTransport` (#23). Partial delivery on backlog item #24 — SQS ships in 0.7.3; AMQP + MQTT are sequenced for Sprint 4 (0.7.4).

Shape mirrors the Kafka + JetStream factories: the envelope contract and `pending-registry` are unchanged, so `createRequestAgentTool` + `createAgentInboxAdapter` plug in via `transportFactories.sqs` exactly like the existing factories.

Delivery semantics:

- `publish(topic, envelope)` → `SendMessage` against the mapped `queueUrl`. FIFO queues (URL suffix `.fifo`) are auto-detected; `messageGroupId` defaults to `envelope.to` (serializes requests per target-agent) and `messageDeduplicationId` accepts a resolver for queues without content-based dedup.
- `subscribe(topic, handler)` → per-topic long-poll loop (defaults: 20 s wait, 10 messages per batch, 10 in-flight). Handler success → `DeleteMessage`. Handler throw → leave the message undeleted so SQS's visibility-timeout + `maxReceiveCount` → native DLQ redrive fires.
- Decode failures are terminal; three operator-selectable policies: `'delete'` (default — log + remove; matches JetStream's `term`), `'leave'` (let SQS redrive until queue-native DLQ kicks in), `'send-dlq'` (forward to an operator-owned `dlqQueueUrl` + delete from main).
- `close()` stops every poll loop, drains in-flight handlers, and disconnects the SDK client.

Config accepts a static `queueUrls` map, a dynamic `queueUrlFor` resolver, or both (resolver wins). Credentials default to the AWS SDK chain (IAM role / env / shared config); static creds + custom `endpoint` are supported for LocalStack. The AWS SDK is loaded via dynamic import so this package stays dep-free until used.

Unit tests (22 cases) cover: kind, publish to standard + FIFO with auto-/explicit `messageGroupId` + dedup-id resolvers, subscribe success-delete + handler-throw-leave, three decode-fail policies, DLQ-without-url rejection, missing-queue rejection, close idempotency, unsubscribe teardown, transient receive-failure retry, and factory-vs-injected-client wiring. The live-broker round-trip reuses `@declaragent/source-sqs`'s LocalStack fixtures behind `SQS_INTEGRATION=1`.

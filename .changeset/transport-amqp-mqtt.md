---
'@declaragent/plugin-agent-rpc': patch
---

Add `createAmqpTransport` (RabbitMQ / AMQP 0.9.1) and `createMqttTransport` (MQTT 3/5) RPC transport factories — post-enterprise backlog items #24b + #24c.

- **AMQP**: publisher confirms, per-topic (exchange, routingKey, queue) route specs, configurable prefetch, `requeueOnHandlerError` (default `false` so a broker-side DLX picks up handler failures), three decode-fail policies (`ack` / `requeue` / `nack-no-requeue`). Dynamic-import-loads `amqplib@^0.10` to align with `@declaragent/source-amqp`.
- **MQTT**: QoS 0/1/2 per-topic with default QoS 1 (at-least-once), MQTT 5 shared subscriptions via `sharedSubscriptionGroup` rewriting to `$share/<group>/<topic>`, client-side topic-wildcard matching (`+` / `#`), optional `dlqPublish` hook for malformed payloads. Dynamic-import-loads `mqtt@^5` to align with `@declaragent/source-mqtt`.
- MQTT semantics gap vs other transports documented in the top-of-file comment: MQTT 3 has no per-message handler ack, so handler throw cannot trigger transport-layer redelivery. Use Kafka/JetStream/SQS/AMQP for capabilities that require retry-on-handler-error.

Both factories exported from `@declaragent/plugin-agent-rpc`; 39 new unit tests with mocked clients (no live-broker gated tests shipped this sprint).

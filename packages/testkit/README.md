# @declaragent/testkit

Test harnesses and shipped observability artifacts for
[Declaragent](https://declaragent.dev) — the declarative, git-versioned AI
agent platform.

What's inside:

- **Integration suites** — Docker-Compose-backed tests for the broker
  transports (Kafka/Redpanda, NATS, JetStream, SQS, AMQP, MQTT), SIEM audit
  exporters (Splunk / Elastic / Datadog), fleet runtime, RPC auth
  (OIDC/OAuth2 against a live IdP), and load. Each suite is gated behind its
  own env var (`KAFKA_INTEGRATION=1`, `NATS_INTEGRATION=1`,
  `RPC_AUTH_INTEGRATION=1`, `FLEET_INTEGRATION=1`, `KAFKA_SOAK=1`, …) and
  skipped otherwise.
- **Grafana dashboards** (`dashboards/`) — channels, event sources, and
  WhatsApp service-window telemetry, querying the runtime's real metric
  names.
- **Prometheus alert rules** (`alerts/`) — six rule files; every alert
  carries a `runbook_url` into the docs-site runbook index. Note: the
  security and WhatsApp-window rule files include rules contracted on
  metrics the runtime does not emit yet (annotated in-file; tracked as
  POST_ENTERPRISE_BACKLOG #65).
- **Observability compose bundle** (`observability/`) — OTel collector +
  Prometheus + Jaeger + Grafana pre-wired for local tracing/metrics work.
- **Chaos + load harnesses** — event-loss, DLQ-rate, and latency assertion
  suites.

- Docs: <https://declaragent.dev>
- Repo: <https://github.com/declaragent/declaragent> (`packages/testkit`)
- License: Apache-2.0

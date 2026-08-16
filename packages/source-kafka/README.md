# @declaragent/source-kafka

Kafka event source adapter for [Declaragent](https://declaragent.dev) — the
declarative, git-versioned AI agent platform.

Installing this package next to `@declaragent/cli` makes the `kafka` source
type available: `declaragent up` auto-discovers installed
`@declaragent/source-*` adapters and binds every source declared in the
agent's `event-sources.yaml`.

```yaml
# event-sources.yaml
- type: kafka
  config:
    id: my-kafka-source
    # broker connection + topic/queue/subject config — see the docs
  delivery:
    mode: at-least-once
  target:
    type: skill
    name: my-skill
```

Covers: brokers, consumer groups, SASL/SCRAM + TLS, JSON-path routing, DLQ topic + redrive. The broker client (`kafkajs@^2.2.4`) ships as a regular dependency
of this package.

- Docs: <https://declaragent.dev> (Reference → agent.yaml / Cookbook)
- Repo: <https://github.com/declaragent/declaragent> (`packages/source-kafka`)
- License: Apache-2.0

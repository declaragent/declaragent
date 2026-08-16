# @declaragent/source-amqp

AMQP (RabbitMQ) event source adapter for [Declaragent](https://declaragent.dev) — the
declarative, git-versioned AI agent platform.

Installing this package next to `@declaragent/cli` makes the `amqp` source
type available: `declaragent up` auto-discovers installed
`@declaragent/source-*` adapters and binds every source declared in the
agent's `event-sources.yaml`.

```yaml
# event-sources.yaml
- type: amqp
  config:
    id: my-amqp-source
    # broker connection + topic/queue/subject config — see the docs
  delivery:
    mode: at-least-once
  target:
    type: skill
    name: my-skill
```

Covers: exchanges + routing keys, prefetch, DLX-friendly nack policies. The broker client (`amqplib@^0.10.4`) ships as a regular dependency
of this package.

- Docs: <https://declaragent.dev> (Reference → agent.yaml / Cookbook)
- Repo: <https://github.com/declaragent/declaragent> (`packages/source-amqp`)
- License: Apache-2.0

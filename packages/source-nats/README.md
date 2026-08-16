# @declaragent/source-nats

NATS + JetStream event source adapter for [Declaragent](https://declaragent.dev) — the
declarative, git-versioned AI agent platform.

Installing this package next to `@declaragent/cli` makes the `nats` source
type available: `declaragent up` auto-discovers installed
`@declaragent/source-*` adapters and binds every source declared in the
agent's `event-sources.yaml`.

```yaml
# event-sources.yaml
- type: nats
  config:
    id: my-nats-source
    # broker connection + topic/queue/subject config — see the docs
  delivery:
    mode: at-least-once
  target:
    type: skill
    name: my-skill
```

Covers: core-NATS subjects or durable JetStream consumers, queue groups. The broker client (`nats@^2.28.0`) ships as a regular dependency
of this package.

- Docs: <https://declaragent.dev> (Reference → agent.yaml / Cookbook)
- Repo: <https://github.com/declaragent/declaragent> (`packages/source-nats`)
- License: Apache-2.0

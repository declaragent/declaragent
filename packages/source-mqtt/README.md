# @declaragent/source-mqtt

MQTT event source adapter for [Declaragent](https://declaragent.dev) — the
declarative, git-versioned AI agent platform.

Installing this package next to `@declaragent/cli` makes the `mqtt` source
type available: `declaragent up` auto-discovers installed
`@declaragent/source-*` adapters and binds every source declared in the
agent's `event-sources.yaml`.

```yaml
# event-sources.yaml
- type: mqtt
  config:
    id: my-mqtt-source
    # broker connection + topic/queue/subject config — see the docs
  delivery:
    mode: at-least-once
  target:
    type: skill
    name: my-skill
```

Covers: QoS 0/1, shared subscriptions, wildcard topics. The broker client (`mqtt@^5.10.0`) ships as a regular dependency
of this package.

- Docs: <https://declaragent.dev> (Reference → agent.yaml / Cookbook)
- Repo: <https://github.com/declaragent/declaragent> (`packages/source-mqtt`)
- License: Apache-2.0

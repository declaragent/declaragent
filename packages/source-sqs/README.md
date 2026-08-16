# @declaragent/source-sqs

AWS SQS event source adapter for [Declaragent](https://declaragent.dev) — the
declarative, git-versioned AI agent platform.

Installing this package next to `@declaragent/cli` makes the `sqs` source
type available: `declaragent up` auto-discovers installed
`@declaragent/source-*` adapters and binds every source declared in the
agent's `event-sources.yaml`.

```yaml
# event-sources.yaml
- type: sqs
  config:
    id: my-sqs-source
    # broker connection + topic/queue/subject config — see the docs
  delivery:
    mode: at-least-once
  target:
    type: skill
    name: my-skill
```

Covers: standard + FIFO queues, at-least-once delivery, visibility-timeout handling. The broker client (`@aws-sdk/client-sqs@^3.645.0`) ships as a regular dependency
of this package.

- Docs: <https://declaragent.dev> (Reference → agent.yaml / Cookbook)
- Repo: <https://github.com/declaragent/declaragent> (`packages/source-sqs`)
- License: Apache-2.0

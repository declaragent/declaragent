# @declaragent/channel-slack

Slack channel adapter for [Declaragent](https://declaragent.dev) — the
declarative, git-versioned AI agent platform.

Installing this package next to `@declaragent/cli` makes the `slack` channel
type available: `declaragent up` starts every channel declared in
`channels.yaml`, routes inbound messages to skills via
`channels.json#inbound.routes`, and exposes outbound sends to the agent
through the `SendMessage` tool.

```yaml
# channels.yaml
- id: my-slack
  type: slack
  # credentials via ${env:...} refs — never inline tokens
```

Covers: Socket Mode (`botToken` + `appToken`) with signed-request webhook support; mentions + DMs in, `chat.postMessage` replies out.

- Docs: <https://declaragent.dev> (Reference → agent.yaml / Cookbook)
- Repo: <https://github.com/declaragent/declaragent> (`packages/channel-slack`)
- License: Apache-2.0

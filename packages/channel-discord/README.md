# @declaragent/channel-discord

Discord channel adapter for [Declaragent](https://declaragent.dev) — the
declarative, git-versioned AI agent platform.

Installing this package next to `@declaragent/cli` makes the `discord` channel
type available: `declaragent up` starts every channel declared in
`channels.yaml`, routes inbound messages to skills via
`channels.json#inbound.routes`, and exposes outbound sends to the agent
through the `SendMessage` tool.

```yaml
# channels.yaml
- id: my-discord
  type: discord
  # credentials via ${env:...} refs — never inline tokens
```

Covers: Gateway connection; mentions + DMs in, replies + reactions out.

- Docs: <https://declaragent.dev> (Reference → agent.yaml / Cookbook)
- Repo: <https://github.com/declaragent/declaragent> (`packages/channel-discord`)
- License: Apache-2.0

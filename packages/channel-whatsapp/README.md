# @declaragent/channel-whatsapp

WhatsApp (Meta Cloud API) channel adapter for [Declaragent](https://declaragent.dev) — the
declarative, git-versioned AI agent platform.

Installing this package next to `@declaragent/cli` makes the `whatsapp` channel
type available: `declaragent up` starts every channel declared in
`channels.yaml`, routes inbound messages to skills via
`channels.json#inbound.routes`, and exposes outbound sends to the agent
through the `SendMessage` tool.

```yaml
# channels.yaml
- id: my-whatsapp
  type: whatsapp
  # credentials via ${env:...} refs — never inline tokens
```

Covers: Cloud API webhook in, template + session messages out, 24-hour service-window awareness.

- Docs: <https://declaragent.dev> (Reference → agent.yaml / Cookbook)
- Repo: <https://github.com/declaragent/declaragent> (`packages/channel-whatsapp`)
- License: Apache-2.0

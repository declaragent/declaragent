# Declaragent

Declarative, git-versioned AI agent platform. An agent is a stable
runtime core plus a declarative `agent.yaml` that lives in your repo
alongside the code it automates.

It is an unusually thoughtful declarative agent runtime with serious primitives
— hash-chained audit, multi-tenant isolation, MCP, and broker-backed agent RPC —
currently at `0.x` and seeking its first adopters. It is **not** a finished
enterprise product; see [Status & honesty](#status--honesty) below.

- **Website:** [declaragent.dev](https://declaragent.dev)
- **Packages:** [`@declaragent/*`](https://www.npmjs.com/org/declaragent) on npm
- **Source:** [github.com/declaragent/declaragent](https://github.com/declaragent/declaragent)
- **CLI:** installs as `declaragent` (primary) and `d9t` (alias);
  [d9t.dev](https://d9t.dev) is an alias domain.

## Quickstart

```bash
npm install -g @declaragent/cli
declaragent init                       # pick a single-agent template
declaragent init --fleet my-fleet      # or scaffold a multi-agent fleet
declaragent fleet run                  # dev loop for a fleet
```

See [declaragent.dev/quickstart](https://declaragent.dev/quickstart)
for the full walkthrough.

## What ships

- **Runtime core** — engine loop, built-in tools (Read / Write / Edit /
  Glob / Grep / Bash / Agent — plus SendMessage when channels are
  configured), permission gate, session persistence, sub-agents, slash
  commands.
- **Event sources** — cron, webhook, file-watch, plus broker adapters
  for Kafka, NATS, MQTT, AMQP, SQS. DLQ + replay (Kafka); config changes
  apply on restart (`declaragent down && up -d`).
- **Channels** — Slack, Telegram, Discord, WhatsApp.
- **Multi-tenant** — per-tenant quotas, audit with hash-chain, Vault /
  AWS-SM / GCP-SM / K8s secret providers, Prometheus metrics.
- **Agent RPC** — typed request/response between agents over Kafka or
  NATS from `fleet.yaml` (JetStream/SQS/AMQP/MQTT via the
  `plugin-agent-rpc` library factories). Memory transport for dev.
- **Fleet** — one `fleet.yaml` declares N agents; `fleet run`
  hosts them together; `fleet deploy` rolls them out atomically.

## Built with AI assistance

A substantial share of this codebase is co-authored by Claude (Anthropic) under
a single human reviewer, who is the accountable owner and final quality gate for
every change that lands. This is disclosed, not hidden — see the AI-authorship
note in [GOVERNANCE.md](./GOVERNANCE.md) and the project memory in
[CLAUDE.md](./CLAUDE.md).

## Development

- [Bun](https://bun.sh) ≥ 1.1.0
- TypeScript 5.7 strict
- Biome for lint/format

```bash
bun install
bun run typecheck
bun test
bun run build
bun run lint
```

## Contributing

See `CONTRIBUTING.md`.

## Status & honesty

This is a `0.x` project with serious primitives but no third-party security
review yet and no published outside production users. For the evidence-backed
capability ledger see
[docs/FIRST_PRINCIPLES_VALIDATION.md](./docs/FIRST_PRINCIPLES_VALIDATION.md) and
[AGENTS.md](./AGENTS.md); to report a vulnerability see
[SECURITY.md](./SECURITY.md).

## License

Apache 2.0.

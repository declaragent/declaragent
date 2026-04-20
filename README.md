# Declaragent

Declarative, git-versioned AI agent platform. An agent is a stable
runtime core plus a declarative `agent.yaml` that lives in your repo
alongside the code it automates.

- **Website:** [declaragent.dev](https://declaragent.dev)
- **Packages:** [`@declaragent/*`](https://www.npmjs.com/org/declaragent) on npm
- **Source:** [github.com/declaragent/declaragent](https://github.com/declaragent/declaragent)

## Quickstart

```bash
npm install -g @declaragent/cli
declaragent init                       # pick a single-agent template
declaragent init --fleet my-fleet      # or scaffold a multi-agent fleet
declaragent fleet run                  # dev loop for a fleet
```

See [declaragent.dev/quickstart](https://declaragent.dev/quickstart)
for the full walkthrough.

## What ships in 0.1.0

- **Runtime core** — engine loop, built-in tools (Read / Write / Edit /
  Glob / Grep / Bash / Agent / SendMessage), permission gate, session
  persistence, sub-agents, slash commands.
- **Event sources** — cron, webhook, file-watch, plus broker adapters
  for Kafka, NATS, MQTT, AMQP, SQS. DLQ + replay + hot reload.
- **Channels** — Slack, Telegram, Discord, WhatsApp.
- **Multi-tenant** — per-tenant quotas, audit with hash-chain, Vault /
  AWS-SM / GCP-SM / K8s secret providers, Prometheus metrics.
- **Agent RPC** (v1.1) — typed request/response between agents over
  any broker. Memory transport for dev.
- **Fleet** (v1.2) — one `fleet.yaml` declares N agents; `fleet run`
  hosts them together; `fleet deploy` rolls them out atomically.

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

## License

Apache 2.0.

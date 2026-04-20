# Templates

Starter packs for `declaragent init`. Each directory is a fully-
specified agent that `declaragent init --template <name>` unpacks
into the user's project directory.

## Catalog

| Template | What it demonstrates | Inbound | Outbound |
| -------- | -------------------- | ------- | -------- |
| [`concierge`](./concierge) | Minimal Slack Q&A bot (Socket Mode, provider-default tools) | Slack `@mention` + DM | Slack reply |
| [`oncall-escalator`](./oncall-escalator) | Webhook source + idempotency key + outbound SendMessage | Alertmanager webhook | Slack DM |
| [`pr-review`](./pr-review) | Plugin-contributed tool via `@declaragent/plugin-github` | GitHub webhook | GitHub review |
| [`kafka-pipeline`](./kafka-pipeline) | Kafka source + DLQ + daily token budget | `orders.created` topic | `orders.enriched` topic |
| [`multi-tenant-starter`](./multi-tenant-starter) | Two tenants on one daemon, scoped extensions + quotas | Slack (per-tenant) | Slack (per-tenant) |
| [`rpc-client`](./rpc-client) / [`rpc-server`](./rpc-server) | Paired agents exchanging typed requests via `agent-rpc` | In-process user prompt | `RequestAgent` → peer `ctx.respond` |

## How these are used

`declaragent init` (Phase 7 slice 4) unpacks one of these directories
into the user's project directory. The templates' YAML + skill files
are bundled into the `declaragent` binary at build time, so the wizard
can unpack without a network call.

Each template follows the same layout:

```
templates/<name>/
├── agent.yaml
├── channels.yaml            # only when the template uses a channel
├── tenants.yaml             # only for multi-tenant-starter
├── event-sources.yaml       # only when the template listens for events
├── .env.example
├── README.md                # written to project root on unpack
├── skills/
│   └── <skill>.md
└── plugin-manifest.json     # when plugins are required (pr-review)
```

## Verifying

Run the shared verifier locally before editing:

```sh
bun run scripts/verify-templates.ts
```

The same script runs in CI via
`.github/workflows/templates-verify.yml`. Any YAML that fails to parse,
missing skill file, or `.env.example` drift fails the gate.

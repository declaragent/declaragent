# CLAUDE.md

Project memory for Declaragent. Read this first when starting work here.

- **Name:** Declaragent (official).
- **Domain:** [declaragent.dev](https://declaragent.dev)
- **npm scope:** [`@declaragent/*`](https://www.npmjs.com/org/declaragent) — 13 packages on npm. CLI ships independently; latest published `@declaragent/cli@0.6.0` (2026-04-22; `npm view @declaragent/cli dist-tags` → `latest: 0.6.0`). Companion bumps: `core@0.4.0`, `plugin-agent-rpc@3.0.0`, `testkit@3.0.0`, all channel-* + source-* packages at `3.0.0` (peer-dep cascade from core's semver-major-in-0.x).
- **GitHub org:** `declaragent`.
- **Theme:** *an agent for enterprises to build and manage fleets of agents.* Declaragent itself is an agent — same core, same tools, same audit — that helps operators author + run everyone else's agents.
- **Honest capability status:** see **[AGENTS.md](./AGENTS.md)** for the feature-level ledger. For the intent→code audit ("does the first-principles vision actually work at production scale?") see **[docs/FIRST_PRINCIPLES_AUDIT.md](./docs/FIRST_PRINCIPLES_AUDIT.md)**. This file is a project-orientation guide, not a status dashboard.

## What this project is

Declaragent is a declarative, git-versioned AI agent platform. An agent = immutable runtime **core** + git-versioned declarative **configuration** (`agent.yaml`: identity, tools, skills, plugins, event sources, channels, permissions, secrets, deployment).

The reference implementation archive — the leaked Claude Code source — lives at `/Users/ssvk/Documents/GitHub/claude-code/` and is read-only. Treat it as a study/reference codebase, not a dependency.

## Canonical plan

`docs/SPEC_AND_PLAN.md` is the source of truth for requirements and phased implementation. It supersedes the 8 background design docs (also in `docs/`), which are kept for historical context only.

When the plan and a background doc disagree, `SPEC_AND_PLAN.md` wins.

## First-principles scoreboard

A fleet of agents has four pillars. Current state (see `docs/FIRST_PRINCIPLES_AUDIT.md` for evidence + per-row detail):

| Pillar | Single-machine | Enterprise (multi-host, soak-proven, SSO/SIEM/GitOps) |
| --- | --- | --- |
| 1 · Define agents (capabilities, skills, inbound/outbound channels, peers) | ✅ | 🟡 — typed capabilities + SSO-bridged channel permissions pending |
| 2 · Deploy + monitor fleet (up/down/ps/logs + Prometheus + OTel + canary) | ✅ | 🟡 — no managed control plane, no traffic-splitting canary, audit is local SQLite |
| 3 · Independent agents with optional delegation (memory + Kafka RPC) | ✅ | 🟡 — Kafka transport shipped 0.6.0, soak pending; NATS/SQS/AMQP/MQTT factories missing |
| 4 · Tools + MCP (7 built-ins + MCP stdio/HTTP/SSE/OAuth PKCE + plugins) | ✅ | 🟡 — no per-tool rate limit, no approval-workflow integration, no auto-recovery for crashed MCP |

**Single-machine production: ✅** ready with 0.6.0 staged — a single host running `declaragent up -d`, webhook/cron in, Claude + MCP tools + Slack/Telegram/Discord/WhatsApp in/out, `/metrics` + OTel + circuit breakers + rate limits + dispatch DLQ all on by default.

**Enterprise production: 🟡** roughly 10–12 focused engineer-weeks of *integration* work (not new architecture):
1. Finish Kafka soak (Slice 7 tail) + NATS factory — unblocks cross-host + non-Kafka customers.
2. OIDC/OAuth2 on RPC envelopes (`RpcAuth` shape exists, provider implementations don't).
3. Managed control plane — aggregator over N `up` processes. **Needs its own plan doc.**
4. GitOps `fleet render` + SIEM audit export.

See `docs/FIRST_PRINCIPLES_AUDIT.md` §"Cross-pillar: what's honestly missing" for the full ranked list.

---

## Current status (verified 2026-04-22, @declaragent/cli@0.6.0 live on npm)

**What works end-to-end** (production-usable single-machine path):
- `declaragent init` → scaffold with `agent.yaml` + skills + `event-sources.yaml`
- `declaragent auth login` → OpenRouter / Anthropic / env-var credentials
- `declaragent up [-d]` → binds sources (webhook/cron/file-watch + any installed `@declaragent/source-*`), routes events to skills, LLM turn runs, outcome recorded. Runtime now threads a shared `PrometheusRegistry` + optional OTel tracer into every source + channel, wraps the provider with a token-bucket rate limiter, and applies per-skill circuit breakers. See §"0.6.0 staged" below.
- `declaragent ps / logs / down` → lifecycle verbs
- `declaragent events list / audit verify / dlq list` → observability backed by SQLite with hash-chained audit. `events list --state circuit-open` + `dlq list/show/drop --kind dispatch` shipped in 0.6.0.
- `declaragent deploy gcp-cloud-run` → generates Dockerfile + service.yaml (user runs `gcloud` themselves)
- `declaragent fleet deploy --canary --canary-wait-ms <n>` → canary strategy with post-soak re-probe (0.6.0 Slice 8)
- Builder toolkit (`DECLARAGENT_BUILDER=on`): conversational authoring for skills, sources, channels, MCP, plugins, secrets, peers, fleet-add

**0.6.0 shipped** (published 2026-04-22 via local `bun run release` after org-level Actions write-restriction blocked the changesets/action auto-PR path; tags pushed to origin):
- Prometheus `/metrics` endpoint on `127.0.0.1:9464` when `-d`
- OpenTelemetry auto-enable when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- Per-skill circuit breakers (10 failures → 30s cooldown → half-open probe)
- Provider rate limits (Anthropic 50rps / OpenRouter 20rps / 10rps default)
- Dispatch DLQ **tracking** in `rejected_events` — active requeue is a 0.6.x follow-up
- Inbound channels → skills via `channels.json#inbound.routes` (Slack/Telegram/Discord/WhatsApp)
- Kafka RPC transport (`createKafkaTransport`) + nightly fleet integration CI — soak proof pending
- Canary fleet deploys with configurable soak window

**See [AGENTS.md](./AGENTS.md)** for the full evidence-backed matrix with file:line references. If you're about to promise a user a capability, verify against AGENTS.md first.

**Next priorities after 0.6.0 publishes** (ordered by leverage):
1. Dispatch-DLQ active requeue — needs a control socket on `up` (~1 day once the socket exists)
2. Full `fleet run` boot over Kafka with mocked LLM handlers — closes Slice 7's soak gap
3. NATS / SQS / AMQP / MQTT RPC transport factories — same pattern as `createKafkaTransport`
4. Broker-specific fleet integration tests (beyond Kafka)
5. v1.1 Agent Graph — schema work for typed capabilities per `AGENT_RPC_PLAN.md`

## Stack

- **Runtime + package manager + test runner:** Bun (≥ 1.1)
- **Workspaces:** Bun workspaces (not pnpm/Turbo)
- **Lint + format:** Biome 1.9.4
- **Types:** TypeScript 5.7, strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
- **Versioning:** changesets
- **LLM:** Anthropic Claude (Opus/Sonnet/Haiku) at v1.0; other providers later

## Conventions

- Imports from sibling source files use `.js` extension (TS resolves, Bun and bundlers handle at runtime).
- No `any` escape hatches without discussion.
- Tests colocated with source: `foo.ts` + `foo.test.ts`.
- Run `bun run lint:fix` before committing.
- Never commit `node_modules`, `dist`, or `.env*` (except `.env.example`).
- Lockfile (`bun.lock`) is committed.

## Dev loop

```bash
bun install
bun run typecheck
bun test
bun run build
bun run lint
```

CI runs all of the above plus `npm publish --dry-run` on every package.

## Repository layout

```
declaragent/
├── packages/            # 13 published packages
│   ├── core/            # @declaragent/core — runtime core
│   ├── cli/             # @declaragent/cli — interactive REPL + fleet verbs
│   ├── plugin-agent-rpc/
│   ├── testkit/
│   ├── source-{kafka,nats,mqtt,amqp,sqs}/
│   └── channel-{slack,telegram,discord,whatsapp}/
├── templates/           # init/fleet-add starter packs
│   └── fleet-starter/   # two-agent fleet reference
├── docs/                # SPEC_AND_PLAN.md + FLEET_PLAN.md + 8 bg design docs
├── docs-site/           # Docusaurus site published to declaragent.dev
├── .changeset/          # pending version bumps
├── .github/workflows/   # ci.yml, release.yml
├── tsconfig.base.json   # strict TS shared config
└── biome.json
```

## Open decisions (from SPEC_AND_PLAN.md § Part 7)

- **License** — Apache 2.0 is provisional; BSL also on the table.
- **Governance / commercial model / first design partners** — deferred.

## Gotchas

- Bun supports `.ts` imports natively, but TypeScript's `verbatimModuleSyntax` requires imports to use `.js` extensions (the emitted form). Don't "fix" these — they're correct.
- `@biomejs/biome` is pinned to an exact version (`1.9.4`) so formatter output is stable in CI.
- `packages/core/tsconfig.build.json` excludes `*.test.ts`; test files are typechecked but not published.

## The reference archive

`/Users/ssvk/Documents/GitHub/claude-code/` contains the leaked Claude Code source. Useful for:
- Understanding how the `Tool` contract, permission gate, and `QueryEngine` actually work in a production agent.
- Copying *patterns* (not code — licensing is unclear).

That repo's own `CLAUDE.md` warns it's read-only and has no `package.json`. Respect that.

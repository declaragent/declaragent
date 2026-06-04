# The Master Plan

The unified implementation plan. Consolidates everything from the eight preceding documents into one actionable roadmap from `git init` to v2.0 cloud-deployment GA.

> **If you read one doc, read this one.** The others are references.

**The goal**: a user installs `my-agent`, answers a few questions, and ends up with a working agent — local or cloud-deployed — that handles their events, channels, skills, sub-agents, and plugins, all configured conversationally. No code required. No cloud consoles required. No Docker, Kubernetes, or Terraform required.

---

## Table of Contents

1. [The Vision in One Page](#1-the-vision-in-one-page)
2. [The Ten Phases — At a Glance](#2-the-ten-phases--at-a-glance)
3. [The Canonical User Journey](#3-the-canonical-user-journey)
4. [Unified Architecture Map](#4-unified-architecture-map)
5. [Decisions to Make Before Phase 0](#5-decisions-to-make-before-phase-0)
6. [Monorepo Layout (Target State)](#6-monorepo-layout-target-state)
7. [Phase-By-Phase Detail](#7-phase-by-phase-detail)
8. [Dependency Graph & Parallelization](#8-dependency-graph--parallelization)
9. [Release Train](#9-release-train)
10. [Team Composition & Sprint Cadence](#10-team-composition--sprint-cadence)
11. [Week-By-Week for Phase 0–1 (Concrete Kickoff)](#11-week-by-week-for-phase-01-concrete-kickoff)
12. [Quality Gates & Definition of Done](#12-quality-gates--definition-of-done)
13. [Cross-Cutting Concerns](#13-cross-cutting-concerns)
14. [Consolidated Risk Register](#14-consolidated-risk-register)
15. [Launch Checklist](#15-launch-checklist)
16. [Success Metrics](#16-success-metrics)
17. [First-Day Punchlist](#17-first-day-punchlist)

---

## 1. The Vision in One Page

**One CLI. Many capabilities. Hidden complexity.**

```bash
# Day 1: install
$ npm i -g my-agent
$ my-agent                                  # REPL launches; pastes API key

# Day 2: extend locally
$ my-agent skill new pr-review              # scaffold a skill
$ my-agent mcp add github                   # wire in a GitHub MCP server
$ my-agent plugin install @my-agent/plugin-git-helper

# Day 3: add triggers & channels
$ my-agent trigger add --cron "0 9 * * 1-5" --skill standup
$ my-agent channel add slack                # wizard walks through OAuth
$ my-agent event-source add kafka \
    --brokers kafka1:9092 --topics orders.placed

# Day 4: go cloud
$ my-agent
builder> I want this running 24/7 on cheap infra.
         I'll deploy to Cloud Run. Estimated cost: $3/mo. OK?
you> yes
builder> [builds container, pushes, deploys, wires webhooks, runs smoke test]
         Deployed. Logs: my-agent logs <name>

# Day 5+: operate
$ my-agent status
$ my-agent logs my-bot --follow
$ my-agent cost
$ my-agent update my-bot
$ my-agent rollback my-bot
```

Every step above is **conversation-friendly** (the Builder agent walks non-expert users through it) and **scriptable** (CI/CD can drive the same CLI). The user never writes a Dockerfile, never touches IAM policies, never learns a cloud console.

---

## 2. The Ten Phases — At a Glance

| # | Phase | Duration | Doc reference | Exit criteria |
|---|---|---|---|---|
| 0 | Foundations | 1-2w | — | Monorepo, CI, release pipeline green |
| 1 | Core Agent | 4-6w | BUILDING | Daily-drivable local REPL with tools + permissions + sub-agents |
| 2 | Extensibility | 4-6w | EXTENDING | MCP + plugins + skills + hooks installable without code |
| 3 | Event-Driven Core | 3-4w | EVENT_DRIVEN | Webhooks, cron, file-watch, daemon, mailbox |
| 4 | Scale Event Sources | 4-6w | EVENT_SOURCE_REGISTRY | Kafka, SQS, MQTT as installable packages |
| 5 | Communication Channels | 5-7w | COMMUNICATION_CHANNELS | Telegram, Slack, Discord, WhatsApp |
| 6 | Operations Hardening | 3-4w | — | 7-day soak, SOC2-ready security, multi-tenant |
| 7 | Distribution (Local GA) | 2-3w | — | Installers, templates, docs; **v1.0 ships** |
| 8 | Deployment Engine Core | 5-7w | AGENT_BUILDING | Single-provider (GCP) deploy end-to-end |
| 9 | Multi-Provider & Builder | 5-7w | AGENT_BUILDING | AWS, CF, Fly, Azure, K8s + conversational Builder |
| 10 | Deployment GA | 2-3w | — | Cost estimator, governance, docs; **v2.0 ships** |

**Timeline**: 40-55 weeks (~10-13 months) for v1.0 + v2.0 with a 3-engineer team. Compressible to ~8 months with 5 engineers after Phase 2 (when parallelization opens up).

---

## 3. The Canonical User Journey

The UX is the contract. Everything else is in service of making each step below actually work.

### Install (60 seconds)

```bash
curl -fsSL https://my-agent.sh/install | sh
# or
npm i -g my-agent
# or
brew install my-agent
```

### First run (2 minutes)

```
$ my-agent
┌──────────────────────────────────────────────┐
│ Welcome to my-agent                           │
│ No API key found.                             │
│ Paste Anthropic API key:                      │
│ > sk-ant-...                                  │
│ ✓ Saved to keychain                           │
│                                               │
│ What do you want to build?                    │
│   ❯ Personal CLI assistant                    │
│     Team assistant (Slack/GitHub)             │
│     Multi-channel bot                         │
│     Ops automation                            │
│     Full platform                             │
│     Custom / explore                          │
└──────────────────────────────────────────────┘
```

### Configure (through conversation or commands)

Either path works, same outcome:

**Conversation**:
```
you> add a github integration so I can ask about my PRs

builder> Installing @my-agent/plugin-github...
         Need a GitHub token with repo scope. Generate one at
         https://github.com/settings/tokens?scopes=repo
         Paste here: █
         ✓ Stored securely.
         You can now ask things like "show me open PRs on my/repo"
```

**Commands**:
```bash
my-agent plugin install @my-agent/plugin-github
my-agent secret set github-token
```

### Add triggers, channels, skills — all configurable, all scriptable

```bash
my-agent skill new pr-summary
my-agent trigger add --webhook --path /hooks/gh --skill pr-summary
my-agent channel add slack
my-agent event-source add kafka --topic orders
```

### Test locally

```bash
my-agent test pr-summary --payload fixtures/sample-pr.json
my-agent daemon start --local     # run as background service on this machine
```

### Go cloud

```bash
my-agent
builder> I need this running when my laptop is off.
         Deploying to Cloud Run (us-central1), ~$3/mo.
         Will you approve creating:
           - GCP project "my-agent-prod"
           - 3 secrets in Secret Manager
           - 1 Cloud Run service
           - 1 GitHub webhook
         [Y/n] y
         [... 90 seconds of narrated progress ...]
         ✓ Deployed. Test: push a PR.
         ✓ Webhook registered. Pointing at live URL.
         ✓ Slack app installed. Bot active in #eng-reviews.

you> how do I check logs later?

builder> Run `my-agent logs pr-summary --follow`.
         For more: `my-agent help`.
```

### Operate

```bash
my-agent list                       # all agents, local and cloud
my-agent status pr-summary           # health, cost, recent events
my-agent logs pr-summary --follow    # stream
my-agent update pr-summary           # push new spec version
my-agent rollback pr-summary         # instant revert
my-agent cost                        # spend breakdown
my-agent destroy pr-summary          # clean teardown
```

That journey is the **acceptance test** for the whole platform. Every phase either moves us closer to it or it shouldn't ship.

---

## 4. Unified Architecture Map

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLI (my-agent binary)                         │
│       Commands · Wizard · Builder REPL · Admin tools             │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┼─────────────────────┐
        │                    │                     │
    ┌───▼────┐       ┌───────▼────────┐       ┌────▼──────────┐
    │ Builder│       │  Runtime Mode   │      │ Deployment    │
    │  Mode  │       │  (same binary)  │      │ Engine        │
    └───┬────┘       └────────┬────────┘      └───┬───────────┘
        │                     │                   │
        │            ┌────────▼────────┐     ┌────▼─────────┐
        │            │  Core Engine     │     │ Providers    │
        │            │  · runAgent()    │     │ aws/gcp/azure│
        │            │  · Tools         │     │ cf/fly/k8s   │
        │            │  · Permissions   │     └──────────────┘
        │            │  · Streaming     │
        │            └────────┬────────┘
        │                     │
        │       ┌─────────────┼─────────────┐
        │       │             │             │
        │   ┌───▼───┐    ┌────▼───┐    ┌───▼────┐
        │   │ Event │    │Extens- │    │Channels│
        │   │  Bus  │    │ ions   │    │        │
        │   └───┬───┘    └────┬───┘    └───┬────┘
        │       │             │            │
        │   Sources:      Plugins:      Adapters:
        │   cron          MCP           Slack
        │   webhook       Skills        Discord
        │   file          Sub-agents    Telegram
        │   kafka/mqtt/    Hooks        WhatsApp
        │   amqp/sqs/...
        │
        └─► Builder talks to deployed runtimes via control plane (JWT + HTTPS)
```

**Three axes of extensibility:**

1. **Ingress** (who/what triggers the agent): event sources + channels
2. **Capability** (what the agent can do): tools + MCP + skills + plugins + sub-agents
3. **Target** (where it runs): local daemon + N cloud providers

Every axis uses the **same pattern**: contract + registry + lifecycle + scoped permissions + declarative config.

---

## 5. Decisions to Make Before Phase 0

Lock these in week 0. Changing them later costs multiples.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Runtime | **Node 22 LTS** (consider Bun 1.x) | Node: mature ecosystem, Windows support. Bun: faster but younger. Node safer default; Bun optional compile-target for perf-critical binaries |
| 2 | Language | **TypeScript strict** | Types catch 30% of bugs; required for public API stability |
| 3 | Package manager | **pnpm** | Monorepo-friendly, fast, disk-efficient |
| 4 | Build system | **Turborepo** | Caching, pipeline graph, well-supported |
| 5 | Schema validation | **Zod v4** | Used in Claude Code reference; great TS inference |
| 6 | Config format | **YAML** primary, JSON for auto-gen | User-facing readability beats JSON |
| 7 | CLI framework | **commander.js** | Simple, stable, used in reference |
| 8 | Terminal UI | **Ink 6 (public)** | Don't write our own; ship faster |
| 9 | Default LLM | **Anthropic Claude** | Primary target; keep abstraction for others |
| 10 | MCP SDK | **@modelcontextprotocol/sdk** | Official, widely used |
| 11 | Test runner | **Vitest** | Fast, TS-native, jest-compatible |
| 12 | Mono layout | **pnpm workspaces + Turbo** | Industry standard for our scale |
| 13 | License | **Apache 2.0** | Permissive, patent grant, enterprise-friendly |
| 14 | Release model | **Changesets + SemVer** | Every package versions independently |
| 15 | Config schema v | **SemVer from v1.0 only** | Break freely in 0.x; migrations mandatory after |
| 16 | State store (remote) | **S3 + DynamoDB lock** default; **GCS** + **Azure Blob** alternates | Industry standard; all providers supported |
| 17 | Observability | **OTel everywhere** | One wire format, multiple backends |
| 18 | Security bar | **Least-privilege by default, opt-in bypass** | Refuse plaintext secrets; keychain required |
| 19 | IDE support | **VS Code, JetBrains** later (Phase 7+) | Don't block v1.0 |
| 20 | Voice I/O | **MCP-based** (Whisper/ElevenLabs servers) | No built-in audio; keep core lean |

These decisions should be captured in a repo-level `ADR/` (Architecture Decision Records) directory from day one.

---

## 6. Monorepo Layout (Target State)

```
my-agent/
├── packages/
│   ├── core/                           # Engine, tools, permissions
│   ├── cli/                            # Commander + Ink REPL + Builder mode
│   ├── daemon/                         # Long-running server
│   ├── sdk/                            # Programmatic embedding
│   ├── testkit/                        # Test harness (mock LLM, fake MCP, replay)
│   │
│   ├── registry/                       # Extension registries (tool, plugin, skill, source, channel)
│   ├── mcp-client/                     # MCP client implementation
│   ├── skills-runtime/
│   ├── plugin-loader/
│   │
│   ├── events/                         # Bus, dispatcher, session manager, normalizer
│   ├── deployment/                     # Engine, state store, plan/apply
│   ├── observability/                  # OTel wiring, cost tracking
│   │
│   ├── tools-builtin/                  # Bash/Read/Write/Edit/Grep/Glob/Agent/Skill
│   │
│   # Event sources (pluggable) — each its own npm package
│   ├── source-cron/                    # bundled
│   ├── source-webhook/                 # bundled
│   ├── source-file/                    # bundled
│   ├── source-kafka/
│   ├── source-sqs/
│   ├── source-mqtt/
│   ├── source-amqp/
│   ├── source-nats/
│   ├── source-redis-streams/
│   ├── source-kinesis/
│   ├── source-pulsar/
│   ├── source-gcp-pubsub/
│   ├── source-azure-sb/
│   ├── source-cdc/
│   ├── source-imap/
│   ├── source-s3-notify/
│   │
│   # Channels (pluggable)
│   ├── channel-telegram/
│   ├── channel-slack/
│   ├── channel-discord/
│   ├── channel-whatsapp/
│   │
│   # Cloud providers (pluggable)
│   ├── provider-gcp/
│   ├── provider-aws/
│   ├── provider-azure/
│   ├── provider-cloudflare/
│   ├── provider-fly/
│   ├── provider-kubernetes/
│   ├── provider-docker/
│   │
│   # Built-in plugins
│   ├── plugin-builder/                 # Deployment tools for Builder mode
│   ├── plugin-git-helper/
│   ├── plugin-github/
│   │
│   ├── template-packs/                 # Starter configs for `my-agent init`
│   └── schemas/                        # Shared Zod/JSONSchema definitions
│
├── apps/
│   ├── docs/                           # Docusaurus site
│   └── web/                            # Later: web REPL
│
├── examples/                           # Reference specs for common patterns
├── scripts/                            # Build, release, migrate, reproduce
├── ADR/                                # Architecture decision records
├── .github/
│   └── workflows/                      # CI/CD
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── package.json
```

Over 40 packages at steady state. Most are small (500-1500 LOC each). The core 5 (core, cli, events, registry, testkit) are larger (3-8K LOC each).

---

## 7. Phase-By-Phase Detail

Each phase below has: goal, milestones (with days estimate), dependencies, exit criteria.

### Phase 0 — Foundations (1-2 weeks)

**Goal**: repo exists, CI passes, releases cut cleanly. No code shipped yet.

| Milestone | Days | Owner |
|---|---|---|
| 0.1 Monorepo scaffold (pnpm + Turbo) | 2 | Lead |
| 0.2 TS project refs + strict config | 1 | Lead |
| 0.3 Lint + commit hooks + formatting | 1 | Lead |
| 0.4 CI: test/build/typecheck matrix (Node 22, Windows+macOS+Linux) | 2 | Lead |
| 0.5 Release pipeline (changesets → npm publish) | 2 | Lead |
| 0.6 Templates: issues, PRs, CODEOWNERS, SECURITY.md | 1 | Lead |
| 0.7 Initial ADRs (the 20 decisions from §5) | 1 | Lead |

**Exit**: empty scoped package publishes to npm registry; all CI green on push.

---

### Phase 1 — Core Agent (4-6 weeks)

**Goal**: daily-drivable local REPL that feels complete.

| Milestone | Days | Notes |
|---|---|---|
| 1.1 LLM client wrapper + retry + streaming | 3 | Anthropic SDK; abstract for future providers |
| 1.2 `runAgent()` async generator | 4 | Event types, stop conditions, token accounting |
| 1.3 Tool interface + `ToolRegistry` | 3 | See BUILDING §3 |
| 1.4 Built-in tools: Bash, Read, Write, Edit | 4 | With validation, permissions hooks |
| 1.5 Built-in tools: Grep, Glob | 2 | Using ripgrep / fast-glob |
| 1.6 Tool dispatcher (read/write batching) | 3 | Critical for parallel reads |
| 1.7 `PermissionContext`, rules, modes | 4 | `default`/`plan`/`bypass`/`auto` |
| 1.8 `resolvePermission()` choke point + denial escalation | 2 | Fuzz-tested from day 1 |
| 1.9 Ink REPL: app shell, message list, input | 4 | |
| 1.10 Permission modal (Ink component) | 2 | |
| 1.11 Tool progress display + streaming rendering | 3 | |
| 1.12 Ctrl+C cancellation (AbortSignal propagation) | 2 | |
| 1.13 Session transcript persistence (JSONL) | 2 | Fire-and-forget |
| 1.14 `/resume`, `/clear`, `/cost`, `/memory` | 3 | |
| 1.15 Global + project memory injection | 2 | `MEMORY.md` loader |
| 1.16 Sub-agents via `AgentTool` | 3 | Context isolation, transcript, abort prop |
| 1.17 Dogfooding week | 5 | Team uses it for real work |

**Exit**: 3+ team members use it as their daily driver for a week without pain points that prevent use.

---

### Phase 2 — Extensibility (4-6 weeks)

**Goal**: users can install third-party capabilities without touching code.

| Milestone | Days | Notes |
|---|---|---|
| 2.1 MCP client: stdio, JSON-RPC framing | 5 | |
| 2.2 MCP handshake + `tools/list` discovery | 2 | |
| 2.3 MCP tool wrapping + namespace prefixing | 3 | `mcp__<server>__<tool>` |
| 2.4 MCP resources + elicitation | 3 | |
| 2.5 MCP auto-restart with backoff | 2 | |
| 2.6 MCP HTTP transport | 3 | Lower priority |
| 2.7 Skill loader (MD + frontmatter) | 3 | |
| 2.8 Skill three-tier search paths | 1 | Project > user > bundled |
| 2.9 Template substitution + validation | 2 | |
| 2.10 `SkillTool` for model invocation | 2 | |
| 2.11 Skill-as-slash-command binding | 2 | |
| 2.12 Hook registry + phases | 3 | preToolUse/postToolUse/preLLMCall |
| 2.13 Plugin manifest schema + compat check | 2 | |
| 2.14 Plugin consent flow | 2 | Show declared perms |
| 2.15 Plugin loader + scoped registries | 4 | Clean unload via tags |
| 2.16 Plugin hot reload | 2 | Require-cache bust |
| 2.17 Bundled plugin: `git-helper` | 3 | First reference plugin |
| 2.18 CLI: `plugin` `mcp` `skill` `rules` subcommands | 5 | |

**Exit**: user installs `@my-agent/plugin-github`, adds a GitHub MCP server, writes a `pr-review.md` skill — all via CLI commands + docs, no source code access.

---

### Phase 3 — Event-Driven Core (3-4 weeks)

**Goal**: user input becomes one event source among many. Daemon mode works.

| Milestone | Days | Notes |
|---|---|---|
| 3.1 `EventBus` (pub/sub + history + wildcards) | 3 | |
| 3.2 `AgentEvent` schema | 2 | See EVENT_DRIVEN §3 |
| 3.3 `EventDispatcher` routing | 4 | inject/new-session/skill/sub-agent/broadcast |
| 3.4 Refactor REPL: input → event → dispatcher | 3 | Zero user-visible regression |
| 3.5 Cron source + `/trigger` admin | 2 | |
| 3.6 `ScheduleWakeup` tool + self source | 2 | Autonomous loops |
| 3.7 Webhook source (Express) + HMAC verify | 4 | Per-trigger perm scopes |
| 3.8 Webhook rate limiting + idempotency | 2 | |
| 3.9 File watch source (chokidar) | 2 | Debounced |
| 3.10 Mailbox + `SendMessage` tool | 3 | Inter-agent |
| 3.11 Daemon mode: long-running process | 3 | |
| 3.12 Control socket for `attach`/`detach` | 3 | |
| 3.13 Graceful shutdown (SIGTERM drain) | 2 | |
| 3.14 systemd + launchd unit files | 1 | |

**Exit**: webhook triggers a skill that runs as a scoped session while the REPL is closed; user attaches next morning to see results.

---

### Phase 4 — Scale Event Sources (4-6 weeks)

**Goal**: Kafka, MQTT, SQS as installable packages; observability matures.

| Milestone | Days | Notes |
|---|---|---|
| 4.1 `EventSourceAdapter` contract + registry | 4 | See EVENT_SOURCE_REGISTRY §2-3 |
| 4.2 In-memory source (test harness) | 2 | |
| 4.3 Auto-discover `@my-agent/source-*` packages | 2 | |
| 4.4 `BaseSourceInstance` (retries, DLQ, metrics, health) | 5 | |
| 4.5 Kafka adapter (kafkajs) | 7 | SASL, SSL, groups, offsets, retry topic |
| 4.6 Normalizer + routing DSL | 5 | JSONPath + filter + transform |
| 4.7 Schema Registry support (Avro, Protobuf) | 5 | |
| 4.8 SQS adapter | 3 | Long polling, visibility timeout |
| 4.9 OTel metrics + traces everywhere | 5 | Per-source metrics |
| 4.10 Health endpoint + lag dashboard | 3 | |
| 4.11 MQTT adapter | 3 | MQTT 5, QoS, durable sessions |
| 4.12 Backpressure + circuit breaker | 3 | Pause propagation |
| 4.13 Declarative YAML + hot reload (SIGHUP) | 3 | |
| 4.14 Additional adapters (parallel) | 2-3 each | AMQP, NATS, Redis Streams, Kinesis |

**Exit**: ops team plugs existing Kafka + SQS pipelines into my-agent via config file; no custom code.

---

### Phase 5 — Communication Channels (5-7 weeks)

**Goal**: four major chat platforms as bidirectional channels; one skill works everywhere.

| Milestone | Days | Notes |
|---|---|---|
| 5.1 `ChannelAdapter` contract (extends EventSource) | 3 | Capabilities + outbound |
| 5.2 `RichBlock` schema | 2 | Platform-agnostic |
| 5.3 Outbound bridge (session output → channel) | 3 | |
| 5.4 Telegram adapter (long-poll + webhook) | 7 | |
| 5.5 Telegram: text, buttons, files, reactions, MarkdownV2 | 5 | |
| 5.6 Unified renderer (RichBlock → platform) | 5 | Fallbacks + truncation |
| 5.7 Slack adapter (Socket Mode first) | 5 | |
| 5.8 Slack: Block Kit, threads, slash commands, buttons | 5 | |
| 5.9 Discord adapter (Gateway + Interactions) | 5 | |
| 5.10 Discord: intents, slash commands, embeds, threads | 5 | |
| 5.11 WhatsApp adapter (Meta Cloud API) | 7 | |
| 5.12 WhatsApp: 24h window, templates, interactive | 7 | Template approval runs in parallel weeks 1-2 |
| 5.13 Identity mapping + enrollment flow | 5 | Platform user → agent user |
| 5.14 Per-user permission overrides | 2 | |
| 5.15 Voice I/O via MCP (optional) | 5 | Whisper + ElevenLabs servers |

**Exit**: one `support-triage` skill serves users on all four platforms with platform-native rendering.

---

### Phase 6 — Operations Hardening (3-4 weeks)

**Goal**: production-ready reliability and security.

| Milestone | Days | Notes |
|---|---|---|
| 6.1 Prometheus + OTel exports | 3 | |
| 6.2 Pre-built Grafana dashboards (JSON) | 3 | |
| 6.3 Alert rules (DLQ depth, lag, error rate, cost) | 2 | |
| 6.4 Threat model document | 3 | Per-subsystem risks |
| 6.5 Permission gate fuzz suite | 2 | Never bypassable |
| 6.6 Secret rotation flows | 3 | |
| 6.7 Tamper-evident audit log (hash chain) | 3 | |
| 6.8 Multi-tenant: `tenantId` propagation | 4 | |
| 6.9 Per-tenant rate limits + perm scopes | 2 | |
| 6.10 Chaos harness (kill MCP, network partition, etc.) | 4 | |
| 6.11 Graceful shutdown under load | 2 | |
| 6.12 7-day soak test (10K events/day) | — | Passive; runs alongside |

**Exit**: soak test completes with zero manual interventions.

---

### Phase 7 — Distribution: Local v1.0 (2-3 weeks)

**Goal**: installable, documented, onboarding-smooth.

| Milestone | Days | Notes |
|---|---|---|
| 7.1 npm global install with bin entries | 2 | |
| 7.2 Homebrew formula | 1 | |
| 7.3 curl installer script | 2 | |
| 7.4 Single binary via `pkg` or `bun build --compile` | 3 | macOS/Linux/Windows |
| 7.5 Template packs: personal, team, multi-channel, ops, full | 5 | |
| 7.6 `my-agent init` wizard with template selection | 3 | |
| 7.7 Docs site (Docusaurus): Getting Started | 3 | |
| 7.8 Docs: guides, recipes, reference | 5 | |
| 7.9 Auto-gen CLI + config schema docs | 2 | |
| 7.10 Demo video (< 3 min) | 2 | |

**Exit: 🎉 v1.0 local-only ships.** Fresh laptop → running agent in under 10 minutes.

---

### Phase 8 — Deployment Engine Core (5-7 weeks)

**Goal**: `my-agent deploy` works end-to-end on one provider.

| Milestone | Days | Notes |
|---|---|---|
| 8.1 `AgentSpec` schema (Zod) | 4 | See AGENT_BUILDING §3 |
| 8.2 Spec validator (cross-refs, capabilities) | 3 | |
| 8.3 Runtime mode (same binary, minimal bundle) | 4 | `--mode=runtime` |
| 8.4 Dockerfile + reproducible builds | 3 | SBOM + signing |
| 8.5 Container build pipeline (local + CI) | 3 | |
| 8.6 `ProviderAdapter` contract | 3 | |
| 8.7 GCP provider: Cloud Run + Secret Mgr + Firestore | 10 | First real provider |
| 8.8 State store: local files + S3 backend | 5 | With DynamoDB locking |
| 8.9 `plan` / `apply` with preview + compensations | 5 | Terraform-like |
| 8.10 Rollback mechanics | 2 | Traffic flip |
| 8.11 Control plane endpoints (/_ctrl/*) | 4 | JWT auth |
| 8.12 CLI: `build` `plan` `apply` `deploy` `status` `logs` `rollback` `destroy` | 5 | |

**Exit**: user runs `my-agent deploy pr-summarizer --target cloud-run`; agent lives in GCP, handles webhook, replies in Slack.

---

### Phase 9 — Multi-Provider & Builder Agent (5-7 weeks)

**Goal**: multiple providers + conversational deployment experience.

| Milestone | Days | Notes |
|---|---|---|
| 9.1 AWS provider: Fargate + Lambda + Secrets Mgr | 10 | |
| 9.2 Cloudflare provider: Workers + Containers | 5 | |
| 9.3 Fly.io provider: Machines | 5 | |
| 9.4 Azure provider: Container Apps + Key Vault | 7 | |
| 9.5 Kubernetes provider (generic + EKS/GKE/AKS) | 7 | |
| 9.6 Docker Compose provider (self-hosted/dev) | 3 | |
| 9.7 Target recommender heuristic | 3 | Picks best target by spec shape |
| 9.8 Builder mode prompt + 15 builder tools | 7 | See AGENT_BUILDING §4 |
| 9.9 Conversational deploy flow | 5 | |
| 9.10 Cost estimator with live pricing | 5 | |
| 9.11 Governance policies (approvers, budgets, labels) | 5 | |
| 9.12 Multi-environment (base + overlays) | 3 | |
| 9.13 `promote` dev → staging → prod | 2 | |
| 9.14 Progressive rollout (canary, traffic %) | 4 | |
| 9.15 Drift detection (nightly check) | 3 | |

**Exit**: user conversationally builds + deploys to any supported provider; cost estimates are within 20% of actual bills at 30 days.

---

### Phase 10 — Deployment GA: v2.0 (2-3 weeks)

**Goal**: deployment story is polished and launchable.

| Milestone | Days | Notes |
|---|---|---|
| 10.1 Template packs for cloud deploys | 3 | aws-quickstart, gcp-quickstart, etc. |
| 10.2 GitHub Action for CI deploys | 2 | |
| 10.3 Terraform provider wrapper | 3 | IaC users |
| 10.4 Helm chart for K8s | 2 | |
| 10.5 Docs: deployment guide per provider | 5 | |
| 10.6 Disaster recovery playbooks | 2 | |
| 10.7 Reference customer case studies | — | Ongoing |
| 10.8 Launch announcement prep | 3 | |

**Exit: 🎉 v2.0 ships.** The full platform is live.

---

## 8. Dependency Graph & Parallelization

```
P0 Foundations
  │
  ▼
P1 Core (blocks everything)
  │
  ├──► P2 Extensibility ──┐
  │                        │
  ├──► P3 Event-Driven ──┤
  │                        │
  │    P2 done ──► P4 Sources (parallel w/ P3)
  │                              │
  │    P3 done ──► P5 Channels  │
  │                              │
  └──────────┬─────────────┬────┘
             │             │
             ▼             ▼
         P6 Ops      P7 Distribution (v1.0) 🎉
                            │
                            ▼
                       P8 Deploy Core
                            │
                            ▼
                       P9 Multi-Provider + Builder
                            │
                            ▼
                       P10 v2.0 🎉
```

### Parallelization opportunities

- **P2 + P3**: after P1 done, one engineer on extensibility, another on event core. Independent.
- **P4 + P5**: adapter work parallelizes well. One eng per transport family.
- **P9 providers**: 5 providers, 5 engineers can ship in parallel after Adapter contract is locked.

### Critical path

P0 → P1 → P3 → P5 (channels need event core) → P6 → P7 → P8 → P9 → P10

**Critical path length**: ~36 weeks assuming serial execution.
**Parallelized**: ~26 weeks with 3 engineers; ~22 weeks with 5.

---

## 9. Release Train

Ship frequently. Dogfood every release.

| Version | Phase | Audience | What's new |
|---|---|---|---|
| v0.1 | End of P1 | Internal | Core REPL, tools, permissions, sub-agents |
| v0.3 | End of P2 | Invite-only beta | MCP, plugins, skills |
| v0.5 | End of P3 | Public beta | Event bus, cron, webhooks, daemon |
| v0.7 | End of P4 | Public beta | Kafka, SQS, MQTT, observability |
| v0.9 | End of P5 | Public beta | Channels (Telegram, Slack, Discord, WhatsApp) |
| **v1.0** | End of P7 | GA | **Local platform, config schema frozen** |
| v1.1-1.9 | — | GA | Ecosystem, community packages, templates |
| v1.5 | Mid P8 | Early access | First cloud deploy (GCP) |
| v1.8 | End of P9 | Beta | Multi-provider + Builder agent |
| **v2.0** | End of P10 | GA | **Cloud deployment** |

**Cadence**: minor releases every 2-3 weeks; patch releases as-needed. Changesets for every PR.

---

## 10. Team Composition & Sprint Cadence

### Minimum viable team

**3 engineers + 1 part-time PM/designer** ships v1.0 in ~8 months, v2.0 in ~13 months.

- **Core Engineer** (senior/staff): owns P0, P1, P3, P6, P8. The architect.
- **Extensions Engineer**: owns P2, P4, P8-9 (provider adapters).
- **Channels/UX Engineer**: owns P5, P7, P9 (Builder mode), P10.
- **PM/Designer** (part-time): owns wizard UX, docs, templates, GTM.

### Scaling adds velocity after P2

| Hire | When | Owns |
|---|---|---|
| Second channels engineer | Start of P5 | Split WhatsApp+Telegram / Slack+Discord |
| Platform/SRE engineer | Start of P6 | Operations hardening, observability |
| DX engineer | Start of P7 | Templates, docs, SDK, website |
| Provider engineer(s) | Start of P9 | One engineer per cloud provider |

### Sprint structure

- **2-week sprints**. No exceptions.
- Sprint planning Monday morning; demo Friday afternoon of second week.
- Each milestone is 1-3 sprints typically.
- Each sprint ends with: demo, retro, changelog entry, release candidate cut.

### Communication

- **Daily async standup** (written, 10 minutes max to read)
- **Weekly sync** (30 min, architecture + blockers)
- **Monthly roadmap review** (60 min, adjust next quarter)
- **Quarterly offsite** (virtual OK): big-picture reset, ADR review

---

## 11. Week-By-Week for Phase 0–1 (Concrete Kickoff)

Enough detail to literally start Monday.

### Week 0 (Phase 0)

**Mon** — Repo init: `pnpm init -w`, turbo config, base tsconfig, `.gitignore`. Decide on repo name & scope. Publish empty `@my-agent/core` to confirm release plumbing (private npm registry).
**Tue** — CI setup: GitHub Actions matrix (Node 22, macOS/Linux/Windows). Lint (eslint-config-typescript + prettier). Commit hooks (husky + lint-staged).
**Wed** — Changesets: install, configure, document contributor workflow. First "empty" changeset to verify release pipeline.
**Thu** — Templates: issue, PR, CODEOWNERS, SECURITY.md, CONTRIBUTING.md, README skeleton. License (Apache 2.0).
**Fri** — ADRs: write ADR-0001 through ADR-0020 covering the decisions from §5. Review as a team. Commit.

### Week 1 (Phase 1 Kickoff)

**Mon** — `packages/core/src/llm.ts`: Anthropic SDK wrapper with retry, streaming, AbortSignal. Unit tests with mocked fetch.
**Tue** — `packages/core/src/engine.ts`: `runAgent()` async generator skeleton. Happy path: send message, stream text, yield events. No tool use yet.
**Wed** — Continue engine: tool use detection, loop back to LLM. Still no real tools.
**Thu** — `packages/core/src/tools/types.ts`: Tool interface. `packages/core/src/tools/registry.ts`: ToolRegistry.
**Fri** — `packages/tools-builtin/src/bash.ts`: first real tool. Wire end-to-end: REPL prompt → engine → bash tool → engine → reply. Demo at sprint end: `node cli.js "echo hi"`.

### Week 2 (Phase 1)

**Mon** — `packages/tools-builtin/src/read.ts`, `write.ts`. Tests.
**Tue** — `packages/tools-builtin/src/edit.ts`, `grep.ts`, `glob.ts`. Tests.
**Wed** — Tool dispatcher with read/write batching. Parallel reads in tests.
**Thu** — `packages/core/src/permissions.ts`: PermissionContext, rules, modes.
**Fri** — `resolvePermission()` choke point. Fuzz test: 10K random calls; assert decisions consistent and gate is never bypassed.

### Week 3 (Phase 1)

**Mon** — `packages/cli/src/repl.tsx`: Ink app scaffold.
**Tue** — Message list component, streaming text display.
**Wed** — Input bar, history, vim-mode stubbed.
**Thu** — Permission modal component; blocks on user Y/N.
**Fri** — Tool progress spinner + live output display. Demo: full REPL with bash + file tools + permission prompts.

### Week 4 (Phase 1)

**Mon** — Ctrl+C / abort signal propagation end-to-end.
**Tue** — Session transcript writer (JSONL, fire-and-forget, per-session file).
**Wed** — `/resume`, `/clear`, `/cost`, `/memory` commands.
**Thu** — Memory loader (global + project `MEMORY.md`).
**Fri** — Demo + retro. Cut **v0.1-alpha-1**.

### Week 5 (Phase 1)

**Mon-Tue** — `AgentTool` (sub-agent). Context isolation. Transcript persistence per child.
**Wed-Thu** — Parallel sub-agent spawning via read-only batch path.
**Fri** — Internal dogfooding starts. All team members switch to it for real work.

### Week 6 (Phase 1)

**All week** — Dogfooding week. Bug-fix sprint. No new features. Every pain point → bug → fix. Compile feedback for P2 priorities.
**End of week** — Decide P1 exit: is it daily-drivable? Yes → move to P2. No → extend P1 by one sprint.

From here, the pattern repeats for each phase: kickoff sprint → build sprints → dogfood sprint → version release.

---

## 12. Quality Gates & Definition of Done

Every milestone must pass these gates before it's marked done.

| Gate | Requirement |
|---|---|
| Unit tests | ≥80% line coverage on new code |
| Integration tests | Happy + two error paths per feature |
| E2E tests | At least one end-to-end test exercising the feature from CLI input |
| Docs | Updated in the same PR |
| CHANGELOG | Entry in `.changeset/` |
| Breaking changes | Migration script (post-v1.0); ADR |
| Performance | Benchmarks pass (no regression >10%) |
| Security | Threat model updated if surface changes |

### Additional gates per phase

| Phase | Extra gates |
|---|---|
| P4+ | Chaos test: random transport failure injected; system recovers |
| P5+ | Load test: 10× expected throughput for 1h |
| P6 | 7-day soak: zero manual intervention |
| P7 | Docs site complete; all commands have reference pages |
| P8+ | Reproducible builds (bit-identical across runs) |
| P9 | End-to-end deploy test on each provider in CI nightly |

### Definition of Done for "it works"

A feature is done when:
1. A new user following only the docs can use it successfully in 10 minutes.
2. It has alarms/alerts if relevant (prod-critical features only).
3. It rolls back cleanly.
4. It can be disabled via config (feature flags during rollout).

---

## 13. Cross-Cutting Concerns

Baked into every phase. Not bolted on.

### Security

- Permission gate fuzz-tested every PR (CI gate)
- Secrets: keychain-first; refuse plaintext in config
- Every adapter auth'd; every webhook signature-verified
- Third-party plugins require consent dialog with declared perms
- Tamper-evident audit log from Phase 3 onwards
- SBOM + sigstore signing from Phase 7 onwards

### Privacy

- Telemetry opt-in only (first-run prompt)
- Zero PII in telemetry
- Session transcripts local by default
- PII-redaction in audit log (configurable patterns)

### Accessibility

- Screen-reader tested from Phase 1 (Ink REPL)
- Color not the only signal
- Keyboard-only operation always

### Performance budgets

- Cold start < 500ms (local CLI)
- First-token latency < 2s
- Memory < 150MB resident (CLI); < 500MB (daemon with 10 sessions)
- Measure every phase; regression >10% blocks merge

### Backwards compatibility

- SemVer from v1.0 for: config, plugin API, CLI flags
- n-1 major supported; v2.x migrates v1.x configs automatically
- Breaking changes in 0.x are expected; migration scripts mandatory

### Supply chain

- `npm audit` / dependabot from day 1
- Pinned lockfiles
- SBOM per release from P7
- Sigstore signing from P8+

### Cost awareness

- Every LLM call tracked with cost
- Daily/monthly budget caps enforceable
- `my-agent cost` from v0.3 onwards
- Pre-deploy cost estimate from P8+

### Internationalization

- UTF-8 end-to-end from P1
- User-facing strings externalized from P2
- RTL-tested before channels ship (P5)

---

## 14. Consolidated Risk Register

All risks from the prior docs, ranked by impact × likelihood.

| Risk | Likelihood | Impact | Phase | Mitigation |
|---|---|---|---|---|
| Permission gate bypass | Low | Critical | All | Fuzz suite in CI; per-PR review; bypass requires explicit ADR |
| WhatsApp template rejection | High | High | P5 | Start templates week 1; 3 fallback phrasings; ship behind flag |
| Config schema breaks post-v1 | High | Medium | P7+ | 0.x breaks freely; migration scripts mandatory; freeze at 1.0 |
| MCP protocol changes | Medium | Medium | P2+ | Pin spec version; compat tests |
| Anthropic API changes | Medium | High | All | LLM client is abstract; adapter pattern |
| Ink bugs on Windows | High | Medium | P1 | Windows CI from day 1; plain-text fallback renderer |
| Orphaned cloud resources on deploy failure | Medium | Critical | P8+ | Transactional deploys; compensation actions; monthly audit of state vs reality |
| Infinite event chains | Medium | High | P3+ | `meta.causedBy` chain; max-depth enforced; circuit breakers |
| Sub-agent recursion blowup | Medium | High | P1+ | `AgentTool` excluded from subagent toolsets; max depth |
| LLM cost runaway | High | Medium | All | Per-target rate limits; session coalescing; default budgets; alerts |
| Kafka/SQS message loss | Low | Critical | P4 | After-publish ack default; integration tests with real brokers; replay API |
| Plugin compat breaks | Medium | High | P2+ | `agent_compat` manifest; SemVer; deprecation windows |
| Poor onboarding bounce | High | High | P7 | Measure wizard completion; A/B copy; opt-in telemetry |
| Cross-region latency surprise | Medium | Medium | P8+ | Target recommender co-locates by default; warns on drift |
| IAM overreach | Medium | High | P8+ | Auto-generate least-priv roles from spec; refuse `*` in policy |
| Secrets leaking into images | Low | Critical | P8+ | Image scanning in CI; refuse build if secret detected |
| Cost surprise on first deploy | High | High | P8+ | Pre-deploy estimate; default budget caps; alerts at 50/80/100% |
| Deploy key reuse attack | Low | High | P8+ | Fresh JWT signing key per deploy; N-min grace revocation |
| Drift between state and cloud | High | Medium | P8+ | Nightly drift check; `my-agent drift` command; alert on non-zero |

### Triage rules

- **Critical × ≥Medium likelihood**: mitigation ships before phase exits
- **High**: tracked in roadmap, scheduled
- **Below**: backlog; quarterly review

---

## 15. Launch Checklist

Before each major release, tick every box.

### v1.0 (Local GA)

- [ ] 7-day soak passing
- [ ] All commands documented (reference pages)
- [ ] Getting Started guide tested by 3 non-team people
- [ ] Demo video published
- [ ] 5 template packs validated
- [ ] Installers work on macOS, Linux, Windows
- [ ] Migration scripts tested for every breaking change
- [ ] Security review signed off
- [ ] Threat model current
- [ ] Changelog complete
- [ ] Release notes drafted
- [ ] Launch blog post drafted
- [ ] Community channels ready (Discord, GitHub Discussions)
- [ ] SemVer freeze committed
- [ ] Opt-in telemetry plumbing verified
- [ ] SBOM published
- [ ] At least 2 external contributors have shipped a PR

### v2.0 (Deployment GA)

All of the above, plus:

- [ ] 5 providers working end-to-end (GCP, AWS, CF, Fly, K8s)
- [ ] Cost estimator within 20% accuracy over 30 days (validated)
- [ ] Reference customer case studies (3+)
- [ ] Provider-specific docs complete
- [ ] Disaster recovery playbooks tested
- [ ] CI-based deploy via GitHub Action works
- [ ] Helm chart published
- [ ] Terraform provider published (optional but nice)
- [ ] Reproducible builds verified
- [ ] Sigstore signing in pipeline

---

## 16. Success Metrics

| Metric | v0.5 | v1.0 | v1.5 | v2.0 |
|---|---|---|---|---|
| Time: install → first prompt | <2m | <1m | <1m | <30s |
| Time: install → first channel live | <30m | <10m | <10m | <5m |
| Time: install → first cloud deploy | — | — | <30m | <10m |
| Wizard completion rate | 40% | 60% | 65% | 75% |
| Daemon 30-day uptime | 99% | 99.9% | 99.9% | 99.95% |
| p99 tool-call latency | <5s | <2s | <2s | <1s |
| Cost estimate accuracy (30d) | — | — | ±30% | ±20% |

### Ecosystem

| Metric | 6mo post-v1 | 1yr post-v1 | 6mo post-v2 |
|---|---|---|---|
| Community `@my-agent/*` packages | 20 | 100 | 200 |
| Community skills | 50 | 500 | 1000 |
| GitHub stars | 2K | 15K | 25K |
| Active installs (telemetry) | 1K | 20K | 50K |
| Discord members | 500 | 5K | 10K |

### What not to measure

Raw API calls, session counts, total tokens. They reward waste, not value.

---

## 17. First-Day Punchlist

Monday, week 0, what literally to do:

1. **Create the GitHub org / repo**. Name decision: commit before starting.
2. `git init`, `pnpm init -w`, commit an empty `pnpm-workspace.yaml` and `turbo.json`.
3. Install + configure: `typescript`, `eslint`, `prettier`, `vitest`, `changesets`.
4. Create `packages/core`, `packages/cli`, `packages/testkit` as empty publishable packages.
5. Wire GitHub Actions: `test.yml`, `release.yml`. Get first green build.
6. Publish a `0.0.0` version of `@my-agent/core` to verify release plumbing (private npm or npm scoped with `private: true` initially).
7. Write ADR-0001 (repo structure) and ADR-0002 (language/runtime). Commit with description.
8. Set up issue/PR templates + CODEOWNERS.
9. Invite the team. Grant least-privilege access.
10. Draft a one-page internal vision doc. Share. Adjust.

**End of day 1**: empty repo with working CI, team access, shared direction.

**End of week 0**: all 20 ADRs written. CI publishing to npm on every tag. All team members have working local setups. Week 1 plan committed (the one in §11).

Then `git checkout -b phase-1/engine-skeleton` and start.

---

## Closing Thought

This plan reads long because it covers the entire product lifecycle — from `git init` to a deployed, observable, multi-channel, multi-source, multi-cloud agent platform. But the core shape is simple, repeated:

> **Contract → Registry → Lifecycle → Scoped Permissions → Declarative Config.**

Every layer — tools, MCP, skills, plugins, event sources, channels, providers — is the same pattern. Get the pattern right once; the rest is volume work.

The user never sees any of it. What they see:

```bash
$ my-agent
builder> Hi. What should I build?
```

Ten months later, the answer to that question can be anything from "help me write code" to "triage our production incidents 24/7 across four cloud regions." Same installation. Same CLI. Same conversation.

That's the whole game.

**Start Monday.**

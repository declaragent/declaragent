# Master Implementation Plan

Synthesis of the six design docs (`BUILDING_A_GENERIC_AGENT.md`, `EXTENDING_YOUR_AGENT.md`, `EVENT_DRIVEN_AGENT.md`, `EVENT_SOURCE_REGISTRY.md`, `COMMUNICATION_CHANNELS.md`, and this repo's `CLAUDE.md`) into one actionable build plan.

**North star UX:** the user runs `npm i -g my-agent && my-agent init`, answers three questions, and ends up with a running agent they can configure with events, channels, skills, plugins, MCP servers, and sub-agents — without ever reading the source code.

Everything in this plan is in service of that north star.

---

## Table of Contents

1. [North Star UX](#1-north-star-ux)
2. [The Unified Configuration Model](#2-the-unified-configuration-model)
3. [Architecture Reference](#3-architecture-reference)
4. [The Eight Phases](#4-the-eight-phases)
5. [Release Train](#5-release-train)
6. [Team Structure & Parallelization](#6-team-structure--parallelization)
7. [Quality Gates Per Phase](#7-quality-gates-per-phase)
8. [Packaging & Installation Story](#8-packaging--installation-story)
9. [Starter Templates](#9-starter-templates)
10. [Documentation Strategy](#10-documentation-strategy)
11. [Risk Register](#11-risk-register)
12. [Observability & Operations](#12-observability--operations)
13. [Go-to-Market](#13-go-to-market)
14. [Success Metrics](#14-success-metrics)
15. [Cross-Cutting Concerns](#15-cross-cutting-concerns)

---

## 1. North Star UX

Before building anything, lock the user's experience. Every decision below traces back to this.

### Install

```bash
# npm path
npm i -g my-agent

# curl path
curl -fsSL https://my-agent.sh/install.sh | sh

# homebrew (later)
brew install my-agent
```

One of these completes in <30s on a normal laptop. Binary-on-PATH + default config dir at `~/.my-agent/`.

### First run — zero config

```bash
$ my-agent
┌─ my-agent v1.0.0 ──────────────────────────────┐
│ Welcome. No API key found.                     │
│ Paste your Anthropic API key (sk-ant-...):     │
│ > _                                            │
└────────────────────────────────────────────────┘
```

Saves to OS keychain (macOS Keychain, Windows Credential Store, `libsecret` on Linux). Single prompt. Nothing else required.

### REPL

```
$ my-agent
you> list the largest files in this directory

● Bash(find . -maxdepth 2 -type f -exec du -h {} + | sort -rh | head)
  (auto-approved: read-only)

● The five largest files are:
  1.2M  ./docs/IMPLEMENTATION_PLAN.md
  890K  ./src/engine.ts
  ...

you> _
```

### Wizard for non-trivial setups

```bash
$ my-agent init
? What do you want to build?
  ❯ Personal CLI assistant (you + agent, terminal only)
    Team assistant (with Slack)
    Multi-channel bot (Telegram + WhatsApp)
    Ops automation (webhooks + cron, runs as daemon)
    Full platform (all of the above)
    Custom
? Default permission mode?
  ❯ default (ask before writing)
    auto (hooks + allowlist)
    bypass (not recommended)
? Install starter plugins? (Space to select)
  ◉ git-helper
  ◯ github-ops
  ◯ pr-review-suite
Creating ~/.my-agent/config.yaml...
✓ Done. Run `my-agent` to start, `my-agent doctor` to verify.
```

### Configuration via commands (not manual YAML edits unless you want to)

```bash
my-agent channel add slack --token "$SLACK_BOT_TOKEN"
my-agent channel add telegram --token "$TG_TOKEN"
my-agent mcp add github --command "npx -y @modelcontextprotocol/server-github"
my-agent plugin install @my-agent/plugin-pr-review
my-agent skill create daily-standup
my-agent trigger add --cron "0 9 * * 1-5" --skill daily-standup
my-agent event-source add kafka --brokers "kafka1:9092" --topics "orders.placed"
my-agent daemon start
```

Each command edits the unified config and (if daemon is running) hot-reloads.

### Introspection

```bash
my-agent status                    # daemon health, active sessions
my-agent sessions                  # list running sessions
my-agent sessions attach <id>      # drop into a live session
my-agent logs                      # tail event stream
my-agent doctor                    # diagnose config issues
my-agent cost                      # token usage
```

**Principle**: nothing the user can do requires editing code. Nothing the user does requires restarting the daemon. Nothing the user does requires understanding the internals.

---

## 2. The Unified Configuration Model

One file format. Every subsystem's config lives in it (or is referenced from it). YAML, schema-validated with Zod, hot-reloadable via SIGHUP or the CLI.

### File layout

```
~/.my-agent/
├── config.yaml                    # Primary config
├── config.local.yaml              # Per-machine overrides (gitignored)
├── secrets/
│   └── .keyring                   # OS keychain pointer
├── skills/                        # User-authored skills (markdown)
├── plugins/                       # Symlinks or npm installs
├── sessions/                      # Session transcripts
│   ├── <session-id>.jsonl
│   └── agents/<child-id>.jsonl    # sub-agent transcripts
├── memory/
│   ├── MEMORY.md                  # Global memory
│   └── <project>/MEMORY.md
├── events/                        # Event audit log
│   └── events.jsonl
└── logs/
    └── daemon.log
```

### The schema

```yaml
# ~/.my-agent/config.yaml
version: 1

identity:
  provider: anthropic
  api_key: "${keychain:anthropic-api-key}"
  default_model: "claude-opus-4-6"
  fallback_model: "claude-sonnet-4-6"
  telemetry:
    enabled: false

daemon:
  enabled: false
  control_socket: "~/.my-agent/daemon.sock"
  http:
    port: 7777
    bind: "127.0.0.1"
    tls:
      enabled: false
  shutdown_grace_sec: 30

permissions:
  default_mode: default                # default | plan | bypass | auto
  rules:
    allow:
      - "Read(**/*)"
      - "Grep(**/*)"
      - "Glob(**/*)"
      - "Bash(git status)"
      - "Bash(git diff *)"
    deny:
      - "Bash(rm -rf /)"
      - "Bash(curl * | sh)"
    ask: []
  denial_escalation:
    threshold: 3
    action: prompt

compaction:
  auto: true
  threshold_pct: 0.9
  strategy: snip-projection
  micro_dedup: true

ui:
  renderer: ink                        # ink | plain | web
  theme: auto
  show_tool_inputs: true

# Extension surfaces ===============================================
mcp:
  servers:
    github:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-github"]
      env: { GITHUB_TOKEN: "${keychain:github-token}" }
      disabled: false
    postgres:
      command: "mcp-postgres"
      args: ["--connection-string", "${env:DATABASE_URL}"]

plugins:
  search_paths:
    - "./.my-agent/plugins"
    - "~/.my-agent/plugins"
  installed:
    - id: "git-helper"
      version: "^0.1.0"
      enabled: true

skills:
  search_paths:
    - "./.my-agent/skills"
    - "~/.my-agent/skills"
  bundled: true                        # include skills shipped with binary

# Events ===========================================================
event_sources:
  # Local sources
  - id: "daily-standup"
    type: cron
    schedule: "0 9 * * 1-5"
    enabled: true
    target:
      type: skill
      name: "standup"

  - id: "github-webhook"
    type: webhook
    path: "/hooks/github"
    enabled: true
    auth:
      kind: hmac
      header: "x-hub-signature-256"
      secret: "${keychain:github-webhook-secret}"
    routing:
      filter: { expr: "$.action == 'opened' and $.issue != null" }
      target:
        type: skill
        name: "triage-issue"
        inputs: { issue_number: "$.issue.number" }

  # Streaming source (requires @my-agent/source-kafka)
  - id: "orders-kafka"
    type: kafka
    enabled: false                     # opt-in
    transport:
      brokers: ["${env:KAFKA_BROKERS}"]
      consumer_group: "my-agent-orders"
      topics: ["orders.placed"]
    security:
      sasl: { mechanism: SCRAM-SHA-512, username: "${secret:kafka_user}", password: "${secret:kafka_pass}" }
    routing:
      format: json
      target:
        type: skill
        name: "order-workflow"
    delivery:
      mode: at-least-once
      ack_strategy: after-publish
      max_retries: 5

# Channels =========================================================
channels:
  - id: "slack-prod"
    type: slack
    enabled: true
    transport:
      mode: socket
      bot_token: "${keychain:slack-bot-token}"
      app_token: "${keychain:slack-app-token}"
    routing:
      target:
        type: session
        session_id_from: "${channel:conversationSessionId}"
        action: inject
    permissions:
      mode: auto
      allow: ["Read(**/*)", "mcp__github__*"]
      deny: ["Bash(*)", "Edit(**/*)"]

  - id: "telegram-support"
    type: telegram
    enabled: true
    transport:
      mode: webhook
      bot_token: "${keychain:telegram-bot-token}"
      webhook_url: "https://agent.example.com/hooks/telegram"
    permissions:
      mode: default

# Starter templates ================================================
# Declares which pack shaped this config; used for upgrades/migrations
template:
  pack: "team-assistant"
  pack_version: "1.0.0"
```

### Secret resolution

- `${env:NAME}` → `process.env.NAME`
- `${keychain:key}` → OS keychain (preferred)
- `${secret:key}` → secret manager (Vault, AWS Secrets Manager, 1Password) configured once
- `${file:/path}` → read file contents (certs, private keys)

### Config validation

```bash
$ my-agent doctor
✓ config.yaml is valid
✓ api_key resolves (keychain)
✓ mcp.github server reachable
✗ channels.slack-prod: bot token missing scope `chat:write`
  → Run: my-agent channel repair slack-prod
✓ event_sources.daily-standup: cron schedule valid
```

Fail fast on malformed config at startup. Warn on degraded (e.g., one source fails but others load).

---

## 3. Architecture Reference

The six layers, mapped to the design docs:

```
┌────────────────────────────────────────────────────────────────┐
│ 8. DISTRIBUTION — npm + installer + templates + docs site       │
├────────────────────────────────────────────────────────────────┤
│ 7. CHANNELS — Telegram, Slack, Discord, WhatsApp                │
│    (COMMUNICATION_CHANNELS.md)                                  │
├────────────────────────────────────────────────────────────────┤
│ 6. EVENT SOURCES — Kafka, MQTT, AMQP, NATS, SQS, …              │
│    (EVENT_SOURCE_REGISTRY.md)                                   │
├────────────────────────────────────────────────────────────────┤
│ 5. EVENT BUS + DISPATCHER — user input, cron, webhook, file     │
│    (EVENT_DRIVEN_AGENT.md)                                      │
├────────────────────────────────────────────────────────────────┤
│ 4. EXTENSIBILITY — plugins, MCP, skills, sub-agents             │
│    (EXTENDING_YOUR_AGENT.md)                                    │
├────────────────────────────────────────────────────────────────┤
│ 3. PERSISTENCE — sessions, memory, audit, config                │
├────────────────────────────────────────────────────────────────┤
│ 2. UI — Ink REPL (initial), web UI (later), SDK                 │
├────────────────────────────────────────────────────────────────┤
│ 1. CORE ENGINE — runAgent(), tools, permissions, streaming      │
│    (BUILDING_A_GENERIC_AGENT.md)                                │
└────────────────────────────────────────────────────────────────┘
```

**Build bottom-up.** Each layer assumes the ones below. Shortcuts here cost 3× later.

### Monorepo structure (final shape)

```
my-agent/
├── packages/
│   ├── core/                      # Engine, tools, permissions
│   ├── cli/                       # Commander-based CLI + Ink REPL
│   ├── daemon/                    # Long-running server
│   ├── sdk/                       # Programmatic embedding
│   │
│   ├── registry/                  # Extension registries
│   ├── mcp/                       # MCP client
│   ├── skills/                    # Skill loader + executor
│   ├── plugins/                   # Plugin loader
│   │
│   ├── events/                    # Bus, dispatcher, session manager
│   │
│   ├── source-cron/               # Built-in
│   ├── source-webhook/            # Built-in
│   ├── source-file/               # Built-in
│   ├── source-kafka/              # npm: @my-agent/source-kafka
│   ├── source-mqtt/               # npm: @my-agent/source-mqtt
│   ├── source-amqp/               # npm: @my-agent/source-amqp
│   ├── source-sqs/
│   ├── source-nats/
│   ├── source-redis-streams/
│   │
│   ├── channel-telegram/          # npm: @my-agent/channel-telegram
│   ├── channel-slack/
│   ├── channel-discord/
│   ├── channel-whatsapp/
│   │
│   ├── tools-builtin/             # Bash, Read, Edit, Grep, Glob, Agent, Skill
│   ├── template-packs/            # Starter configs
│   │
│   └── testkit/                   # Test harness for extensions
├── apps/
│   ├── web/                       # Later: web REPL
│   └── docs/                      # Docusaurus site
├── examples/                      # Reference configs
├── scripts/                       # Build, release, migrate
└── pnpm-workspace.yaml
```

pnpm workspaces. Turborepo or Nx for build graph caching. Every adapter is its own npm package from day one — no "someday we'll split it."

---

## 4. The Eight Phases

### Phase 0 — Foundations (1–2 weeks)

**Goal**: the monorepo exists, CI passes, releases cut cleanly.

| Deliverable | Owner | Days |
|---|---|---|
| Monorepo scaffold (pnpm + Turbo) | Lead | 2 |
| TypeScript project refs + strict config | Lead | 1 |
| Lint (eslint + prettier) + commit hooks | Lead | 1 |
| CI: test + build + typecheck on PR | Lead | 1 |
| Release pipeline (changesets → npm publish) | Lead | 2 |
| Issue/PR templates, CODEOWNERS | Lead | 1 |
| Licensing (MIT default unless decided otherwise) | Lead | 0.5 |
| Security policy, vulnerability disclosure | Lead | 0.5 |

**Exit criteria**: empty package publishes to npm private registry; CI green.

---

### Phase 1 — Core Agent (4–6 weeks)

Follow `BUILDING_A_GENERIC_AGENT.md` milestones 0–4 (plus persistence).

**Goal**: `my-agent -p "list files"` works end-to-end with permission gating and a real REPL.

#### Milestone 1.1 — Engine skeleton (1 week)
- `runAgent()` generator
- Anthropic SDK wrapper with retries
- Streaming event types
- Abort signal propagation

#### Milestone 1.2 — Tool system (1 week)
- `Tool` interface
- `ToolRegistry`
- Built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`
- Tool dispatcher with read/write batching

#### Milestone 1.3 — Permissions (1 week)
- `PermissionContext`, modes, rules
- `resolvePermission()` choke point
- Denial escalation
- Permission prompt protocol (decoupled from UI)

#### Milestone 1.4 — Ink REPL (1–1.5 weeks)
- App shell, message list, input bar
- Permission modal
- Typing/streaming display
- Tool progress spinners
- Ctrl+C cancellation

#### Milestone 1.5 — Persistence (0.5 week)
- Session transcript writer (fire-and-forget)
- `/resume` command
- Global + project memory (`MEMORY.md`) injection

#### Milestone 1.6 — Commands (0.5 week)
- `/cost`, `/compact`, `/memory`, `/clear`, `/plan`, `/rules`

#### Milestone 1.7 — Sub-agents (0.5 week)
- `AgentTool` with context isolation
- Child transcript persistence
- Parallel spawning through the read-only batch path

**Exit criteria**: dogfooding. Someone on the team uses it as their daily driver for a week without rage-quitting.

---

### Phase 2 — Extensibility (4–6 weeks)

Follow `EXTENDING_YOUR_AGENT.md` milestones X2–X5.

**Goal**: users can install third-party capabilities without touching code.

#### Milestone 2.1 — MCP client (2 weeks)
- stdio transport (JSON-RPC framing, backpressure)
- Handshake, tool discovery, tool wrapping
- Resource support (separate registry)
- Auto-restart with exponential backoff
- Elicitation handling
- HTTP transport (lower priority; ship after stdio)

#### Milestone 2.2 — Skills (1 week)
- Markdown + frontmatter loader
- Three-tier search paths
- Template substitution
- `SkillTool` for model invocation
- Skill-as-slash-command binding

#### Milestone 2.3 — Hooks (0.5 week)
- `HookRegistry` with three phases
- Integration into permission gate
- Example hook: audit logger

#### Milestone 2.4 — Plugin loader (1.5 weeks)
- Manifest schema + compat check
- Consent flow
- Scoped registries (auto-cleanup on unload)
- Hot reload (require-cache busting)
- Bundled starter plugins: `git-helper`

#### Milestone 2.5 — CLI admin commands (1 week)
- `my-agent mcp add/list/remove`
- `my-agent plugin install/list/remove`
- `my-agent skill create/list/edit`
- `my-agent rules edit` (opens $EDITOR)

**Exit criteria**: a user can install `@my-agent/plugin-github`, add a GitHub MCP server, and write a `pr-review.md` skill without reading docs beyond the help text.

---

### Phase 3 — Event-Driven Core (3–4 weeks)

Follow `EVENT_DRIVEN_AGENT.md` milestones E1–E7.

**Goal**: user input is just one event source. Cron, webhooks, file watchers, and self-wakeup all work.

#### Milestone 3.1 — Event bus + dispatcher (1 week)
- `EventBus` (pub/sub, history, wildcard)
- `AgentEvent` schema
- `EventDispatcher` routing (session / new-session / skill / sub-agent / broadcast)
- Refactor REPL: input → event → dispatcher (no regressions)

#### Milestone 3.2 — Cron + self-wakeup (0.5 week)
- Built-in cron source
- `ScheduleWakeup` tool
- Self-pacing loops

#### Milestone 3.3 — Webhooks (1 week)
- Built-in webhook source with HMAC verification
- Bearer token auth
- Per-trigger permission scopes
- Rate limiting + idempotency

#### Milestone 3.4 — File watch (0.5 week)
- Debounced chokidar wrapper
- Path-pattern matching
- Session injection target

#### Milestone 3.5 — Mailbox + SendMessage (0.5 week)
- Inter-agent messaging
- Persistence for offline recipients
- `SendMessage` tool

#### Milestone 3.6 — Daemon mode (1 week)
- Long-running process
- Control socket for `my-agent attach`
- Graceful shutdown
- systemd + launchd unit files

**Exit criteria**: a webhook can trigger a scoped session that runs a skill and replies via a cron-triggered follow-up. All without foreground interaction.

---

### Phase 4 — Scale: Pluggable Event Sources (4–6 weeks)

Follow `EVENT_SOURCE_REGISTRY.md` milestones S1–S10.

**Goal**: Kafka, MQTT, AMQP as installable packages. The contract holds.

#### Milestone 4.1 — Source contract & registry (1 week)
- `EventSourceAdapter` interface
- `EventSourceRegistry` with lifecycle management
- In-memory source (testing)
- Auto-discovery of `@my-agent/source-*` packages

#### Milestone 4.2 — Base class + first real adapter: Kafka (1.5 weeks)
- `BaseSourceInstance` with retry, DLQ, metrics, health
- Kafka via kafkajs: SASL, SSL, consumer groups, offset commit, retry topic, pause/resume
- Replay + seek API

#### Milestone 4.3 — Normalizer + routing (1 week)
- JSON-path / JMESPath selectors
- Filter + transform expressions
- Schema Registry (Avro + Protobuf)
- Format decoders (json, avro, protobuf, msgpack, plain)

#### Milestone 4.4 — SQS (queue family) (0.5 week)
- Long polling
- Visibility timeout management
- FIFO support
- Native DLQ (redrive)

#### Milestone 4.5 — Observability (1 week)
- OTel metrics + traces
- Per-source health endpoint
- Lag dashboard
- Event audit log

#### Milestone 4.6 — MQTT (pub/sub family) (0.5 week)
- MQTT 5 protocol
- QoS 0/1/2
- Durable session

#### Milestone 4.7 — Backpressure + circuit breaker (0.5 week)
- Watermark-based pause propagation
- Circuit breaker per adapter

#### Milestone 4.8 — Declarative config + hot reload (0.5 week)
- YAML loader with validation
- SIGHUP to reload
- Per-source start/stop via `my-agent event-source add/remove`

#### Milestone 4.9 — Additional adapters as packages (parallel, 2–3 days each)
- AMQP, NATS, Redis Streams, Kinesis, Pulsar, GCP Pub/Sub, Azure Service Bus, CDC, IMAP, S3

**Exit criteria**: an ops team plugs their existing Kafka + SQS pipelines into my-agent without custom code.

---

### Phase 5 — Communication Channels (5–7 weeks)

Follow `COMMUNICATION_CHANNELS.md` milestones C1–C8.

**Goal**: Telegram, Slack, Discord, WhatsApp as bidirectional channels.

#### Milestone 5.1 — Channel contract + outbound bridge (1 week)
- `ChannelAdapter extends EventSourceAdapter`
- `RichBlock` schema
- Outbound bridge subscribed to session output
- Capability negotiation

#### Milestone 5.2 — Telegram (1–1.5 weeks)
- Long-polling + webhook modes
- Text + MarkdownV2 escaping
- Inline keyboards (buttons)
- File upload (documents, photos, voice)
- Reactions

#### Milestone 5.3 — Unified renderer (1 week)
- RichBlock → platform translators for each supported platform
- Fallback strategies
- Length truncation + splitting logic

#### Milestone 5.4 — Slack (1.5 weeks)
- Socket Mode + Events API
- Block Kit rendering
- Threads, DMs, mentions
- Slash commands, interactive buttons
- Scope verification on startup

#### Milestone 5.5 — Discord (1.5 weeks)
- Gateway + HTTP interactions
- Intents declaration + verification
- Slash commands
- Buttons, embeds
- Thread support

#### Milestone 5.6 — WhatsApp (2–3 weeks, longest path)
- Meta Cloud API
- 24-hour window tracking per conversation
- Template registration flow (overlapping; start week 1 of phase)
- Reply buttons + list messages
- Media download + re-hosting
- Tier-based rate limit awareness

#### Milestone 5.7 — Identity mapping + allowlisting (1 week)
- Platform user → agent user mapping
- Enrollment flow (DM → OAuth link)
- Per-user permission overrides

#### Milestone 5.8 — Voice I/O (optional, 1 week)
- STT via MCP (e.g., Whisper server)
- TTS via MCP (e.g., ElevenLabs server)
- Voice note round-trip

**Exit criteria**: a single skill responds correctly across all four channels; voice works on Telegram and WhatsApp.

---

### Phase 6 — Operations (3–4 weeks)

**Goal**: the platform is runnable in production without babysitting.

#### Milestone 6.1 — Observability maturation (1 week)
- Prometheus + OTel exports
- Pre-built Grafana dashboards
- Alert rules (DLQ depth, lag, 5xx rate, session failures)

#### Milestone 6.2 — Security hardening (1 week)
- Full threat model review
- Secret rotation flow
- Audit log verification (tamper-evident hash chain)
- Optional: sigstore signing for plugins

#### Milestone 6.3 — Multi-tenant support (1 week)
- `tenantId` propagation in events
- Per-tenant rate limits
- Per-tenant permission scopes
- Isolation tests

#### Milestone 6.4 — Chaos & reliability (1 week)
- Chaos harness: kill MCP servers, drop network, spike traffic
- Graceful shutdown under load
- Crash recovery
- Session state consistency after restart

**Exit criteria**: Soak test: 7 days continuous run, 10K events/day, zero manual interventions.

---

### Phase 7 — Distribution (2–3 weeks)

**Goal**: one command installs; starter templates for every common use case.

#### Milestone 7.1 — Installer & binaries (1 week)
- npm global install path
- Homebrew formula
- Curl installer script
- Single-binary builds via `bun build --compile` or `pkg` (macOS/Linux/Windows)

#### Milestone 7.2 — Template packs (1 week)
- `personal-assistant` — CLI only
- `team-assistant` — Slack + optional GitHub
- `multi-channel-bot` — Telegram + WhatsApp
- `ops-automation` — webhook + cron, daemon
- `full-platform` — everything
- Wizard (`my-agent init`) picks and applies these

#### Milestone 7.3 — Docs site (1 week)
- Docusaurus (or Nextra)
- Getting Started
- Per-extension reference (MCP servers, skills, sources, channels)
- Recipes / cookbook
- API reference (auto-generated from TypeScript)

**Exit criteria**: fresh laptop → running agent with Telegram + Slack + GitHub in < 30 minutes.

---

## 5. Release Train

Don't ship everything at once. Stage releases around user value.

### v0.1 — Alpha (internal, end of Phase 1)
- Core engine + REPL + 6 built-in tools + permissions + sub-agents + basic persistence
- Dogfood only. Not public.

### v0.3 — Private Beta (end of Phase 2)
- MCP + skills + plugins + commands
- Invite-only. Collect feedback on the config + CLI UX.
- This is when you'll change the config schema based on pain. Plan for a breaking migration before v1.

### v0.5 — Public Beta (end of Phase 3)
- Event bus, cron, webhooks, daemon mode
- First public release. Label as beta. Signal that config may still change.

### v0.7 — Scale Beta (end of Phase 4)
- Kafka, SQS, MQTT sources as installable packages
- Adds the enterprise story. First real production users.

### v0.9 — Channel Beta (end of Phase 5)
- Telegram + Slack + Discord
- WhatsApp is stable but requires Meta approval — ship gated-behind-flag.

### v1.0 — GA (end of Phase 7)
- Documentation complete
- Config schema frozen
- SemVer promise from here
- Installer + templates

### v1.1+ — Ecosystem
- Community-contributed adapters
- Template packs for verticals (support, DevOps, data-ops)
- SDK for embedding

---

## 6. Team Structure & Parallelization

### Minimum viable team: 3 engineers + 1 part-time PM/designer

**Team 1: Core** (1 senior eng)
- Owns Phase 0, 1, 3 sequentially
- Reviews every architectural PR

**Team 2: Extensions** (1 eng)
- Owns Phase 2 and 4 (after Phase 1 is stable)
- Parallelizes after Phase 2.1 (MCP client) is up

**Team 3: Channels** (1 eng)
- Starts Phase 5 when Phase 3 is done
- WhatsApp is slow-moving; work on it in parallel with Slack/Discord

**PM/designer**: owns north-star UX, wizard flow, docs, template packs, external comms

### Parallelization timeline (visual)

```
Week:   0----4----8----12----16----20----24----28----32
Core:   [P0][─── P1 ───][── P3 ──][──── P6 ────]
Ext:         [── P2 ──][──── P4 ────]
Chan:                         [────── P5 ──────]
Dist:                                          [─ P7 ─]
                                                       ^v1.0
```

~8 months from 0 → v1.0 with 3 engineers. Compress to 6 with 5 engineers; expand to 12+ solo.

### Critical path

1. Phase 0 blocks everything.
2. Phase 1 blocks Phase 2 and Phase 3.
3. Phase 2 blocks Phase 4 (needs plugin loader for source packages).
4. Phase 3 blocks Phase 5 (channels use event bus).
5. Phase 7 needs Phase 6 complete (no GA without hardening).

### Scaling the team

When you hire engineer #4:
- Second channel engineer (split Slack/Discord from Telegram/WhatsApp)

Engineer #5:
- Platform engineer (dedicated SRE on Phase 6)

Engineer #6:
- DevEx engineer (dedicated to templates, docs, SDK)

---

## 7. Quality Gates Per Phase

Every phase exits with the same gates. No exceptions.

| Gate | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 | Phase 7 |
|---|---|---|---|---|---|---|---|
| Unit tests (≥80%) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Integration tests | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| E2E happy paths | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Chaos tests | — | — | — | ✓ | ✓ | ✓ | ✓ |
| Load tests | — | — | — | ✓ | ✓ | ✓ | ✓ |
| Security review | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Docs updated | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CHANGELOG entry | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Migration script (if schema change) | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Performance benchmark | — | — | ✓ | ✓ | ✓ | ✓ | ✓ |

### Test harnesses to build early

- **`@my-agent/testkit`**: mock LLM (deterministic tool-use scripts), fake MCP server, event-bus fixture, time skip. Build in Phase 1.
- **Record/replay**: capture real sessions, replay against new code. Catches regressions nothing else does.
- **Fuzz the permission gate**: random tool calls with random rules, assert decisions are consistent and gate is never bypassed.

---

## 8. Packaging & Installation Story

What the user actually encounters. Every step below must work.

### Package layout (npm)

| Package | Install behavior |
|---|---|
| `my-agent` | The CLI + core + UI. Global install. |
| `@my-agent/source-kafka` | Drop-in adapter. Auto-detected. |
| `@my-agent/source-mqtt` | Same. |
| `@my-agent/channel-telegram` | Same. |
| `@my-agent/channel-slack` | Same. |
| `@my-agent/plugin-<name>` | Same. |

Auto-discovery: on daemon startup, scan global `node_modules` (and `~/.my-agent/plugins` + local `./.my-agent/plugins`) for `@my-agent/*` packages with the right manifest marker. Register. No manual `require`.

### Installation paths

```bash
# Path 1: npm (default, portable)
npm i -g my-agent

# Path 2: script (no Node assumed; pulls bundled runtime)
curl -fsSL https://my-agent.sh/install | sh

# Path 3: Homebrew (macOS, Linux)
brew install my-agent

# Path 4: Scoop / Winget (Windows)
scoop install my-agent

# Path 5: Docker
docker run -it -v ~/.my-agent:/root/.my-agent my-agent/my-agent

# Path 6: single binary
# Download from GitHub releases; chmod +x; run
```

### First-run checklist (`my-agent doctor`)

```
✓ Binary found at /usr/local/bin/my-agent (v1.0.0)
✓ Config found at ~/.my-agent/config.yaml
✓ API key resolves (keychain:anthropic-api-key)
✓ Anthropic API reachable (latency: 124ms)
✓ 3 plugins loaded (git-helper, pr-review, calendar)
✓ 2 MCP servers healthy (github, postgres)
⚠ 1 channel degraded: slack-prod (missing scope reactions:write)
  → Fix: my-agent channel repair slack-prod
✓ Daemon running (pid 12345, uptime 2d 4h)
```

### Upgrading

```bash
$ my-agent upgrade
Current: v1.0.0  Latest: v1.1.0
Breaking changes: none
Config migrations: 0

Proceed? [Y/n]
```

Automated migration scripts per version bump. **Never ask the user to hand-edit config on upgrade.**

### Uninstall

```bash
$ my-agent uninstall
This will remove:
  - The CLI binary
  - ~/.my-agent/ (sessions, memory, config)

Preserve config and sessions? [Y/n]
```

Complete cleanup. Respectful of user data.

---

## 9. Starter Templates

The `my-agent init` wizard picks from template packs. Each pack is a validated config + recommended plugins/skills.

### `personal-assistant` (no channels, CLI only)

```yaml
# Generated from `my-agent init --template personal-assistant`
identity:
  default_model: claude-opus-4-6
permissions:
  default_mode: default
plugins:
  - id: git-helper
skills:
  search_paths: [~/.my-agent/skills]
```

Use case: power-user developer on their workstation.

### `team-assistant` (Slack + GitHub)

```yaml
identity: { default_model: claude-sonnet-4-6 }
daemon: { enabled: true }
permissions:
  default_mode: auto
  rules:
    allow: [Read(**/*), mcp__github__*, Bash(gh *)]
mcp:
  servers:
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
channels:
  - id: slack-main
    type: slack
    transport: { mode: socket, bot_token: "${keychain:slack-bot-token}" }
event_sources:
  - id: github-webhook
    type: webhook
    path: /hooks/github
    routing: { target: { type: skill, name: triage-issue } }
skills:
  search_paths: [~/.my-agent/skills]
```

Use case: engineering team that wants a Slack-native code reviewer / PR helper.

### `multi-channel-bot` (Telegram + WhatsApp)

Focused on customer-facing use cases. More conservative permissions.

### `ops-automation` (webhooks + cron + daemon)

PagerDuty + GitHub + Grafana alertmanager feeds → investigation skills → Slack reports. Headless by default.

### `full-platform` (everything)

Kafka + MQTT + webhooks + Slack + Discord + Telegram + all built-in tools. The "enterprise" template.

### Custom

Blank config + prompt walks through each section.

---

## 10. Documentation Strategy

Docs are a feature. Treat like one.

### Three-tier structure

1. **Getting Started** (10 minutes to first working agent)
   - Install → first prompt → add a tool → add a channel
2. **Guides** (recipes for common use cases)
   - "Build a PR review bot"
   - "Trigger an agent from a Kafka topic"
   - "Expose an agent on Telegram"
   - "Write your first plugin"
3. **Reference** (complete API + config schema)
   - Auto-generated from TypeScript types
   - Every config field documented with example
   - Every CLI command has a dedicated page

### Auto-generation pipeline

- Config schema → docs via Zod introspection
- CLI command help → docs via Commander
- TypeScript types → Markdown via typedoc
- Each PR that changes public API must update docs; CI checks.

### Interactive docs (bonus)

- "Try it" buttons that spawn a sandboxed config
- Playground for skills (paste markdown, see rendered output)

### Translations

English first; add 2–3 languages (Simplified Chinese, Spanish, Japanese) after v1.0 based on user geography.

---

## 11. Risk Register

The things that will bite. Plan for them now.

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | WhatsApp template approval rejects during Phase 5 | High | High | Start template registration on week 1 of Phase 5. Have 3 fallback phrasings. Ship WhatsApp as opt-in behind flag first. |
| 2 | Config schema needs breaking change post-v1.0 | High | Medium | v0.3-v0.9 breaks freely with migration scripts. Only lock schema at v1.0. Have migration infrastructure already battle-tested. |
| 3 | MCP protocol evolves (spec updates) | Medium | Medium | Pin to spec version; maintain compat tests against reference impl. |
| 4 | Anthropic API surface changes (tool use shape, thinking blocks) | Medium | High | Abstract LLM client; don't leak Anthropic types into core. Keep an adapter layer. |
| 5 | Ink/terminal UI bugs on Windows | High | Medium | Windows CI from day one. Fallback to plain-readline renderer. |
| 6 | Permission bypass due to bug | Low | Critical | Fuzz tester for permission gate. Security review per phase. Separate audit log. |
| 7 | Leaked API key or webhook secret | Medium | High | Keychain-first; refuse to start with plaintext secrets in config; rotation playbook. |
| 8 | Infinite event loops (agent triggers itself) | Medium | Medium | `meta.causedBy` chain; max-depth enforcement; circuit breakers. |
| 9 | Kafka/SQS adapter edge case eats messages | Low | Critical | After-publish ack default; integration tests with real brokers; replay API. |
| 10 | Sub-agent blowup (recursive spawning) | Medium | High | `AgentTool` excluded from sub-agent toolsets by default. Max recursion depth. |
| 11 | Config drift between machines | High | Low | `config.local.yaml` pattern; explicit sync story; `my-agent config diff`. |
| 12 | Docs go stale | Very high | Medium | Auto-gen from types; doc-check in CI; "docs debt" label enforced. |
| 13 | Plugin compatibility breaks on minor releases | Medium | High | `agent_compat` manifest field; SDK released separately with SemVer; deprecation windows. |
| 14 | LLM cost blowup from chatty event sources | High | Medium | Per-target rate limits; session coalescing; cost visibility in `my-agent cost`. |
| 15 | Poor onboarding → bounce | High | High | Measure wizard completion rate. A/B wizard copy. Telemetry (opt-in). |

### Triage rules

- **Critical impact + ≥Medium likelihood** → full mitigation must ship before the phase exits.
- **High impact** → mitigation scheduled; track in roadmap.
- **Below that**: backlog, revisit quarterly.

---

## 12. Observability & Operations

What you need to run this in production.

### Instrumentation (pervasive)

- **Logs**: structured JSON, correlation IDs, PII-redacted
- **Metrics**: Prometheus + OTel; every subsystem exposes counters, gauges, histograms
- **Traces**: OTel; every event gets a trace from source → target
- **Audit**: append-only JSONL of every tool call, permission decision, event dispatch

### Dashboards (ship in Phase 6)

Pre-built Grafana JSON; users import.

- **Overview**: active sessions, events/sec in, events/sec processed, error rate
- **Cost**: tokens by model, by session, by channel; daily/weekly/monthly
- **Events**: per-source lag, DLQ depth, failure rates
- **Permissions**: prompts/sec, denials, auto-approvals, most-denied tools
- **Channels**: messages sent/received per channel; p50/p99 reply latency

### Alerts (ship in Phase 6)

Prometheus rules included in template packs.

- Source lag > N minutes
- DLQ depth > 0 for > 5 min
- Daemon memory > threshold
- Error rate > 1% over 5 min window
- Token spend > daily budget threshold

### Incident playbooks

Ship these in docs:

- "Daemon crashed" — restart, logs, common causes
- "Source can't connect" — credential rotation, broker check, DNS
- "Agent stuck" — trace, cancel, restart session
- "Cost spike" — identify source, rate-limit, pause

### Runtime control

- `my-agent pause <source-id>` / `resume`
- `my-agent session kill <id>`
- `my-agent dlq list | replay <id> | drop <id>`
- `my-agent permissions revoke <rule>` (immediate effect)

Ops-ability is not a v2 feature. It ships with v1.

---

## 13. Go-to-Market

The platform exists. How does it get users?

### Early access (months 1–4, during Phases 1–3)

- Internal dogfooding
- 10–20 design-partner teams with direct access
- Weekly office hours; rapid iteration on pain points

### Public beta launch (end of Phase 3)

- Docs site goes live
- HN + Reddit (`/r/LocalLLaMA`, `/r/programming`) posts
- Demo video (< 3 min)
- Clear "beta, config may change" messaging

### Community building (Phases 4–6)

- Discord for users
- GitHub Discussions for Q&A
- "Awesome my-agent" repo of community skills/plugins/templates
- Monthly community call

### Enterprise outreach (Phases 5–7)

- Security whitepaper
- SOC 2 roadmap (Phase 6)
- Sales engineering materials (solution briefs per vertical)
- Reference customers (from design partners)

### v1.0 launch

- Launch day: HN front page attempt, X/Twitter, LinkedIn, newsletter
- Launch partners: 3–5 named customers with testimonials
- Follow-up content cadence: blog post per week for 8 weeks

### Ongoing

- Weekly release cadence
- Conference talks (pitch starting month 6)
- Sponsor key OSS projects that align

---

## 14. Success Metrics

Measure what matters. Not vanity.

### Product metrics

| Metric | v0.5 target | v1.0 target | v2.0 target |
|---|---|---|---|
| Time from install to first prompt | < 2 min | < 1 min | < 30 sec |
| Time from install to first channel live | < 30 min | < 10 min | < 5 min |
| Wizard completion rate | 40% | 60% | 75% |
| Daemon 30-day uptime | 99% | 99.9% | 99.95% |
| Mean p99 tool-call latency | < 5s | < 2s | < 1s |
| Permission prompt rate (under `auto` mode) | — | < 5% | < 2% |

### Ecosystem metrics

| Metric | 6 months post-v1 | 1 year post-v1 |
|---|---|---|
| Published `@my-agent/*` community packages | 20 | 100 |
| Community-contributed skills (registry) | 50 | 500 |
| GitHub stars | 2K | 15K |
| Active installs (opt-in telemetry) | 1K | 20K |
| Discord members | 500 | 5K |

### Business metrics (if commercial)

| Metric | 6 months post-v1 | 1 year post-v1 |
|---|---|---|
| Design-partner conversions | 5 | 15 |
| Revenue (if commercial tier) | — | TBD |
| Enterprise pilots | 2 | 10 |

### What NOT to measure

- Raw API calls (doesn't reflect value delivered)
- Session count (encourages session spam over quality)
- Total tokens (encourages waste)

### Review cadence

- Weekly: operational metrics (uptime, latency, errors)
- Monthly: product metrics (install, completion, retention)
- Quarterly: ecosystem + business metrics + roadmap rebalance

---

## 15. Cross-Cutting Concerns

Things that span every phase. Don't "do them later" — bake them in from day one.

### 15.1 Security

- Threat model documented and reviewed before any external release (beta onwards)
- Permission gate never bypassable; fuzz tested every phase
- Secrets in keychain; refuse to start with plaintext secrets in config
- Every adapter auth'd; webhook signatures verified; bearer tokens scoped
- Third-party plugins require explicit consent dialog with declared permissions
- Audit log is tamper-evident (hash chain)
- CVE disclosure policy + SECURITY.md from day one

### 15.2 Privacy

- Telemetry opt-in only; first-run prompt
- Zero PII in telemetry (sampled request shapes, not contents)
- Session transcripts stay local by default; only team-sync if opted in
- Audit log PII-redacted based on configurable patterns

### 15.3 Internationalization

- UTF-8 everywhere; tested with non-Latin scripts from Phase 1
- User-facing strings externalized from Phase 2 onwards (not just at v1.0)
- Right-to-left renderer support before channels ship (some languages)

### 15.4 Accessibility

- REPL must work with screen readers (VoiceOver on macOS, NVDA on Windows)
- Color not the sole signal (high-contrast mode, symbols alongside colors)
- Keyboard-only operation (no mouse required ever)

### 15.5 Performance budgets

- Cold start: < 500ms to REPL ready
- First-token latency: < 2s (model-dependent)
- Memory: < 150MB resident for CLI, < 500MB for daemon with 10 active sessions
- Disk: transcript + memory writes are async, zero blocking on agent loop

Measure every phase. Regressions block merge.

### 15.6 Backwards compatibility

- Config schema: SemVer from v1.0
- Plugin API: SemVer from v1.0, with deprecation windows
- CLI commands: stable flags from v1.0; additions only
- Breaking changes before v1.0 are expected; document migration in CHANGELOG
- Support n-1 major: v2.x must be able to migrate v1.x configs

### 15.7 Supply chain

- `npm audit` in CI; fail on high/critical
- Dependabot (or equivalent) for deps
- Sigstore signing for releases (post-Phase 6)
- SBOM published per release
- Pinned `package-lock.json` / `pnpm-lock.yaml`

### 15.8 Cost awareness

- Every operation that calls the LLM has a visible cost counter
- Daily / monthly budget limits enforceable in config
- Cost by channel / session / skill surfaced in `my-agent cost`
- Dry-run mode for new triggers (compute cost without executing)

---

## Closing Thought

The six prior docs described **what** to build. This plan describes **how** to build it without collapsing under the weight of its own ambition. Three rules drive everything:

1. **Build bottom-up.** Core before extensions. Extensions before events. Events before channels. Shortcuts here cost 3× later.
2. **Ship weekly.** v0.1 → v0.3 → v0.5 → v0.7 → v0.9 → v1.0. Each jump adds one layer. Dogfood every release.
3. **Protect the UX.** Every design decision funnels back to "does this make `my-agent init` easier?" If not, push it behind a flag.

~8 months with 3 engineers. Faster with more, but the critical path has shape — you can't compress the core layers by throwing bodies at them. The channel and adapter work *does* parallelize, and that's where extra hands pay off.

What the user sees at the end: they install a CLI, answer a few questions, and have a working multi-channel, multi-source, multi-skill agent — without reading a line of code. That's the platform. That's the win.

Start with Phase 0 tomorrow. Pick the three-person team. Put up the first PR by Friday. Ship.

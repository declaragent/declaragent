# Requirements Spec & Implementation Plan

**Working name:** Declaragent (placeholder — see Part 7).
**Status:** Canonical. Supersedes the 8 background design docs listed at the end.
**Last updated:** 2026-04-15.

---

## Part 1 — Product Overview

**Thesis.** A deployed agent is a stable runtime **core** (LLM loop, tool contract, permission gate, event dispatcher) plus a git-versioned declarative **configuration** (identity, tools, skills, plugins, event sources, channels, permissions, secrets, storage, deployment). The core is immutable and shared across every agent. The configuration — one `agent.yaml` file — is the user's product: checked into their repo, diffable, code-reviewed, pinned to a commit, and rolled back with `git revert`. The platform ships a conversational Builder that turns requirements into this spec, a Runtime that executes it, and cloud adapters that deploy it without the user touching a cloud console.

**Primary users.** DevOps/SRE and platform engineers who have "laptop scripts" that never made it to production — agents that respond to webhooks, triage alerts, or monitor systems — because containerization, IAM, and channel wiring are too much per-agent toil.

**Secondary users.** Individual developers who want personal CLI assistants and team bots that survive the laptop closing.

**Tertiary users.** Teams at scale (fintech, logistics, IoT) needing event-driven agents that consume high-throughput brokers (Kafka, MQTT, SQS) and react across multiple messaging platforms under strict cost and permission controls.

**What this is not.** Not a new LLM, a new prompt DSL, a visual canvas, a fine-tuning platform, a vector database, or an evals harness. Each is integrated, none reimplemented.

---

## Part 2 — Functional Requirements

### 2.1 Core agent runtime
- Streaming LLM loop with tool-call parsing, thinking mode, retries, and token accounting.
- Tool dispatch through a single `Tool` contract (input schema, permission check, execute, progress).
- Sub-agent spawning via recursive `runAgent()` with isolated context and scoped permissions.
- Context compaction with pluggable strategies (trim, summarize, selective drop).
- Session transcripts persisted atomically; `/resume` restores a prior session.

### 2.2 Tool system
- Built-in tools: `Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Agent`, `Skill`, `SendMessage`, `CronCreate`, `WebFetch`, `WebSearch`.
- Permission gating on every tool call. Modes: `default` (prompt), `plan` (deny all writes), `bypass` (allow all — requires flag), `auto` (allow allowlisted, prompt rest).
- Denial escalation: after 3 consecutive denials in a session, escalate to a blocking prompt.
- Rules use glob matching (e.g., `Bash:git *`, `Read:/tmp/**`). Exact matches supported; regex explicitly rejected.

### 2.3 Extension system
- **MCP client** — stdio and HTTP transports; discovers tools, resources, prompts; auto-restart on crash; version-pinned.
- **Skills** — markdown + frontmatter bundles (name, description, triggers, inputs, outputs, prompt body). Three-tier search paths: user-local > team > plugin > built-in. Namespaced by plugin (`plugin:skill`).
- **Plugins** — distribution units bundling tools, commands, skills, MCP configs, and hooks. Manifest-driven. Consent flow on install.
- **Hooks** — pre/post tool use, pre/post skill, pre/post event. Compliance intercept hook-point.
- Unified `ExtensionRegistry` spine. One activate/deactivate lifecycle. Hot reload on macOS/Linux.

### 2.4 Event-driven runtime
- `EventBus` with pub/sub history and correlation chains (`causedBy`).
- `EventDispatcher` routing to session / new-session / skill / sub-agent / broadcast.
- `SessionManager` keyed by ID, with pluggable storage (SQLite local, Postgres cloud).
- Daemon mode: long-running process with control socket + HTTP control plane; graceful shutdown (pause sources → flush inflight → stop in reverse order); SIGHUP hot reload.

### 2.5 Event sources
- `EventSourceAdapter` contract + `EventSourceRegistry`. Auto-discovery of `@declaragent/source-*` packages.
- Built-in: cron, webhook (HMAC + bearer), file-watch (chokidar).
- External packages: Kafka, MQTT, AMQP, SQS, NATS, Redis Streams, Kinesis, Pulsar, WebSocket, gRPC, GCP Pub/Sub, Azure Service Bus, CDC (Debezium), S3, IMAP, RSS.
- `MessageNormalizer` converts raw payload to `AgentEvent` via JSON-path routing and schema registry (Confluent compatibility at v1.0).
- `BaseSourceInstance` shared base: retry, DLQ, metrics, health, pause/resume, circuit breaker.

### 2.6 Communication channels
- `ChannelAdapter extends EventSourceAdapter` — bidirectional with capability negotiation (threads, reactions, typing, file upload, rich blocks).
- Telegram, Discord, Slack, WhatsApp at v1.0. Platform-neutral outbound; adapter translates to Block Kit / Discord embeds / Telegram keyboards.
- Per-channel rate limits, identity mapping, and permission overrides.

### 2.7 Declarative configuration (`AgentSpec`)
Single YAML file with:
- `apiVersion`, `kind`, `metadata` (name, owner, labels).
- `spec.identity` (model, system prompt ref, temperature, max tokens).
- `spec.tools` (allowlist + rules).
- `spec.skills`, `spec.plugins`, `spec.mcpServers`.
- `spec.eventSources[]`, `spec.channels[]`.
- `spec.permissions` (mode, allow, deny, overrides per channel).
- `spec.secrets` (references only, never inline).
- `spec.storage` (sessions backend, archive config).
- `spec.observability` (OTel endpoint, log level, metrics export).
- `spec.deployment` (target, region, resources, budget).
- Spec is JSON-Schema validated at load. Version field pins MCP protocol and spec semver.

### 2.8 CLI + Builder
- `my-agent init` — conversational wizard; produces `agent.yaml`.
- `my-agent run ./agent.yaml` — local run; same binary as cloud runtime.
- `my-agent deploy` — build image → push → deploy to target. Idempotent.
- `my-agent deploy --dry-run` — show diff against live.
- `my-agent logs`, `my-agent rollback <rev>`, `my-agent cost`, `my-agent migrate`.
- Builder agent (itself a Declaragent agent) handles the conversational authoring flow; talks to cloud adapters via the control plane.
- Slash commands in REPL: `/cost`, `/compact`, `/memory`, `/clear`, `/plan`, `/rules`, `/resume`.

### 2.9 Distribution
- `npm install -g declaragent` (global CLI).
- Homebrew formula, curl-bash installer, single-binary via `bun build --compile`.
- Template packs: `personal-assistant`, `team-assistant`, `multi-channel-bot`, `ops-automation`, `full-platform`.
- Docs site (Docusaurus) with spec reference, cookbook, and provider matrix.

---

## Part 3 — Non-Functional Requirements

**Latency.** First-run install completes in <30s on standard broadband. REPL permission prompt renders <2s from tool-call receipt. Webhook → event-bus admission <500ms p95. Skill execution latency dominated by LLM; agent overhead <200ms p95.

**Throughput.** Per-source `maxInflight` backpressure mandatory. Target 10K events/sec aggregate on Kafka with horizontal replicas; single-replica target 1K events/sec. Per-source concurrency caps prevent one topic starving another.

**Durability.** At-least-once delivery is default for every source. At-most-once is an opt-in for fire-and-forget cases. Session transcripts persisted atomically (WAL-backed). DLQ support on every adapter (transport-native where available, otherwise agent-managed).

**Security.**
- Permission gate on every tool call; never bypassed by the core.
- Four modes: `default`, `plan`, `bypass` (requires explicit flag + prompt), `auto`.
- 3-denial escalation policy.
- Webhook HMAC verification + bearer token auth. TLS terminated at the cloud adapter's ingress.
- Secrets stored in external backend (Vault / AWS SM / GCP SM / K8s); never in `agent.yaml` or image.
- Plugin consent flow on install: plugin declares permissions; user approves.
- Audit log with event IDs + correlation chains; retained per spec setting.

**Reliability.**
- Graceful shutdown with SIGTERM grace period (default 30s).
- Reconnect with exponential backoff + jitter (caps at 60s).
- Circuit breaker per external dependency (open after N consecutive failures, half-open after cooldown).
- Per-source health endpoint (liveness, last message timestamp, lag, error count).
- Hot reload (daemon, macOS/Linux): SIGHUP reloads config, sources, plugins without dropping inflight events. Windows requires daemon restart (documented).

**Scalability.**
- Daemon is stateless; sessions keyed by ID in the shared storage backend.
- Routing layer (load balancer or NATS queue group) pins a session to one replica for its lifetime.
- Horizontal scaling is linear up to the storage backend's IOPS ceiling.

**Observability.**
- OpenTelemetry for metrics and traces (lazy-loaded; ~400KB not hoisted).
- Prometheus export endpoint.
- Per-source lag dashboard (Grafana templates shipped).
- Correlation chain (`causedBy`) on every event.

**Cost control.**
- `spec.deployment.budget.dailyTokenUSD` hard cap. Runtime refuses to process new events once exceeded; DLQ captures rejected events for next day.
- Per-session cost attribution.
- `my-agent cost` surfaces drift between Builder estimate and actual.

---

## Part 4 — Architecture

### 4.1 Core vs. configuration
The **core** is the Declaragent binary — engine, tool contract, permission gate, event dispatcher, session manager, extension registry. It is immutable and versioned as a single SemVer artifact. The **configuration** is the user's `agent.yaml` plus referenced files (prompts, skills). Configuration is git-versioned; core is image-versioned. An agent deployment pins both.

### 4.2 Two-tier deployment
- **Builder** runs locally as a CLI. It authors spec, builds images, talks to cloud adapters, manages lifecycle.
- **Runtime** runs in the cloud (or locally via `my-agent run`). Same binary, different entrypoint and feature flags. Runtime does not depend on Builder being reachable.
- A **control plane** bridges them: agent-side reports health, lag, cost, DLQ depth; builder-side issues lifecycle ops.

### 4.3 Monorepo structure
`packages/core`, `cli`, `daemon`, `sdk`, `registry`, `mcp`, `skills`, `plugins`, `events`, `source-{cron,webhook,file,kafka,mqtt,amqp,sqs,nats,redis-streams,kinesis,pulsar,websocket,grpc,gcp-pubsub,azure-sb,cdc,s3,imap,rss}`, `channel-{telegram,discord,slack,whatsapp}`, `tools-builtin`, `template-packs`, `testkit`.

### 4.4 Key interfaces
`EventSourceAdapter`, `EventSourceInstance`, `ChannelAdapter`, `MessageNormalizer`, `BaseSourceInstance`, `PermissionContext`, `Extension`, `ExtensionContext`, `Tool`, `Skill`, `PluginManifest`.

### 4.5 Cloud adapters
GCP Cloud Run, AWS Fargate, Fly.io, Cloudflare Workers (limited — no long-running sources), Render, self-hosted Kubernetes. Each adapter implements a common `CloudAdapter` contract: build, push, deploy, logs, rollback, destroy. Conformance test suite enforces parity.

---

## Part 5 — Implementation Plan (8 Phases)

### Phase 0 — Foundations (1–2 weeks)
**Goal.** Development infrastructure.
**Scope.** pnpm + Turborepo monorepo. Strict TypeScript. CI (lint, typecheck, test). Release pipeline via changesets → npm. Base container image. License + contributor docs.
**Exit.** Empty package publishes cleanly to npm via CI.

### Phase 1 — Core Agent (4–6 weeks)  →  **v0.1 internal**
**Goal.** Usable local agent.
**Scope.** Engine skeleton (streaming LLM loop, tool dispatch). Tool interface + built-in tools (Bash, Read, Write, Edit, Grep, Glob, Agent). Permission gate with 4 modes, 3-denial escalation. Ink-based REPL. Session persistence (SQLite) + `/resume`. Sub-agents with depth cap. Slash commands (`/cost`, `/compact`, `/memory`, `/clear`, `/plan`, `/rules`).
**Exit.** One team engineer does a full week of real work in the REPL without falling back to other tools.

### Phase 2 — Extensibility (4–6 weeks)  →  **v0.3 private beta**
**Goal.** Third-party extension points.
**Scope.** MCP client (stdio + HTTP, tool wrapping, auto-restart). Skills loader (markdown + frontmatter, three-tier search, namespacing). Plugin loader + manifest (tools, commands, skills, MCP configs, hooks). Hooks registry. CLI admin commands (`plugin install/list/remove`, `skill list`, `mcp add/remove`). Plugin consent flow.
**Exit.** External developer installs `@declaragent/plugin-github`, adds GitHub MCP, writes a `pr-review.md` skill — using only the README.

### Phase 3 — Event-Driven Core (3–4 weeks)  →  **v0.5 public beta**
**Goal.** Agent-as-service.
**Scope.** `EventBus` + pub/sub + history. `EventDispatcher` routing (session / new-session / skill / sub-agent / broadcast). Built-in sources: cron, webhook (HMAC + bearer), file watcher. Mailbox for inter-agent messaging. Daemon mode: control socket + HTTP control plane, graceful shutdown, SIGHUP hot reload.
**Exit.** Agent receives a GitHub webhook in staging, runs a skill, posts to Slack. Daemon survives SIGHUP reload with zero dropped events.

### Phase 4 — Scale Event Sources (4–6 weeks)  →  **v0.7 scale beta**
**Goal.** Production brokers.
**Scope.** `EventSourceAdapter` contract + registry. `MessageNormalizer` with JSON-path routing + Confluent Schema Registry. Delivery semantics: at-least-once (default), at-most-once (opt-in), DLQ, idempotency key exposure. Adapters shipped as separate packages: Kafka (SASL, consumer groups, offset commit, retry topic), SQS (long-polling, FIFO, visibility timeout), MQTT (QoS 0/1/2, durable session), AMQP (prefetch, DLX), NATS (JetStream + queue groups). Observability: OTel metrics, per-source health, lag dashboard.
**Exit.** Load test sustains 1K msg/sec on Kafka adapter with <5s p99 end-to-end latency; zero message loss under broker restart.

### Phase 5 — Communication Channels (5–7 weeks)  →  **v0.9 channel beta**
**Goal.** Bidirectional messaging.
**Scope.** `ChannelAdapter` contract with capability negotiation. Telegram (long-polling + webhook, MarkdownV2, inline keyboards). Discord (Gateway + HTTP interactions, embeds, threads, archived-thread auto-unarchive). Slack (Socket Mode + Events API, Block Kit, threads). WhatsApp (Meta Cloud API, 24-hour window enforcement, template registry via `my-agent channel whatsapp templates`, reply buttons). Platform-neutral outbound with adapter translation.
**Exit.** Bidirectional conversation on each of the four channels with threads, reactions, typing indicators, and file upload demonstrated in a single demo session.

### Phase 6 — Operations (3–4 weeks)
**Goal.** Production hardening.
**Scope.** Observability maturation (Prometheus export, Grafana dashboards, alert rules). Security hardening: external threat model, secret-rotation audit, HMAC timing-safe comparison review, dependency scanning. Multi-tenant support: per-tenant namespaces on EventBus, secret store, and audit log; enforced at the registry layer. Chaos testing harness.
**Exit.** Pen test passes; chaos test (random pod kill every 60s for 1h) shows zero data loss; multi-tenant isolation test shows zero cross-tenant leakage.

### Phase 7 — Distribution (2–3 weeks)  →  **v1.0 GA**
**Goal.** Public launch.
**Scope.** Installers (npm global, Homebrew, curl-bash). Single-binary via `bun build --compile`. Template packs (5 starters). Docusaurus docs site (spec reference, cookbook, provider matrix, troubleshooting). Config is frozen; SemVer promise begins.
**Exit.** New user runs `curl ... | sh && my-agent init` and ships a working agent to GCP Cloud Run in under 10 minutes.

### Critical path
Phase 0 → Phase 1 → {Phase 2 ∥ Phase 3} → Phase 4 (needs Phase 2 plugin loader) → Phase 5 (needs Phase 3 event bus) → Phase 6 → Phase 7.

### Parallelization
- After Phase 1: Team A runs Phase 3 (events) while Team B runs Phase 2 (extensibility).
- After Phase 2.1 (MCP stable): Team B parallelizes Phase 4 adapters — each ~2–3 days of focused work.
- After Phase 3 complete: Team C (channels) runs Phase 5; Slack + Discord parallel to WhatsApp (different APIs, no shared critical code).
- Phase 6 partially overlaps Phase 5 (security review can start with Phase 4 code).

### Release train
v0.1 → v0.3 → v0.5 → v0.7 → v0.9 → v1.0.

---

## Part 6 — Resolved Gap Decisions

Each item is a previously flagged open question with an explicit decision.

1. **Exactly-once delivery** → At-least-once + mandatory idempotency keys exposed to skill authors as `event.idempotencyKey`. Skill framework provides a `deduplicate(key)` helper backed by session storage. Rationale: exactly-once across network boundaries is impossible; idempotency is the industry-standard workaround. Exposing the key makes skill authors responsible for correctness rather than hiding the problem.

2. **Session state durability across replicas** → Sessions are keyed by ID and stored in a pluggable backend (default: SQLite local, Postgres cloud). Replicas are stateless. Routing layer pins a session to one replica for its duration. If a replica dies mid-skill, at-least-once delivery re-drives the event; the idempotency key prevents duplicate side effects.

3. **Secret rotation + audit** → Secrets are never stored in Declaragent. `${secret:name}` references resolve at runtime against Vault / AWS SM / GCP SM / K8s Secrets. Rotation is the backend's responsibility. Declaragent logs every secret resolution (name + requester + timestamp, value omitted) to the audit log.

4. **Sub-agent recursion depth** → Hard cap of 2 by default, overridable in spec up to 4. Enforced in the core (`runAgent` tracks depth in context), not config. Per-request cost ceiling provides an independent implicit bound.

5. **Skill name collisions** → Skills are namespaced by plugin (`plugin-name:skill-name`). Unqualified lookup resolves by precedence: user-local > team > plugin > built-in. Loader warns on any ambiguous resolution.

6. **MCP protocol version compatibility** → Declaragent pins one MCP protocol version per release. `AgentSpec` can pin its required MCP version. Breaking protocol changes trigger a spec migration via `my-agent migrate`.

7. **Multi-tenant RBAC** → Each agent runs in its own container by default (strong isolation). Shared-tenant mode (post-v1.0) uses per-tenant namespaces on the EventBus, secret store, and audit log; tools cannot cross namespaces; enforced at the registry layer.

8. **WhatsApp 24-hour window** → The channel adapter tracks last-inbound-message timestamp per user. Outside the window, outbound sends require an approved template. The adapter rejects non-template sends with a structured error surfaced to the skill. Template registration is a separate CLI command: `my-agent channel whatsapp templates`.

9. **Discord archived-thread sends** → Adapter auto-unarchives the thread before send (Discord API supports this) by default, or falls back to a parent-channel reply with a cross-link. Behavior is configurable per channel in spec.

10. **Polling-source replay** → Opt-in `archive` config per source routes a copy of every raw event to a durable store (S3, GCS, local disk). Replay reads from the archive, never from the broker.

11. **Schema registry scope** → Ship Confluent Schema Registry compatibility at v1.0 (covers the majority of real deployments). Other registries (Humio, custom) via plugin.

12. **Plugin hot reload on Windows** → Daemon hot reload supported on macOS and Linux only. Windows requires daemon restart. Documented limitation, not launch-blocking.

13. **Discord privileged intents** → Adapter requests minimum intents by default. Enabling `MESSAGE_CONTENT` or presence intents requires an opt-in flag in spec plus a user acknowledgment in the CLI. Scaling beyond 100 servers requires Discord approval — that process is out of Declaragent's scope.

14. **Permission rule matching** → Glob-based (`Bash:git *`, `Read:/tmp/**`). Exact match is a special case of glob. Regex is rejected as error-prone. Rules are validated at spec load time.

15. **Cost estimation accuracy** → Builder's initial estimate is explicitly labeled as a lower bound. Runtime tracks actual cost and surfaces drift via `my-agent cost` and OTel metrics. `dailyTokenUSD` is a hard stop regardless of estimate.

16. **Human feedback loop to spec refinement** → Out of scope for v1.0. Audit log and session transcripts provide raw material; refinement is manual. Auto-refinement is a v2 research item.

---

## Part 7 — Open Decisions

Decisions the team must make; not design gaps.

- **Product name.** Prior search eliminated Agentfile, Agent Builder, Helm, Stencil, Manifest (all taken or colliding with OpenAI/Microsoft/Kubernetes). Next step: shortlist 3 coined names; verify domain, npm scope, and GitHub org availability before committing.
- **License.** Apache 2.0 (maximum ecosystem) vs. Business Source License (prevents cloud competitors from hosting). Affects plugin ecosystem dynamics.
- **Commercial model.** Open-core CLI + runtime; managed control plane (team RBAC, cost dashboards, audit retention, hosted secrets) in private beta Q3 2026.
- **Governance.** Single-company stewardship vs. CNCF-style foundation. Defer until post-v1.0; single-company for speed during v0.x.
- **First design partners.** Identify 3 teams for Phase 1 dogfooding. Bias toward teams with existing "laptop script" pain.

---

## Part 8 — Verification & Acceptance

How to know each phase is actually done (not just merged).

- **Phase 0.** CI pipeline green on an empty package. `npm publish --dry-run` succeeds from the release workflow.
- **Phase 1.** One engineer runs a full workweek of real work in the REPL without reaching for another tool. Tool-call permission gate passes a red-team review (no escape paths).
- **Phase 2.** A developer outside the core team installs `@declaragent/plugin-github`, adds the GitHub MCP server, and writes a `pr-review.md` skill using only the README. No core-team help.
- **Phase 3.** Agent in staging receives a live GitHub webhook, runs a skill, posts to Slack — end to end, under 5 seconds p95. Daemon survives `kill -HUP` with zero dropped events verified by correlation IDs.
- **Phase 4.** Kafka load test: 1K msg/sec sustained for 30 minutes. p99 end-to-end latency <5s. Zero message loss verified across a broker restart. DLQ depth stays bounded.
- **Phase 5.** Single demo session exhibits bidirectional conversation on Telegram, Discord, Slack, and WhatsApp, including thread creation, reactions, typing indicators, and file upload on each.
- **Phase 6.** External pen test passes with no critical findings. Chaos test — random pod kill every 60s for 1 hour — shows zero data loss. Multi-tenant isolation test shows zero cross-tenant data, event, or secret leakage.
- **Phase 7.** A new user runs `curl https://get.declaragent.dev | sh && my-agent init`, answers the wizard, and has an agent running on GCP Cloud Run in under 10 minutes. Measured, not estimated.

---

## Background reading

This document consolidates and supersedes:
- `MASTER_PLAN.md`
- `BUILDING_A_GENERIC_AGENT.md`
- `AGENT_BUILDING_AGENT.md`
- `EVENT_DRIVEN_AGENT.md`
- `EVENT_SOURCE_REGISTRY.md`
- `COMMUNICATION_CHANNELS.md`
- `EXTENDING_YOUR_AGENT.md`
- `IMPLEMENTATION_PLAN.md`

Kept as-is for historical context; conflicts resolve to this document.

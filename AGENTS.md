# AGENTS.md

**Honest production-readiness audit of Declaragent, as of 2026-04-21 (CLI v0.4.16).**

This file exists because CLAUDE.md's status summary grew optimistic as the surface area expanded. Status claims here are backed by (a) grep of the runtime happy path, and (b) cross-checked against the canonical plan docs under `docs/` — `SPEC_AND_PLAN.md` is the source of truth for *intent*, the code is the source of truth for *what runs*.

The most common trap is conflating **"designed in the plan"** with **"wired at runtime"**. Many core primitives exist as exported APIs but are never called from `declaragent up` / `fleet run` / `run-agent-cli`. This document separates those two axes.

---

## Status rubric

Every row uses one of four marks:

| Mark | Meaning |
| --- | --- |
| ✅ | Runtime-wired + happy-path verified + tested |
| 🟡 | **Designed + code exists** but runtime entry points (`up`, `fleet run`) don't load it. User-visible gap. |
| 🔵 | **Deferred by plan** to a later phase/version. Not a gap — intentional. |
| ❌ | Neither designed nor implemented |

---

## 1 · Define agents with capabilities + skills

| Capability | Status | Evidence |
| --- | --- | --- |
| `agent.yaml` loads name/model/systemPrompt/skills/tools.defaults | ✅ | `packages/core/src/agents/load-agent.ts` — Zod schema + `AgentConfigError` |
| Skills discovered from `skills/*.md` + registered per-agent | ✅ | `loadSkills()` + `skillExtension()`; unit tests |
| Skills invoked via sub-agent (`runSkill`) | ✅ | `packages/core/src/skills/runner.ts` — covered by tests |
| Built-in tools available inside skills (`Read/Write/Edit/Glob/Grep/Bash/Agent`) | ✅ | `packages/cli/src/builtin-tools.ts` |
| `agent.yaml` declares channels/sources/plugins inline | ❌ | Schema has none; each config type has its own file. Matches `SPEC_AND_PLAN.md` §2.1 — intentional separation. |

---

## 2 · Tools, MCP, plugins

| Capability | Status | Evidence |
| --- | --- | --- |
| 7 built-in tools registered by every runtime | ✅ | `builtin-tools.ts` imported by `up`, `run-agent-cli`, `fleet-run-llm-handler` |
| Builder toolkit (13 tools for conversational authoring) | ✅ | `packages/cli/src/builder/` — gated by `DECLARAGENT_BUILDER=on` |
| `declaragent mcp add` stores server spec | ✅ | `mcp-cli.ts` + `mcp-config.ts` |
| **MCP servers spawn + expose tools to skills at runtime** | 🟡 | `createMCPConfigStore` is only called from `mcp-cli.ts` (the CLI verb). `grep` across `up-cli.ts` / `fleet-run-llm-handler.ts` / `run-agent-cli.ts` returns zero hits. Plan (`EXTENDING_YOUR_AGENT.md` §3) describes the `McpClient` integration — unwired in runtime. |
| `declaragent plugin install` stores entry + consent | ✅ | `plugin-cli.ts` + `PluginConsent` Ink UI |
| **Plugins activated (tools registered in skill's tool list)** | 🟡 | `loadPluginManifest` / `createPluginStore` are imported only by builder + `plugin-cli.ts`. Neither `up` nor `fleet run` calls them per-session. Plan (`EXTENDING_YOUR_AGENT.md` §6) specifies activate/deactivate lifecycle — unwired in runtime. |

---

## 3 · Agent-to-agent communication

| Capability | Status | Evidence |
| --- | --- | --- |
| `capabilities.yaml` loads as part of fleet manifest | ✅ | `packages/core/src/fleet/capabilities-loader.ts` |
| `rpc-peers.yaml` loader | 🟡 | `parsePeersConfig()` exists and takes raw JSON but no CLI entry point reads a `rpc-peers.yaml` from an agent scaffold at up-time. `DeclaraAddPeer` builder tool writes one — but nothing consumes the file at runtime. |
| `plugin-agent-rpc` (producer tool + consumer source + envelope + pending registry) | ✅ | Package exists, well-tested |
| **`RequestAgent` in `BUILTIN_TOOLS`** | 🔵 | Intentionally not a built-in. `AGENT_RPC_PLAN.md` §1: *"Post-GA v1.1 track (Phase 8 ergonomically, but slotted for 'v1.1 Agent Graph')."* — lives in a plugin by design. Opt-in via plugin install. |
| **Memory transport** in `fleet run` | ✅ | `fleet-run.ts` hard-wires `createMemoryBus()` + `createMemoryTransport()` |
| **Kafka/NATS/SQS/AMQP/MQTT transports** for agent-to-agent RPC | 🔵 | `fleet-run.ts` comment: *"Non-memory transports (kafka, nats, etc.) are ignored in slice 3 — the dev loop is memory-only."* `FLEET_PLAN.md` is v1.2 by design; Kafka transport deferred post-GA. |
| Cross-process agent RPC over a real broker | 🔵 | Requires items above + external-source discovery. Plan position: v1.1 (RPC) + v1.2 (fleet deploy). Not expected to work at CLI 0.4.x. |
| Multi-agent-over-real-broker integration test | ❌ | No test exists. Only `source-kafka/test/integration.test.ts` uses a real broker, scoped to consume-and-emit (not agent-to-agent RPC). |

---

## 4 · Fleet orchestration, deploy, monitoring

| Capability | Status | Evidence |
| --- | --- | --- |
| `declaragent up [-d]` brings agents online | ✅ | `up-cli.ts` + `up-lifecycle.ts` |
| `declaragent down / ps / logs` | ✅ | Shipped 0.4.1, tightened through 0.4.16 |
| Event dispatcher routes source → skill → LLM | ✅ | Verified end-to-end in fleet smoke test (0.4.16) |
| `declaragent fleet run` (in-memory multi-agent) | ✅ | Works; default LLM handler via `fleet-run-llm-handler.ts`. Intended as dev-loop. |
| `declaragent fleet graph / peers / status / validate` | ✅ | Read-only verbs over the loaded manifest |
| `declaragent deploy gcp-cloud-run` generates Dockerfile + service.yaml | ✅ | `deploy-cli.ts::renderDockerfile` + `renderServiceYaml` |
| **Actually invokes `gcloud builds submit` / `gcloud run deploy`** | 🔵 | Intentional. `PHASE_7_PLAN.md` §9: *"We deliberately stop short of invoking `gcloud` ourselves — the user's GCP auth flow is theirs to own."* Prints the three commands for the user to run. |
| `declaragent fleet deploy` N-agent rollout | 🟡 | `fleet-deploy-cli.ts` exists with strategy flags but orchestration is thin. No confirmed real-world rollout. |
| Audit trail with SQLite hash chain | ✅ | `createSqliteAuditSink` + `audit verify` |
| Events list / DLQ list read from local SQLite | ✅ | `events-cli.ts`, `dlq-cli.ts` |
| **Prometheus `/metrics` HTTP endpoint exposed by `up`** | 🔵 | Instrumentation exists (`observability.ts`, counters in `BaseChannelInstance`). Exposition endpoint deferred — `PHASE_6_PLAN.md` §4.1: *"Slice 2 — Observability maturation: prometheus.ts text-format exporter"*. Dashboards in testkit wait for a scrape target. |
| **OpenTelemetry tracing** attached by default | 🟡 | `createOtelBridge()` exists; `up`/`fleet run` don't install it. `OTEL_SETUP.md` documents env-var config but no runtime auto-enable. |

---

## 5 · External brokers (Kafka/NATS/SQS/AMQP/MQTT)

The 5 source packages (`source-kafka/-nats/-sqs/-amqp/-mqtt`) are **consumer-only adapters**. Each is a proper `EventSourceAdapter` — can be wired into any runtime that imports it and registers it. None is auto-loaded.

Code trace for a `kafka` source in `event-sources.yaml` under `declaragent up`:
1. `startAgentSources()` → `validateEventSourcesConfig({ adapters: builtinAdapters() })`
2. `builtinAdapters()` returns `{ webhook, cron, 'file-watch' }` only — `run-agent-sources.ts`
3. `kafka` entry lands in `report.unknownTypes`; startup prints `"skipped external source types: kafka"`
4. Adapter never instantiated

| Capability | Status | Evidence |
| --- | --- | --- |
| Adapter packages exist + self-test | ✅ | All five under `packages/source-*/src/` |
| **Auto-discovery via `@declaragent/source-*` package scan** | 🟡 | `SPEC_AND_PLAN.md` §2.5 + `EVENT_SOURCE_REGISTRY.md` §3 describe the discovery mechanism. Machinery exists (`discoverAdapters()` in core) but `run-agent-sources.ts::builtinAdapters()` doesn't call it. |
| `source-kafka` integration test with real Redpanda | 🟡 | `test/integration.test.ts` exists, **gated behind `KAFKA_INTEGRATION=1`**. Not part of CI's default run. Covers consume-and-emit, not agent-to-agent RPC. |
| **No public producer primitive in any source-\* package** | ❌ | `source-kafka` has an internal producer only for DLQ delivery. No "emit to arbitrary topic" API. |

---

## 6 · Channels (outbound — Slack / Telegram / Discord / WhatsApp)

| Capability | Status | Evidence |
| --- | --- | --- |
| 4 channel adapter packages exist | ✅ | `packages/channel-*/` |
| `declaragent channels validate` checks config shape | ✅ | `channels-cli.ts` |
| `createSendMessageTool` exists in core | ✅ | Exported from `packages/core/src/index.ts` line 139 |
| **`SendMessage` registered in `BUILTIN_TOOLS`** | 🟡 | `grep createSendMessageTool packages/cli/` returns zero hits. Core exports the factory; no CLI runtime constructs the tool or adds it to the tool array. Skills cannot send Slack messages without a user-contributed plugin. |
| **Channel adapters activated at `up` startup** | 🟡 | `ChannelOutboundBridge` exists in core (`createChannelOutboundBridge`). Neither `up` nor `fleet run` imports it. Channels in `~/.declaragent/channels.json` sit inert at runtime. |
| Inbound channel events (e.g. Slack mention → skill) | 🟡 | Channel adapters support inbound per `COMMUNICATION_CHANNELS.md` §5; wiring to the skill registry happens only via the daemon path which is itself partially wired. |

---

## 7 · Production-concern primitives

| Concern | Status | Evidence / Plan |
| --- | --- | --- |
| LLM call retries (429/5xx) with exponential backoff | ✅ | `packages/core/src/providers/retry.ts` — applied inside every provider |
| Source-level DLQ (Kafka) | ✅ | `source-kafka/instance.ts::sendToDLQ()` |
| **Event dispatch DLQ (source → skill rejected → retry queue)** | ❌ | Rejected events stay rejected. No requeue mechanism. Not in any plan as a near-term slice. |
| Idempotency cache + cross-restart dedup via store | ✅ | `dispatcher.ts::IdempotencyCache` + `store.findDuplicate()` — tested |
| **Rate limiting enforced by default** | 🔵 | `PerTargetRateLimiter` wired into dispatcher API. `up-cli.ts` doesn't pass a `rateLimits` spec so it's opt-in. Plan (`SPEC_AND_PLAN.md` §Phase 5) defers default enforcement to Phase 5 (communication channels). |
| **Circuit breakers on flaky sources / targets** | 🔵 | `circuit-breaker.ts` exists; never instantiated by a runtime. Plan (`SPEC_AND_PLAN.md` §NFR Reliability + `EVENT_SOURCE_REGISTRY.md` §8) positions this for Phase 4 scale testing. Deferred from Phase 0. |
| Per-tenant isolation (sessions, bus, quotas, secrets, extensions) | ✅ | Phase-6 wiring + `tenants-cli.ts`. Single-tenant battle-tested; multi-tenant has unit coverage, limited real-world soak. |

---

## The happy path that works today

Exercising this was validated end-to-end in the 0.4.16 fleet smoke test:

1. `npm i -g @declaragent/cli@0.4.16` → binary on PATH (`declaragent` or `d9t`)
2. `declaragent init <template>` or hand-scaffold → `agent.yaml`, `event-sources.yaml` (webhook/cron/file-watch), `skills/*.md`
3. `declaragent auth login <provider>` → OpenRouter OAuth / Anthropic key / env var
4. `declaragent up [-d]` → binds sources, attaches dispatcher, routes events to skills
5. Source fires (webhook POST / cron schedule / file drop) → dispatcher invokes skill → LLM turn completes → outcome `dispatched→<sessionId>` recorded to SQLite
6. `declaragent ps` / `logs [-f]` / `events list` / `events show <id>` / `audit verify` → observability
7. `declaragent down` → clean shutdown
8. `declaragent deploy gcp-cloud-run` → Dockerfile + service.yaml generated; user runs `gcloud` themselves

## What doesn't work at CLI 0.4.16

- Any Kafka/NATS/SQS/AMQP/MQTT source under `declaragent up` → shows as `unknownTypes`
- Any MCP server's tools appearing in a skill's tool registry at runtime → 🟡
- Any plugin's contributed tools appearing in a skill's tool registry at runtime → 🟡
- Any skill-side channel emit (no `SendMessage` in `BUILTIN_TOOLS`) → 🟡
- Any agent-to-agent comms over a non-memory transport → 🔵 (by design for v1.0)
- Push-button `gcloud run deploy` → 🔵 (by design)
- Circuit-breaker-protected event dispatch → 🔵 (Phase 4)
- Prometheus `/metrics` scrape endpoint → 🔵 (Phase 6 slice 2)
- Default rate limiting → 🔵 (Phase 5)
- Real production deployment — no verifying commit or soak test result

---

## Prioritized path to "production scale" for the first-principles vision

Ordered by leverage (biggest capability unlock per focused day):

1. **External source adapter discovery in `up`** (~1 day) — `run-agent-sources::builtinAdapters()` calls `discoverAdapters()` + merges results. Unlocks Kafka/NATS/SQS/AMQP/MQTT as event sources. Plan-aligned per `EVENT_SOURCE_REGISTRY.md` §3.
2. **MCP runtime activation** (~1 day) — `up-cli::bringUp` reads `~/.declaragent/mcp-servers.json`, spawns stdio servers, merges their tools into the per-agent registry. Plan-aligned per `EXTENDING_YOUR_AGENT.md` §3.
3. **`SendMessage` + channel runtime activation** (~1 day) — `BUILTIN_TOOLS` gains `createSendMessageTool(…)`, `up-cli::bringUp` loads channels via `createChannelOutboundBridge`. Plan-aligned per `COMMUNICATION_CHANNELS.md` §4.
4. **Plugin runtime activation** (~1 day) — `up-cli::bringUp` iterates `~/.declaragent/plugins.json` + activates each, merging contributed tools/skills/commands/hooks into the session. Plan-aligned per `EXTENDING_YOUR_AGENT.md` §6.
5. **Non-memory transports in `fleet run` + `RequestAgent` in `BUILTIN_TOOLS`** (~1 day) — reads `capabilities.yaml` transport kind, instantiates via `plugin-agent-rpc`. Completes the multi-agent-over-Kafka story. Crosses into v1.1 territory per the plan but doesn't require any new design.

These five items are all **wiring work**, not new design. Every piece has a plan and exists as code. Total: roughly one focused week, all deliverable as 0.5.x releases that don't need changes to the plan docs.

**After all five land:** the full first-principles vision is real end-to-end — declaratively define agents with capabilities + skills + MCP + plugins + channels, deploy a fleet that communicates over real brokers, monitor through the Prometheus/OTel paths already instrumented.

---

## Capability deferrals explicitly named by the plans

Items the plans **intentionally put in later phases**. Not gaps — roadmap:

| Capability | Deferred to | Source |
| --- | --- | --- |
| `RequestAgent` built-in | v1.1 Agent Graph | `AGENT_RPC_PLAN.md` §1 |
| Non-memory RPC transports | v1.1+ | `AGENT_RPC_PLAN.md` §5 |
| Fleet (v1.2 capabilities) | v1.2 | `FLEET_PLAN.md` |
| Push-button gcloud invoke | — (intentional non-goal) | `PHASE_7_PLAN.md` §9 |
| Default rate limiting | Phase 5 | `SPEC_AND_PLAN.md` §Phase 5 |
| Circuit breakers | Phase 4 scale testing | `SPEC_AND_PLAN.md` §NFR Reliability |
| Prometheus `/metrics` endpoint | Phase 6 slice 2 | `PHASE_6_PLAN.md` §4.1 |

---

## Methodology

Compiled 2026-04-21 by:
1. Running the production audit query against `packages/cli/src` + `packages/core/src`
2. Cross-checking findings against all 25 plan docs in `docs/`
3. Distinguishing "code exists + tested" from "code exists + never called at runtime"
4. Preserving plan-named deferrals (🔵) as distinct from runtime-wiring gaps (🟡)

If a status claim drifts from reality, update both the mark and the evidence pointer. Don't let this file soften into marketing — its value is being correct about an uncomfortable state.

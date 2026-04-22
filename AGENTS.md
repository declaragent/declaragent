# AGENTS.md

**Honest production-readiness audit of Declaragent, as of 2026-04-22 (CLI v0.5.21 on disk, 0.6.0 pending tag + publish).**

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
| **MCP servers spawn + expose tools to skills at runtime** | ✅ | `up-cli.ts:397-408 bringUp()` calls `loadScopedMCPServers()` + `startMCPServers()`; tools fed into engine via `buildRuntimeTools({ mcpTools })` at line 632. Shipped as 0.5.x slices 2a–2e (commits `63482b1`, `579362c`, `778f505`, `a4ba7a4`, `9a6c64f`). |
| `declaragent plugin install` stores entry + consent | ✅ | `plugin-cli.ts` + `PluginConsent` Ink UI |
| **Plugins activated (tools registered in skill's tool list)** | ✅ | `up-cli.ts:598-613 attachDispatcherToAgent()` calls `startPluginRuntime()`; plugin-contributed tools appended via `extraTools` (line 627) into `buildRuntimeTools`. Shipped as 0.5.x slice 4 (commit `fad5977`). |

---

## 3 · Agent-to-agent communication

| Capability | Status | Evidence |
| --- | --- | --- |
| `capabilities.yaml` loads as part of fleet manifest | ✅ | `packages/core/src/fleet/capabilities-loader.ts` |
| `rpc-peers.yaml` loader | ✅ | `fleet-run.ts:641-649` loads `rpc-peers.yaml` from the fleet root via `loadPeersConfig()`; when present, each handler gets the peer table and `RequestAgent` is wired. Absence logs a warning + disables `RequestAgent`. |
| `plugin-agent-rpc` (producer tool + consumer source + envelope + pending registry) | ✅ | Package exists, well-tested |
| **`RequestAgent` in runtime tool list** | ✅ | `fleet-run-llm-handler.ts` uses `createRequestAgentTool` from `@declaragent/plugin-agent-rpc` and appends it via `buildRuntimeTools({ extra })` whenever `rpc-peers.yaml` is present. Shipped as 0.5.x slice 5 (commit `4d120b1`). |
| **Memory transport** in `fleet run` | ✅ | `fleet-run.ts` hard-wires `createMemoryBus()` + `createMemoryTransport()` |
| **Kafka/NATS/SQS/AMQP/MQTT transports** for agent-to-agent RPC | 🔵 | `fleet-run.ts:228-244` honors `options.transportFactories` per declared `RpcTransportKind` — so the *plumbing* is in and any kind declared in `capabilities.yaml` routes correctly when a factory is supplied. **No broker-specific factory packages ship yet** (e.g. `@declaragent/plugin-agent-rpc-kafka`); the warning at line 241 instructs users. Broker-specific transport packages are v1.1+ per `AGENT_RPC_PLAN.md` §5. |
| Cross-process agent RPC over a real broker | 🔵 | Requires the broker-specific factory above. Slice 7 of `RELEASE_0_6_0_PLAN.md` ships the integration test harness + first broker factory (Kafka) gated behind `FLEET_INTEGRATION=1`. |
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
| **Auto-discovery via `@declaragent/source-*` package scan** | ✅ | `run-agent-sources.ts:81` calls `discoverAdapters()` across the search paths; the hardcoded `builtinAdapters()` is retired per the file header's `@since 0.5.0-slice.1` note. Shipped commit `da8f330`. |
| `source-kafka` integration test with real Redpanda | 🟡 | `test/integration.test.ts` exists, **gated behind `KAFKA_INTEGRATION=1`**. Not part of CI's default run. Covers consume-and-emit, not agent-to-agent RPC. |
| **No public producer primitive in any source-\* package** | ❌ | `source-kafka` has an internal producer only for DLQ delivery. No "emit to arbitrary topic" API. |

---

## 6 · Channels (outbound — Slack / Telegram / Discord / WhatsApp)

| Capability | Status | Evidence |
| --- | --- | --- |
| 4 channel adapter packages exist | ✅ | `packages/channel-*/` |
| `declaragent channels validate` checks config shape | ✅ | `channels-cli.ts` |
| `createSendMessageTool` exists in core | ✅ | Exported from `packages/core/src/index.ts` line 139 |
| **`SendMessage` added to runtime tool list** | ✅ | `up-cli.ts:620-625 attachDispatcherToAgent()` constructs `createSendMessageTool({ mailbox, channels })` from the per-agent channel runtime and appends via `extraTools`. Shipped as 0.5.x slice 3 (commit `de99d4c`). |
| **Channel adapters activated at `up` startup** | ✅ | `up-cli.ts:462-475 bringUp()` calls `startChannelRuntime({ bus, logger, agentDir })` before dispatcher attach, so every configured channel is loaded before the first event fires. Shipped as 0.5.x slice 3 (commit `de99d4c`). |
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

## What doesn't work at CLI 0.5.21

**Shipped between 0.5.0 and 0.5.21** (no longer in this list): external source adapter discovery, MCP server activation, plugin activation, channel activation + `SendMessage`, non-memory RPC transport plumbing + `RequestAgent`.

**Still open** — all tracked in **[docs/RELEASE_0_6_0_PLAN.md](docs/RELEASE_0_6_0_PLAN.md)**:

- ~~Inbound channel events (Slack mention → skill)~~ → ✅ Slice 6 shipped. Adapter-agnostic `ChannelInboundBridge` reads `channels.json#inbound.routes` and republishes session-target events with a skill-target copy. Works for Slack / Telegram / Discord / WhatsApp in a single changeset.
- ~~Circuit-breaker-protected event dispatch~~ → ✅ Slice 3 shipped. Per-skill breakers (10 consecutive failures → 30-s cooldown) short-circuit to `rejected:circuit-open`. Transitions bump `declaragent_dispatcher_breaker_{state,transitions_total}` + `events list --state circuit-open` filter.
- ~~Prometheus `/metrics` scrape endpoint~~ → ✅ Slice 1 shipped (see 0.6.0 changeset). Default `127.0.0.1:9464` in detached mode, `DECLARAGENT_METRICS_PORT` override.
- ~~OpenTelemetry tracing auto-enable~~ → ✅ Slice 2 shipped. Set `OTEL_EXPORTER_OTLP_ENDPOINT` + install peer deps; `up` wires the bridged tracer into every source + channel.
- ~~Default rate limiting~~ → ✅ Slice 4 shipped. Provider-level token bucket (Anthropic 50rps, OpenRouter 20rps, others 10rps). Waits emit `declaragent_provider_rate_limit_{waits_total,wait_ms}`. Env escape: `DECLARAGENT_PROVIDER_RATE_LIMIT_{DISABLE,RPS}`.
- Event-dispatch DLQ **tracking** → ✅ Slice 5 shipped (new `rejected_events` table, dispatcher upserts on reject, `dlq list/show/drop --kind dispatch`). **Active requeue** → 🟡 (needs a control socket on `up`; deferred follow-up).
- Multi-agent-over-real-broker integration test → ✅ Slice 7 infrastructure shipped (`createKafkaTransport` + testkit harness + nightly CI), 🟡 **soak pending** (plan requires 7 consecutive green nightlies before beta → rc). Transport-level round-trip proven; full `fleet run` boot via LLM-mock scaffold is follow-up.
- ~~Fleet deploy orchestration (rolling/canary)~~ → ✅ Slice 8 shipped. `--canary` with configurable soak window (default 60s) + post-soak re-probe that rolls back on failure. Rolling was already present; canary is the net-new value.

**Intentional non-goals** (permanent 🔵):
- Push-button `gcloud run deploy` — `PHASE_7_PLAN.md` §9
- Non-memory RPC transports for specific brokers (Kafka/NATS/SQS/AMQP/MQTT **for agent-to-agent RPC**, distinct from event-source consumption) — v1.1+ per `AGENT_RPC_PLAN.md` §5

---

## Prioritized path to "production scale" for the first-principles vision

### Phase 1 — 0.5.x wiring (DONE, shipped 0.5.0 → 0.5.21)

1. ✅ **External source adapter discovery in `up`** — `discoverAdapters()` wired (commit `da8f330`)
2. ✅ **MCP runtime activation** — `loadScopedMCPServers` + `startMCPServers` in `bringUp` (commits `63482b1`, `579362c`, `778f505`, `a4ba7a4`, `9a6c64f`)
3. ✅ **`SendMessage` + channel runtime activation** — `startChannelRuntime` + `createSendMessageTool` in `bringUp` (commit `de99d4c`)
4. ✅ **Plugin runtime activation** — `startPluginRuntime` in `attachDispatcherToAgent` (commit `fad5977`)
5. ✅ **Non-memory transports in `fleet run` + `RequestAgent`** — `capabilities.yaml` transport kind respected, `createRequestAgentTool` layered via `buildRuntimeTools({ extra })` (commit `4d120b1`)

### Phase 2 — 0.6.0 production hardening (DONE, pending tag + publish)

Shipped across Slices 1–8. See the `.changeset/slice-*.md` entries for the per-slice diffs:

1. ✅ **Prometheus `/metrics` endpoint** — shared registry wired through source + channel runtimes, HTTP exporter on `127.0.0.1:9464` (detached mode).
2. ✅ **OpenTelemetry auto-enable** — `createOtelBridge` loads when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
3. ✅ **Circuit breakers in dispatcher** — per-skill, 10 failures → 30s cooldown, `declaragent_dispatcher_breaker_{state,transitions_total}` + `events list --state circuit-open`.
4. ✅ **Default provider rate limits** — Anthropic 50rps / OpenRouter 20rps / unknown 10rps, token bucket at the LLM call site.
5. ✅ **Dispatch DLQ tracking** — `rejected_events` table + `dlq list/show/drop --kind dispatch`. (Active requeue → v1.1, needs control socket on `up`.)
6. ✅ **Inbound channels → skills** — adapter-agnostic `ChannelInboundBridge` + `channels.json#inbound.routes`.
7. ✅ **Fleet RPC over Kafka** — `createKafkaTransport` + testkit harness + nightly CI. (Soak → 7 consecutive green nightlies required before beta → rc.)
8. ✅ **Canary fleet deploys** — `--canary --canary-wait-ms` with post-soak re-probe + rollback.

**Remaining gaps** (all tracked as 🟡 or 🔵 in the table below):
- Active dispatch-DLQ requeue (Slice 5 deferral)
- Fleet-integration soak evidence (Slice 7 deferral)
- Full `fleet run` boot over Kafka with mock LLM handlers (Slice 7 deferral)

Slice 9 (doc consolidation) is the current slice — no code changes.

---

## Capability deferrals explicitly named by the plans

Items the plans **intentionally put in later phases**. Not gaps — roadmap. Rows that 0.6.0 resolved are struck through below.

| Capability | Deferred to | Source |
| --- | --- | --- |
| ~~`RequestAgent` built-in~~ | ~~v1.1 Agent Graph~~ | Shipped 0.5.x slice 5 (`4d120b1`) |
| ~~Default rate limiting~~ | ~~Phase 5~~ | Shipped 0.6.0 Slice 4 |
| ~~Circuit breakers~~ | ~~Phase 4 scale testing~~ | Shipped 0.6.0 Slice 3 |
| ~~Prometheus `/metrics` endpoint~~ | ~~Phase 6 slice 2~~ | Shipped 0.6.0 Slice 1 |
| Push-button gcloud invoke | — (intentional non-goal) | `PHASE_7_PLAN.md` §9 |
| Non-memory RPC transports for NATS / SQS / AMQP / MQTT (broker-specific factories) | v1.1+ | `AGENT_RPC_PLAN.md` §5. Kafka factory shipped 0.6.0 Slice 7 as the reference. |
| Dispatch-DLQ active requeue | 0.6.x patch / v1.1 | `RELEASE_0_6_0_PLAN.md` Slice 5 deferral. Needs a control socket on `up`. |
| Full `fleet run` end-to-end over Kafka with mocked LLM handlers | 0.6.x patch | Slice 7 deferral. Transport round-trip proven; skill-level path waits for a mock-provider scaffold. |
| Fleet (v1.2 capabilities) | v1.2 | `FLEET_PLAN.md` |

---

## Methodology

Last refreshed 2026-04-22 end-of-**Slice 9** of `docs/RELEASE_0_6_0_PLAN.md` (CLI 0.5.21 on disk, 0.6.0 tag pending). Methodology:

1. Running the production audit query against `packages/cli/src` + `packages/core/src`
2. Cross-checking findings against all plan docs in `docs/` including `RELEASE_0_6_0_PLAN.md`
3. Distinguishing "code exists + tested" from "code exists + never called at runtime"
4. Preserving plan-named deferrals (🔵) as distinct from runtime-wiring gaps (🟡)
5. Recording ❌ → ✅ transitions in the corresponding `.changeset/slice-*.md` with evidence pointers

If a status claim drifts from reality, update both the mark and the evidence pointer. Don't let this file soften into marketing — its value is being correct about an uncomfortable state.

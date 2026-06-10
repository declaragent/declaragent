# AGENTS.md

**Honest production-readiness audit of Declaragent, as of 2026-04-23 (CLI v0.7.1 — published to npm + tagged; core v0.5.0, plugin-agent-rpc v4.0.0).**

> **What changed in this revision:** The 12-item [`ENTERPRISE_PRODUCTION_PLAN.md`](docs/ENTERPRISE_PRODUCTION_PLAN.md) program closed. Rows previously marked 🟡 or 🔵 for NATS transport, OIDC auth, control plane, GitOps render, SIEM export, per-tool rate limit, MCP auto-recovery, typed capabilities, dispatch-DLQ requeue, and builder regression tests all flip to ✅. The only remaining non-✅ row is cross-host Kafka soak *proof* (code shipped, soak evidence accumulating Sundays 00:00 UTC per `weekly-soak.yml`).

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

## 0 · Production-readiness pass (in-flight, 0.7.6 branch `agent-durability-followups`)

> Added after a multi-agent audit (see [`docs/PRODUCTION_READINESS_PLAN.md`](docs/PRODUCTION_READINESS_PLAN.md)) found several primitives **designed but not wired at runtime** — the exact 🟡 trap this file warns about. The items below are **runtime-wired + tested** in the working tree (full suite green; not yet released). Each is honest about what remains.

| Item | Status | Evidence |
| --- | --- | --- |
| Tool permissions ENFORCED in `up`/`fleet run` (was `mode:'bypass'` + full builtin set) | ✅ | `packages/cli/src/resolve-tools.ts` + `resolve-tools.test.ts`; wired at `up-cli.ts`, `fleet-run-llm-handler.ts` |
| Bash subprocess secret-env scrub | ✅ | `packages/core/src/tools/bash-env.ts` + `bash.test.ts` ("does not leak secret env") |
| RPC verify fails CLOSED on unknown senders (`strictAuth`) | ✅ | `agent-inbox.ts` + `fleet-run.ts`; `agent-inbox.test.ts`, `fleet-run.test.ts` |
| HMAC RPC auth provider (sign+verify) + `RequestAgent` signer hook | ✅ | `plugin-agent-rpc/src/auth/hmac.ts` + `hmac.test.ts`; e2e sign→verify in `request-agent.test.ts` |
| Control-plane Host-header bypass fixed (uses real peer IP) | ✅ | `control-plane-auth.ts`; `control-plane-auth.test.ts` ("forged Host:127.0.0.1") |
| `bindAddress` knob, fail-closed non-loopback-requires-auth | ✅ | `up-cli.ts` `resolveBindAddress` + `up-cli.test.ts` |
| Cross-host respond on inbound transport + `fleet run` supplies kafka/nats `transportFactories` + **kafka SASL/TLS** (`ssl`/`sasl`, passwordRef resolved) | ✅ wiring | `fleet-run.ts` `selectRespondTransport`; `transport-factories.ts`; `kafka-transport.ts` (ssl/sasl → kafkajs) + tests. Live broker handshake still needs a real broker. |
| DLQ requeue actually re-executes (fresh id) | ✅ | `events/dlq.ts` + `dlq.test.ts` |
| Boot-time crash recovery of interrupted events | ✅ | `events/recovery.ts` + `recovery.test.ts`; wired in `up-cli.ts` |
| Graceful drain on shutdown (`DECLARAGENT_DRAIN_DEADLINE_MS`) | ✅ | `up-cli.ts` `drainWithDeadline`; `up-lifecycle.test.ts` |
| Outbound channel send retry (was at-most-once drop) | ✅ | `channels/outbound-bridge.ts` + `outbound-bridge.test.ts` |
| LLM golden signals (latency/errors/tokens/cost) + daemon heartbeat + **OTel NodeSDK actually starts** (spans export) | ✅ | `engine.ts` + tests; `heartbeat.ts`; `otel-sdk.ts` (`startOtelSdk` loads sdk-node + `start()`) + `otel-sdk.test.ts`, wired in `up-cli.ts`. Span receipt still needs a live collector. |
| WS8 multi-tenancy: spend brake + `tenants.yaml` load + GDPR `erase --user` + per-tenant **and** per-end-user memory isolation + tamper-safe retention | ✅ | `engine.ts` (`quota_exceeded`); `findTenantsConfig`/`resolveTenantContext`; `eraseSubject`+`erase-cli.ts`; `scopedNamespace` (`ctx.tenant`+`ctx.subject`); `audit prune` tombstones so `verify` passes (+ tests). Only separate-chain-per-tenant remains as further hardening. |
| `/healthz`+`/readyz` auth-exempt routes; renderers run foreground `up` | ✅ | `control-plane-server.ts` + `control-plane-server.test.ts`; `k8s-renderer.ts`, `helm-renderer.ts` |
| `declaragent agent validate` + unknown-key lint | ✅ | `cli/src/agent-cli.ts` + `agent-cli.test.ts` |
| Slack Socket Mode reconnect-with-backoff + truthful `socketActive` | ✅ | `channel-slack/src/client.ts` + `client.test.ts`; `instance.ts` health |
| Hermetic flagship E2E (event→dispatch→LLM→channel→outcome) | ✅ | `testkit/src/fleet-integration/hermetic-e2e.test.ts` |

**Still genuinely incomplete (infrastructure- or calendar-gated, NOT done):** CLI live broker-factory wiring + transport SASL/TLS (need a real Kafka/NATS broker to verify); k8s probe-reachability (`0.0.0.0` bind + rendered auth secret) + the kind-cluster smoke gate (need a cluster); real OTel SDK span export (needs the SDK packages + an OTLP collector); multi-tenant `tenants.yaml` loading + GDPR erasure + per-tenant memory isolation; branch protection + the 7-week soak streak (GitHub admin + calendar); and the coordinated **0.8.0** breaking-change cutover (strict-schema throw + the four default flips). Treat those rows in the sections below as still 🟡/🔵 until verified with the relevant infrastructure.

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
| **Kafka + NATS RPC transports** for agent-to-agent RPC | ✅ | `createKafkaTransport` shipped 0.6.0 Slice 7; `createNatsTransport` shipped 0.7.0 ([PR #13](https://github.com/declaragent/declaragent/pull/13) · `e233ac6`, enhanced `8651c54` with per-topic queue groups). `fleet-run.ts` honors `options.transportFactories` per declared `RpcTransportKind`. |
| SQS / AMQP / MQTT RPC transport factories | 🔵 | Deliberately deferred to v1.1+ per `AGENT_RPC_PLAN.md §5`. Kafka + NATS cover the observed customer demand; additional brokers land when specific requests arrive. |
| Cross-process agent RPC over a real broker | ✅ | `packages/testkit/src/fleet-integration/kafka-rpc.test.ts` proves Kafka round-trip; NATS analog shipped alongside [PR #13](https://github.com/declaragent/declaragent/pull/13). Nightly CI runs both. |
| Multi-agent-over-real-broker integration test | ✅ | `packages/testkit/src/fleet-integration/` covers Kafka + NATS. Literal `fleet run` subprocess shipped in [PR #10](https://github.com/declaragent/declaragent/pull/10) (`20c6e35`, enhanced `8651c54`). **Sustained soak proof** (7 consecutive green weekly runs) is the remaining receipt for flipping the enterprise pillar badge. |

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
| `declaragent fleet deploy` N-agent rollout (rolling + canary) | ✅ | `fleet-deploy-cli.ts` + `--canary --canary-wait-ms` with post-soak re-probe + rollback (0.6.0 Slice 8). Traffic-splitting canary is intentionally out of scope (reverse-proxy territory). |
| Audit trail with SQLite hash chain | ✅ | `createSqliteAuditSink` + `audit verify` |
| Events list / DLQ list read from local SQLite | ✅ | `events-cli.ts`, `dlq-cli.ts` |
| **Dispatch-DLQ active requeue** | ✅ | [PR #14](https://github.com/declaragent/declaragent/pull/14) · `757b71d`. Uses the new control socket. |
| **Control socket on `up` daemon** | ✅ | [PR #11](https://github.com/declaragent/declaragent/pull/11) · `d53baed`. `packages/cli/src/control-socket-client.ts` exposes `status` + `dlq.requeue` ops. |
| **Managed control plane — aggregator over N `up`** | ✅ | Slice 1 full + Slice 2 auth: [PR #12](https://github.com/declaragent/declaragent/pull/12) · [PR #15](https://github.com/declaragent/declaragent/pull/15) · [PR #19](https://github.com/declaragent/declaragent/pull/19) · [PR #27](https://github.com/declaragent/declaragent/pull/27). See `docs/CONTROL_PLANE_PLAN.md`. |
| **GitOps `fleet render` — k8s + Helm** | ✅ | [PR #20](https://github.com/declaragent/declaragent/pull/20) · `98c120a`. `packages/cli/src/fleet-render-cli.ts`. |
| **SIEM audit export (Splunk / Elastic / Datadog)** | ✅ | [PR #22](https://github.com/declaragent/declaragent/pull/22) · `b8f6f94`. Cursor held across restarts. |
| **Prometheus `/metrics` HTTP endpoint exposed by `up`** | ✅ | Shipped 0.6.0 Slice 1 (`8bddcc1`). `127.0.0.1:9464` by default in `-d` mode; `DECLARAGENT_METRICS_PORT` override. |
| **OpenTelemetry tracing** attached by default | ✅ | Shipped 0.6.0 Slice 2 (`8bddcc1`). `createOtelBridge()` auto-loads when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. |

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
| `source-kafka` integration test with real Redpanda | ✅ | `test/integration.test.ts` + `packages/testkit/src/fleet-integration/kafka-rpc.test.ts` run nightly against Redpanda via `.github/workflows/nightly-integration.yml` (3 retries, auto-files a GitHub issue on failure). Now covers both consume-and-emit and agent-to-agent RPC; literal `fleet run` subprocess soak lands in [PR #10](https://github.com/declaragent/declaragent/pull/10). |
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
| Inbound channel events (e.g. Slack mention → skill) | ✅ | Shipped 0.6.0 Slice 6. Adapter-agnostic `ChannelInboundBridge` reads `channels.json#inbound.routes` and republishes session-target events with a skill-target copy. Works for Slack / Telegram / Discord / WhatsApp in a single changeset. |

---

## 7 · Production-concern primitives

| Concern | Status | Evidence / Plan |
| --- | --- | --- |
| LLM call retries (429/5xx) with exponential backoff | ✅ | `packages/core/src/providers/retry.ts` — applied inside every provider |
| Source-level DLQ (Kafka) | ✅ | `source-kafka/instance.ts::sendToDLQ()` |
| **Event dispatch DLQ (source → skill rejected → tracked + requeued)** | ✅ | Tracking shipped 0.6.0 Slice 5 (`rejected_events` table + `dlq list/show/drop --kind dispatch`). Active requeue shipped 0.7.0 [PR #14](https://github.com/declaragent/declaragent/pull/14) · `757b71d` via the new control socket. |
| Idempotency cache + cross-restart dedup via store | ✅ | `dispatcher.ts::IdempotencyCache` + `store.findDuplicate()` — tested |
| **Provider rate limits enforced by default** | ✅ | Shipped 0.6.0 Slice 4. Token bucket wraps every provider (Anthropic 50 rps / OpenRouter 20 rps / unknown 10 rps). `DECLARAGENT_PROVIDER_RATE_LIMIT_{DISABLE,RPS}` escape hatches. |
| **Per-tool rate limit** | ✅ | [PR #18](https://github.com/declaragent/declaragent/pull/18) · `10da017` · enhanced `b69d717` with comparator + burst defaults. Token-bucket gate in `packages/core/src/tools/rate-limit-gate.ts`. |
| **Circuit breakers on flaky skills** | ✅ | Shipped 0.6.0 Slice 3. Per-skill breakers (10 failures → 30-s cooldown → half-open probe). `declaragent_dispatcher_breaker_{state,transitions_total}` counters + `events list --state circuit-open` filter. |
| **Auto-recovery for crashed MCP servers** | ✅ | [PR #21](https://github.com/declaragent/declaragent/pull/21) · `1a120f8` · enhanced `b69d717` with supervised recipe + `circuit-open` counter. |
| **OIDC / OAuth2 on RPC envelopes** | ✅ | [PR #17](https://github.com/declaragent/declaragent/pull/17) · `71b752e` — `AuthVerifyRegistry` + OIDC provider implementations. `AUTH_REJECTED` promoted to `RPC_ERROR_CODES` in [PR #30](https://github.com/declaragent/declaragent/pull/30) · `2e60de4`. |
| **v1.1 Agent Graph — typed capabilities** | ✅ | [PR #23](https://github.com/declaragent/declaragent/pull/23) · `4115fb1`. Hand-rolled draft-07 validator + deterministic codegen. Capability schema-violation audit cardinality pinned per-envelope in [PR #30](https://github.com/declaragent/declaragent/pull/30) · `2e60de4`. |
| **Recorded-conversation builder regression tests** | ✅ | [PR #24](https://github.com/declaragent/declaragent/pull/24) · `2aba945`. 5 canonical fixtures + replay harness + PR-template gate. `BUILDER_RECORD=1` capture mode shipped `7e61b31`. |
| Per-tenant isolation (sessions, bus, quotas, secrets, extensions) | ✅ | Phase-6 wiring + `tenants-cli.ts`. Single-tenant battle-tested; multi-tenant has unit coverage, limited real-world soak. |

---

## The happy path that works today

Exercising this was validated end-to-end in the fleet smoke test + nightly CI:

1. `npm i -g @declaragent/cli@0.7.1` → binary on PATH (`declaragent` or `d9t`)
2. `declaragent init <template>` or hand-scaffold → `agent.yaml`, `event-sources.yaml` (webhook/cron/file-watch), `skills/*.md`
3. `declaragent auth login <provider>` → OpenRouter OAuth / Anthropic key / env var
4. `declaragent up [-d]` → binds sources, attaches dispatcher, routes events to skills, boots Prometheus `/metrics` on :9464, auto-enables OTel if `OTEL_EXPORTER_OTLP_ENDPOINT` is set
5. Source fires (webhook POST / cron schedule / file drop) → dispatcher (with per-skill circuit breaker + per-tool rate limit) invokes skill → provider-rate-limited LLM turn completes → outcome `dispatched→<sessionId>` recorded to SQLite hash-chained audit
6. `declaragent ps` / `logs [-f]` / `events list` / `events show <id>` / `audit verify` / `dlq list --kind dispatch` → observability
7. `declaragent dlq requeue <id>` → active redrive via control socket
8. `declaragent down` → clean shutdown
9. `declaragent deploy gcp-cloud-run` → Dockerfile + service.yaml generated; user runs `gcloud` themselves
10. `declaragent fleet render --format k8s` → portable k8s manifests (Helm supported); `GitOps` deploy is your CD system's call
11. Multi-host: `declaragent fleet run` with `rpc-peers.yaml` over Kafka or NATS transport; OIDC-protected envelopes verify via `AuthVerifyRegistry`
12. SIEM: point `audit.siemSink` at Splunk / Elastic / Datadog; cursor held across restarts

## Still open at CLI 0.7.1

**Shipped between 0.5.0 and 0.7.1** (no longer in this list): external source adapter discovery, MCP server activation, plugin activation, channel activation + `SendMessage`, non-memory RPC transport plumbing + `RequestAgent`, inbound channel routing, circuit breakers, Prometheus `/metrics`, OpenTelemetry auto-enable, default provider rate limits, dispatch-DLQ tracking + active requeue, canary fleet deploys, Kafka RPC transport + literal-subprocess soak harness, NATS RPC transport, OIDC/OAuth2 on envelopes, managed control plane (aggregator + auth middleware), GitOps `fleet render`, SIEM audit export, per-tool rate limit, MCP auto-recovery, typed capability schemas (v1.1 Agent Graph), recorded-conversation builder regression tests, control socket on `up` daemon.

**Still open:**

- **Sustained Kafka soak proof** — the subprocess harness + nightly CI ship; the acceptance criterion for flipping Pillar 3's enterprise badge is **7 consecutive green weekly runs** of `weekly-soak.yml` (`ENTERPRISE_PRODUCTION_PLAN.md §1 item #1 acceptance #4`). Evidence accumulates Sundays 00:00 UTC.
- **Traffic-splitting canary** — current canary is sequential-agent, not weighted per-request. Reverse-proxy territory; not tracked as a gap.
- **0.7.1 backlog follow-ups** — scoped polish on shipped features: wire `clientSecretRef` resolver into `up` boot (#4), per-route scope overrides + fleet-level `controlPlane:` block (#5), `TenantAuditSink` into `up-cli` (#7), MCP supervisor into `mcp-runtime.ts` (#8), ServiceMonitor file split (#9), back-pressure policy for SIEM (#10), `peerCapabilities` + shared `CapabilityValidatorRegistry` into `up`/`fleet-run` (#11). Consolidated in `docs/POST_ENTERPRISE_BACKLOG.md`. None block the enterprise-✅ claim.

**Intentional non-goals** (permanent 🔵):
- Push-button `gcloud run deploy` — `PHASE_7_PLAN.md` §9
- RPC transport factories for SQS / AMQP / MQTT (specific brokers beyond Kafka + NATS) — v1.1+ per `AGENT_RPC_PLAN.md §5`, waiting on customer signal
- Per-request weighted traffic splitting in canary — reverse-proxy responsibility

---

## Prioritized path to "production scale" for the first-principles vision

### Phase 1 — 0.5.x wiring (DONE, shipped 0.5.0 → 0.5.21)

1. ✅ **External source adapter discovery in `up`** — `discoverAdapters()` wired (commit `da8f330`)
2. ✅ **MCP runtime activation** — `loadScopedMCPServers` + `startMCPServers` in `bringUp` (commits `63482b1`, `579362c`, `778f505`, `a4ba7a4`, `9a6c64f`)
3. ✅ **`SendMessage` + channel runtime activation** — `startChannelRuntime` + `createSendMessageTool` in `bringUp` (commit `de99d4c`)
4. ✅ **Plugin runtime activation** — `startPluginRuntime` in `attachDispatcherToAgent` (commit `fad5977`)
5. ✅ **Non-memory transports in `fleet run` + `RequestAgent`** — `capabilities.yaml` transport kind respected, `createRequestAgentTool` layered via `buildRuntimeTools({ extra })` (commit `4d120b1`)

### Phase 2 — 0.6.0 production hardening (DONE, published 2026-04-22)

Shipped across Slices 1–8. See the `.changeset/slice-*.md` entries for the per-slice diffs:

1. ✅ **Prometheus `/metrics` endpoint** — shared registry wired through source + channel runtimes, HTTP exporter on `127.0.0.1:9464` (detached mode).
2. ✅ **OpenTelemetry auto-enable** — `createOtelBridge` loads when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
3. ✅ **Circuit breakers in dispatcher** — per-skill, 10 failures → 30s cooldown, `declaragent_dispatcher_breaker_{state,transitions_total}` + `events list --state circuit-open`.
4. ✅ **Default provider rate limits** — Anthropic 50rps / OpenRouter 20rps / unknown 10rps, token bucket at the LLM call site.
5. ✅ **Dispatch DLQ tracking** — `rejected_events` table + `dlq list/show/drop --kind dispatch`.
6. ✅ **Inbound channels → skills** — adapter-agnostic `ChannelInboundBridge` + `channels.json#inbound.routes`.
7. ✅ **Fleet RPC over Kafka** — `createKafkaTransport` + testkit harness + nightly CI.
8. ✅ **Canary fleet deploys** — `--canary --canary-wait-ms` with post-soak re-probe + rollback.

### Phase 3 — 0.7.x enterprise integrations (DONE, published 2026-04-23 as 0.7.1)

Closed all 12 items on [`ENTERPRISE_PRODUCTION_PLAN.md`](docs/ENTERPRISE_PRODUCTION_PLAN.md). See `packages/cli/CHANGELOG.md` for per-PR notes:

1. ✅ **Finish Kafka soak** — cross-host `fleet run` literal subprocess + 24h drift alarm ([PR #10](https://github.com/declaragent/declaragent/pull/10) · `20c6e35` · enhanced `8651c54`).
2. ✅ **NATS RPC transport factory** — mirror of `createKafkaTransport` with per-topic queue groups ([PR #13](https://github.com/declaragent/declaragent/pull/13) · `e233ac6` · enhanced `8651c54`).
3. ✅ **Dispatch-DLQ active requeue** — uses new control socket ([PR #14](https://github.com/declaragent/declaragent/pull/14) · `757b71d`).
4. ✅ **OIDC / OAuth2 on RPC envelopes** — `AuthVerifyRegistry` + `RPC_ERROR_CODES.AUTH_REJECTED` ([PR #17](https://github.com/declaragent/declaragent/pull/17) · `71b752e` + [PR #30](https://github.com/declaragent/declaragent/pull/30) · `2e60de4`).
5. ✅ **Managed control plane — aggregator over N `up`** — Slice 1 full + Slice 2 auth ([PR #12](https://github.com/declaragent/declaragent/pull/12) · [PR #15](https://github.com/declaragent/declaragent/pull/15) · [PR #19](https://github.com/declaragent/declaragent/pull/19) · [PR #27](https://github.com/declaragent/declaragent/pull/27)). See `docs/CONTROL_PLANE_PLAN.md`.
6. ✅ **Control socket on `up` daemon** — `status` + `dlq.requeue` ops ([PR #11](https://github.com/declaragent/declaragent/pull/11) · `d53baed`, helper extracted `1bc842d`).
7. ✅ **Per-tool rate limit** — token bucket + comparator/burst defaults ([PR #18](https://github.com/declaragent/declaragent/pull/18) · `10da017` · enhanced `b69d717`).
8. ✅ **Auto-recovery for crashed MCP servers** — supervised recipe + `circuit-open` counter ([PR #21](https://github.com/declaragent/declaragent/pull/21) · `1a120f8` · enhanced `b69d717`).
9. ✅ **GitOps `fleet render` — k8s manifests + Helm** — with `--no-servicemonitor` escape ([PR #20](https://github.com/declaragent/declaragent/pull/20) · `98c120a`).
10. ✅ **SIEM audit export — Splunk / Elastic / Datadog** — cursor held across restarts ([PR #22](https://github.com/declaragent/declaragent/pull/22) · `b8f6f94`).
11. ✅ **v1.1 Agent Graph — typed capabilities** — draft-07 validator + deterministic codegen ([PR #23](https://github.com/declaragent/declaragent/pull/23) · `4115fb1`, cardinality pin `2e60de4`).
12. ✅ **Recorded-conversation builder regression tests** — 5 canonical fixtures + replay harness + PR-template gate ([PR #24](https://github.com/declaragent/declaragent/pull/24) · `2aba945`, `BUILDER_RECORD=1` capture mode `7e61b31`).

**Remaining receipts (tracked, not ❌):**
- **Sustained Kafka soak proof** — 7 consecutive green `weekly-soak.yml` runs required before Pillar 3's enterprise badge flips to ✅ in `FIRST_PRINCIPLES_VALIDATION.md`.
- **Post-enterprise backlog polish** — consolidated in `docs/POST_ENTERPRISE_BACKLOG.md`. Non-blocking follow-ups against shipped features (52 items opened, routed to sprints).

---

## Capability deferrals explicitly named by the plans

Items the plans **intentionally put in later phases**. Not gaps — roadmap. Rows that 0.6.0 resolved are struck through below.

| Capability | Deferred to | Source |
| --- | --- | --- |
| ~~`RequestAgent` built-in~~ | ~~v1.1 Agent Graph~~ | Shipped 0.5.x slice 5 (`4d120b1`) |
| ~~Default rate limiting~~ | ~~Phase 5~~ | Shipped 0.6.0 Slice 4 |
| ~~Circuit breakers~~ | ~~Phase 4 scale testing~~ | Shipped 0.6.0 Slice 3 |
| ~~Prometheus `/metrics` endpoint~~ | ~~Phase 6 slice 2~~ | Shipped 0.6.0 Slice 1 |
| ~~NATS RPC transport factory~~ | ~~v1.1+~~ | Shipped 0.7.0 [PR #13](https://github.com/declaragent/declaragent/pull/13). `AGENT_RPC_PLAN.md §5` bar cleared — NATS joins Kafka as reference. |
| ~~Dispatch-DLQ active requeue~~ | ~~0.6.x patch / v1.1~~ | Shipped 0.7.0 [PR #14](https://github.com/declaragent/declaragent/pull/14) via new control socket. |
| ~~Full `fleet run` end-to-end over Kafka~~ | ~~0.6.x patch~~ | Shipped 0.7.0 [PR #10](https://github.com/declaragent/declaragent/pull/10) as literal subprocess. Soak *evidence* (7 consecutive greens) still accumulating. |
| ~~OIDC/OAuth2 on RPC envelopes~~ | ~~post-0.6.0~~ | Shipped 0.7.0 [PR #17](https://github.com/declaragent/declaragent/pull/17). |
| ~~Managed control plane~~ | ~~dedicated plan, ~4 weeks~~ | Shipped 0.7.0 [PRs #12, #15, #19, #27](https://github.com/declaragent/declaragent/pull/27). |
| ~~GitOps `fleet render`~~ | ~~post-0.6.0~~ | Shipped 0.7.0 [PR #20](https://github.com/declaragent/declaragent/pull/20). |
| ~~SIEM audit export~~ | ~~post-0.6.0~~ | Shipped 0.7.0 [PR #22](https://github.com/declaragent/declaragent/pull/22). |
| ~~v1.1 Agent Graph typed capabilities~~ | ~~v1.1~~ | Shipped 0.7.0 [PR #23](https://github.com/declaragent/declaragent/pull/23). |
| ~~Recorded-conversation builder regression tests~~ | ~~post-0.6.0~~ | Shipped 0.7.0 [PR #24](https://github.com/declaragent/declaragent/pull/24). |
| Push-button gcloud invoke | — (intentional non-goal) | `PHASE_7_PLAN.md` §9 |
| RPC transport factories for SQS / AMQP / MQTT (beyond Kafka + NATS) | v1.1+ | `AGENT_RPC_PLAN.md §5`. Adds land when customer signal names the broker. |
| Traffic-splitting canary (per-request weighted) | — (reverse-proxy territory) | Not tracked as a gap. |
| Fleet (v1.2 capabilities) | v1.2 | `FLEET_PLAN.md` |

---

## Methodology

Last refreshed 2026-04-23 post `cli@0.7.1` publish (CLI 0.7.1 + core 0.5.0 + plugin-agent-rpc 4.0.0 + channels/sources @ 4.0.0 on npm). Methodology:

1. Running the production audit query against `packages/cli/src` + `packages/core/src`
2. Cross-checking findings against all plan docs in `docs/` — primarily `ENTERPRISE_PRODUCTION_PLAN.md` (§1 status board) + `RELEASE_0_6_0_PLAN.md` + `AGENT_RPC_PLAN.md` + `CONTROL_PLANE_PLAN.md`
3. Distinguishing "code exists + tested" from "code exists + never called at runtime"
4. Preserving plan-named deferrals (🔵) as distinct from runtime-wiring gaps (🟡)
5. Recording ❌ → ✅ transitions in the corresponding `.changeset/*.md` + PR with evidence pointers

If a status claim drifts from reality, update both the mark and the evidence pointer. Don't let this file soften into marketing — its value is being correct about an uncomfortable state, even when the state is happy.

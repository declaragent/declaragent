# Declaragent — first-principles audit

**Theme:** *an agent for enterprises to build and manage fleets of agents.*

**Authored:** 2026-04-22, end of Slice 9 / staged 0.6.0. **Last refreshed:** 2026-04-23 post-0.7.4 Sprint 5 docs pass. **Verified against:** `@declaragent/cli@0.7.4` on npm.

Pairs with [AGENTS.md](../AGENTS.md) — this doc maps the **intent** (first principles) onto the current code. AGENTS.md is the per-feature evidence ledger. See also [`POST_ENTERPRISE_BACKLOG.md`](./POST_ENTERPRISE_BACKLOG.md) for the 52-item follow-up backlog (31 shipped across 0.7.1 → 0.7.4).

---

## Rubric

Two axes because enterprise-production is a strictly larger bar than single-machine-production. A feature can be production-ready for one and still leave gaps for the other.

| Mark | Single-machine production | Enterprise production (multi-node, soak-proven, compliance-safe) |
| --- | --- | --- |
| ✅ | Feature works end-to-end, tested, observed | Same + multi-machine soak + enterprise integrations (SSO / RBAC / vault / audit export / SLO) |
| 🟢 | — | Single-machine ready + enterprise soak done |
| 🟡 | Works with known sharp edges the operator needs to know | Component-present, integration work remaining |
| 🔵 | Roadmap-deferred by plan | Roadmap-deferred by plan |
| ❌ | Not yet built | Not yet built |

When a row splits between the two axes it reads `<single> / <enterprise>`.

---

## Pillar 1 · Define agents with capabilities, skills, and communication paths

The declarative core — what an agent **is**, what it **can do**, and how callers **reach it**.

| Capability | Single-machine | Enterprise | Evidence / gap |
| --- | --- | --- | --- |
| `agent.yaml` identity (name, model, systemPrompt, skills, tools) | ✅ | ✅ | `packages/core/src/agents/load-agent.ts` — Zod schema, typed error, 30+ tests |
| Markdown skills (frontmatter inputs/outputs, `{{var}}` interpolation) | ✅ | ✅ | `packages/core/src/skills/` — tiered discovery, full test coverage |
| Per-skill tool allowlist (`tools.defaults`) | ✅ | ✅ | Permission gate composes allowlist + channel/tenant overrides |
| `capabilities.yaml` (what this agent exposes over RPC) | ✅ | ✅ | `packages/core/src/fleet/capabilities-loader.ts` |
| `rpc-peers.yaml` (who this agent can call) | ✅ | ✅ | Loaded at `fleet-run.ts:641-649`. Dispatch attaches `RequestAgent` only when peers are present. |
| Event sources (webhook/cron/file-watch in-process + Kafka/NATS/SQS/AMQP/MQTT via external packages) | ✅ | ✅ | `packages/source-*/` + auto-discovery in `packages/cli/src/run-agent-sources.ts` (0.5.x) |
| Outbound channels (Slack/Telegram/Discord/WhatsApp via `SendMessage`) | ✅ | ✅ | `packages/channel-*/` + `createSendMessageTool` wired by `channels-runtime.ts` (0.5.x) |
| **Inbound channels → skills** via `channels.json#inbound.routes` | ✅ | ✅ | `createChannelInboundBridge` (0.6.0 Slice 6). Adapter-agnostic. 6 unit tests. |
| Per-channel permission config (allow/deny, per-user overrides) | ✅ | 🟡 | `packages/core/src/channels/permissions.ts` exists; enterprise path needs identity-provider integration (SSO) which isn't shipped. Non-blocking — not tracked in backlog. |
| Typed capability schemas (request/response contracts between agents) | ✅ | ✅ | Shipped in [PR #23](https://github.com/declaragent/declaragent/pull/23) (v1.1 Agent Graph, 2026-04-23). Hand-rolled draft-07 validator + deterministic codegen. |
| Per-agent RPC auth registry (disjoint `AuthVerifyRegistry` per agent) | ✅ | ✅ | POST_ENTERPRISE_BACKLOG.md #18 (v0.7.4). `StartFleetDaemonOptions.authRegistryByAgent` + `FleetDaemon.authRegistryFor(agentId)`; `fleetRun` walks each `<agentPath>/rpc-peers.yaml`. 5 new tests in `packages/cli/src/fleet-run.test.ts`. |
| Multi-tenant isolation (per-tenant extension scope, quotas, bus stamping) | ✅ | 🟡 | Phase 6 shipped — `packages/core/src/tenancy/`. Single-tenant soaked; multi-tenant has unit coverage + limited real-world time. `TenantAuditSink` now shared between `up` + `fleet-run` via ref-counted singleton (#40, v0.7.3). |

**Single-machine status:** **fully covered.** An operator can scaffold, skill, and wire an agent declaratively; every inbound + outbound path has a runtime.

**Enterprise gaps:** multi-tenant soak, SSO-bridged channel permissions. Typed capabilities + per-agent auth registry both shipped in 0.7.1 → 0.7.4.

---

## Pillar 2 · Deploy and monitor a fleet

The runtime — bring agents online, watch them, intervene when something breaks.

| Capability | Single-machine | Enterprise | Evidence / gap |
| --- | --- | --- | --- |
| `declaragent up [-d]` lifecycle (foreground + detached) | ✅ | ✅ | `up-cli.ts` + signal-driven shutdown + reload semantics |
| `declaragent ps / logs / down / events list` | ✅ | ✅ | 0.4.x shipped; `events list --state circuit-open` added 0.6.0 |
| **Prometheus `/metrics` endpoint** on `127.0.0.1:9464` (detached) | ✅ | ✅ | 0.6.0 Slice 1 — shared `PrometheusRegistry` threaded through source + channel deps |
| **OpenTelemetry auto-enable** via `OTEL_EXPORTER_OTLP_ENDPOINT` | ✅ | ✅ | 0.6.0 Slice 2 — `createOtelBridge` + peer-dep dynamic import |
| **Per-skill circuit breakers** (10-fail → 30s cooldown) | ✅ | ✅ | 0.6.0 Slice 3 — state + transition counters scrapable |
| **Default provider rate limits** | ✅ | ✅ | 0.6.0 Slice 4 — token bucket at `complete()` callsite, per-provider defaults |
| **Per-tool rate limits** + `TenantAuditSink` integration | ✅ | ✅ | [PR #18](https://github.com/declaragent/declaragent/pull/18); #28 `burst=2×rps` + #29 `>=` comparator fix (0.7.1); #16 tenant-sink threaded into `up-cli` (0.7.2) |
| **Dispatch DLQ** — tracking + active requeue via control socket | ✅ | ✅ | 0.6.0 Slice 5 + [PR #11](https://github.com/declaragent/declaragent/pull/11) (control socket) + [PR #14](https://github.com/declaragent/declaragent/pull/14) (requeue). |
| Hash-chained SQLite audit (`audit verify`) + SIEM export | ✅ | ✅ | `packages/core/src/audit/sqlite-sink.ts` + [PR #22](https://github.com/declaragent/declaragent/pull/22) SIEM export + **#11 back-pressure + #12 adaptive batch (v0.7.4)** + #40 unified ref-counted sink + #52 SIEM / `/audit` route shared singleton. |
| Secrets resolution (env / file / vault / aws-sm / gcp-sm / k8s) | ✅ | ✅ | `packages/core/src/secrets/` — TTL cache + rotation monitor; vault provider tested |
| **`declaragent fleet deploy` strategies** — rolling / all-or-nothing / per-agent / canary | ✅ | 🟡 | Code ships; canary is sequential-agent (not traffic-splitting). Real-world rollback drill is a non-gating polish. |
| **Managed control plane — aggregator across N `up` daemons** | ✅ | ✅ | Slices 1a/1b/1c/2 in [PR #12](https://github.com/declaragent/declaragent/pull/12) / [#15](https://github.com/declaragent/declaragent/pull/15) / [#19](https://github.com/declaragent/declaragent/pull/19) / [#27](https://github.com/declaragent/declaragent/pull/27). **Slice 3 cross-host fan-out (#50, v0.7.4)** — `fleet.yaml#hosts[]` + `CrossHostControlPlaneClient` + `fleet ps/events/dlq/logs [--host] [--json]`. Follow-up: #17 `fleet.yaml#controlPlane:` block (non-blocking). |
| **Multi-agent fan-out on `/events` + `/dlq` + `/logs`** via `?all=1` | ✅ | ✅ | #19 + #20 (v0.7.4). Scope-gated via `${path}?all=1` synthetic key in `routeScopes`. `/logs` caps at 50 watchers (413 over-cap) + `coalescePerAgentMs`. |
| **GitOps `fleet render` — k8s + Helm** | ✅ | ✅ | [PR #20](https://github.com/declaragent/declaragent/pull/20); #31 split ServiceMonitor files (v0.7.3). Follow-ups #32 (ConfigMap fan-out), #33 (Kustomize) open. |
| `declaragent deploy gcp-cloud-run` generator (emits `Dockerfile` + `service.yaml`) | ✅ | 🔵 | Deliberately stops short of invoking `gcloud` (per `PHASE_7_PLAN.md` §9). Enterprise path is `fleet render`. |
| Grafana dashboards + alert rules | 🟡 | 🟡 | `packages/testkit/dashboards/` + `OTEL_SETUP.md` examples. **#51 — importable dashboard bundle** aggregating `mcp_server_restarts_total` / `mcp_server_circuit_state` / `audit_export_queue_depth` / `rate_limit_waits_total` into one JSON: open. |
| Multi-machine coordinated deploy (traffic-splitting canary, blue/green, multi-region) | ❌ | ❌ | Today's canary is "deploy 1 agent, soak, deploy rest". True traffic-splitting needs per-target-adapter support. Non-blocking per `FLEET_PLAN.md`. |

**Single-machine status:** 0.6.0 closed the four biggest observability + reliability gaps. One `declaragent up -d` on a host running for a week with Prometheus + OTel attached is real.

**Enterprise status:** Pillar 2 is ✅ at enterprise scale as of 0.7.4. Managed control plane Slices 1–3 (including cross-host fan-out), GitOps render, SIEM export with back-pressure + adaptive batch, and dispatch-DLQ active requeue all ship. Open items (#17 `fleet.yaml#controlPlane:` block, #32 ConfigMap fan-out, #33 Kustomize, #51 Grafana bundle) are polish, not blockers. Traffic-splitting canary remains roadmap per `FLEET_PLAN.md`.

---

## Pillar 3 · Independent agents with optional delegation paths

Each agent owns its session, sources, skills, secrets. Inter-agent calls are declarative and opt-in.

| Capability | Single-machine | Enterprise | Evidence / gap |
| --- | --- | --- | --- |
| Process isolation (each `up` is its own process) | ✅ | ✅ | Detached launcher + separate SQLite + separate bus per `up` |
| RPC envelope (typed version, kind, correlation id, traceId) | ✅ | ✅ | `packages/core/src/rpc/envelope.ts` + Zod schema |
| `RequestAgent` tool (producer side) | ✅ | ✅ | `packages/plugin-agent-rpc/src/request-agent.ts` + wired via `buildRuntimeTools({ extra })` (0.5.x) |
| `agent-inbox` source (consumer side) | ✅ | ✅ | `packages/plugin-agent-rpc/src/agent-inbox.ts` |
| Loop detection on `causedBy` chain | ✅ | ✅ | Dispatcher `detectLoop()` walks up to 5 ancestors |
| Memory RPC transport (in-process) | ✅ | — | `packages/plugin-agent-rpc/src/memory-transport.ts` |
| **Kafka RPC transport** (cross-process / cross-host) | ✅ | ✅ | 0.6.0 Slice 7 + #26 literal-subprocess soak harness (v0.7.1). 7-consecutive-green `weekly-soak.yml` receipt still accumulating. |
| **NATS RPC transport** + per-topic queue groups | ✅ | ✅ | [PR #13](https://github.com/declaragent/declaragent/pull/13) + #25 per-topic groups (v0.7.1). |
| **JetStream RPC transport** (at-least-once with replay) | ✅ | ✅ | POST_ENTERPRISE_BACKLOG.md #23 (v0.7.2). `packages/plugin-agent-rpc/src/jetstream-transport.ts` + 16-case unit suite + `FLEET_INTEGRATION=1 + NATS_INTEGRATION=1` integration test. |
| **SQS RPC transport** (standard + FIFO) | ✅ | ✅ | #24a (v0.7.3). `packages/plugin-agent-rpc/src/sqs-transport.ts` + 22-case unit suite. |
| **AMQP RPC transport** (per-topic exchange/queue specs, DLX-friendly) | ✅ | ✅ | #24b (v0.7.4). `packages/plugin-agent-rpc/src/amqp-transport.ts` + 18-case unit suite; `amqplib@^0.10`. |
| **MQTT RPC transport** (QoS 1 default, MQTT 5 shared subs) | ✅ | 🟡 | #24c (v0.7.4). `packages/plugin-agent-rpc/src/mqtt-transport.ts` + 17-case unit suite; `mqtt@^5`. MQTT 3 caveat: no per-message handler ack — handler throw cannot trigger broker redelivery (redelivery only on session resume for QoS≥1). Live-broker CI rig is 0.7.x polish. |
| **RPC envelope auth (OIDC / OAuth2)** + `AUTH_REJECTED` wire constant | ✅ | ✅ | [PR #17](https://github.com/declaragent/declaragent/pull/17) + [PR #30](https://github.com/declaragent/declaragent/pull/30) (#8 `AUTH_REJECTED` in `RPC_ERROR_CODES`, v0.7.1). |
| **Per-agent `AuthVerifyRegistry`** (disjoint peer sets per agent) | ✅ | ✅ | POST_ENTERPRISE_BACKLOG.md #18 (v0.7.4). `StartFleetDaemonOptions.authRegistryByAgent` + `FleetAgentRpcContext.authRegistry`. |
| Typed capabilities between agents (schema-validated request/response) | ✅ | ✅ | [PR #23](https://github.com/declaragent/declaragent/pull/23) v1.1 Agent Graph (v0.7.1). Hand-rolled draft-07 validator + codegen. |
| Dynamic peer discovery (agent registry, not static YAML) | 🔵 | 🔵 | Not in roadmap. Current model is static `rpc-peers.yaml`. Post-v1.1 feature. |
| Full `fleet run` boot over a real broker with LLM handlers | ✅ | 🟡 | Kafka + NATS + JetStream live-broker integration rigs ship. AMQP + MQTT + SQS shipped with unit coverage only — live-broker CI rigs remain 0.7.x polish. |

**Single-machine status:** ✅. Memory transport + in-process fleet-run carries the `templates/fleet-starter/` workflow today.

**Enterprise status:** ✅ at 0.7.4. All six named brokers (Kafka + NATS + JetStream + SQS + AMQP + MQTT) ship with envelope auth, typed capabilities, and per-agent auth registries. Kafka weekly-soak receipt accumulates Sundays — capability complete, evidence not yet a 7-green streak. Live-broker CI for the three newest transports (AMQP / MQTT / SQS) is open polish.

---

## Pillar 4 · Agents have access to tools and MCP servers

The capability surface — what an agent can *do* when the LLM decides to act.

| Capability | Single-machine | Enterprise | Evidence / gap |
| --- | --- | --- | --- |
| 8 built-in tools (Read, Write, Edit, Glob, Grep, Bash, Agent, SendMessage) | ✅ | ✅ | `packages/cli/src/builtin-tools.ts` — same list every runtime uses |
| Permission gate (bypass / prompt / deny + per-rule globs) | ✅ | ✅ | `packages/core/src/permission/` — prompt mode wired into REPL; bypass is the default for `up` |
| MCP server activation at runtime (stdio) | ✅ | ✅ | 0.5.x slices 2a–2e — `loadScopedMCPServers` + `startMCPServers` in `bringUp` |
| MCP transports: HTTP + SSE + streamable HTTP | ✅ | ✅ | 0.5.x slices 2b–2c |
| MCP OAuth PKCE | ✅ | ✅ | 0.5.x slice 2d — remote MCP servers with full PKCE flow |
| `@server:resource` references + `readResource` | ✅ | ✅ | 0.5.x slice 2e |
| Plugin-contributed tools (install + consent-gated permissions) | ✅ | ✅ | 0.5.x slice 4 — `startPluginRuntime` in `attachDispatcherToAgent` |
| `SendMessage` tool for channel emit | ✅ | ✅ | 0.5.x slice 3; `ChannelMessageContent` rename (#41, v0.7.1) resolved name collision. |
| Per-call tool audit (who ran what, when, outcome) + SIEM export | ✅ | ✅ | SIEM export with back-pressure + adaptive batch shipped in [PR #22](https://github.com/declaragent/declaragent/pull/22) + #11 + #12 (v0.7.4). |
| **Per-tool rate limiting** (token-bucket gate at `runCallTool`) | ✅ | ✅ | [PR #18](https://github.com/declaragent/declaragent/pull/18) + #28 + #29 (burst + comparator, v0.7.1) + #16 `TenantAuditSink` in `up` (v0.7.2). `packages/core/src/tools/rate-limit-gate.ts`. |
| **Per-MCP-server aggregate rate-limit cap** | ❌ | 🟡 | POST_ENTERPRISE_BACKLOG.md #27 — shipping Sprint 5 toward 0.7.5. The only item holding Pillar 4's enterprise column at 🟡. |
| **MCP server crash recovery** (auto-restart + circuit breaker + counter) | ✅ | ✅ | [PR #21](https://github.com/declaragent/declaragent/pull/21) + #14 `mcp_server_circuit_open_total` (v0.7.1) + #30 supervised-recipe doc. **#13 graceful draining of in-flight tool calls across respawn** remains open (robustness polish). |
| Enterprise tool gating (approval workflows, break-glass) | ❌ | ❌ | Permission gate has prompt/deny modes; no approval-workflow / ticket-integration. Not tracked in the shipped enterprise plan. |

**Single-machine status:** ✅. The tool + MCP + plugin stack is the strongest pillar — four 0.5.x slices + prior Phase-3 work mean every extension mechanism is wired from boot.

**Enterprise gaps:** **one remaining item** — #27 per-MCP-server aggregate rate-limit cap (Sprint 5). Per-tool rate limiting, SIEM export with back-pressure + adaptive batch, and MCP auto-restart with circuit counter all shipped across 0.7.1 → 0.7.4. Approval workflows remain an open design space, not a blocker.

---

## Cross-pillar: what's honestly missing for "enterprise production"

The original 12-item `ENTERPRISE_PRODUCTION_PLAN.md` program shipped in full (0.7.0 → 0.7.1). The follow-up `POST_ENTERPRISE_BACKLOG.md` tracked 52 items surfaced during that push; **31 shipped across 0.7.1 → 0.7.4**, leaving **21 open**. Ranked by leverage:

### Tier 1 — holds an enterprise pillar column

1. **#27 · Per-MCP-server aggregate rate-limit cap (`mcp.rateLimit` block).** The only capability item still marking an enterprise column 🟡 (Pillar 4). Shipping Sprint 5 → 0.7.5.

### Tier 2 — behavioural / breaking-change

2. **#5b · `rpc.auth.enabled: true` default flip at 0.8.0.** Migration plan: [`ZERO_TRUST_DEFAULT_MIGRATION.md`](./ZERO_TRUST_DEFAULT_MIGRATION.md). Pre-flight inspector (`fleet audit-rpc --suggest-enable`) shipped at 0.7.3 (#5a).
3. **#10 · Schema-version policy for capability bumps.** Hard-fail vs soft-warn on breaking diffs. Needs product call.

### Tier 3 — robustness / topology polish

4. **#13 · MCP graceful draining of in-flight tool calls across respawn.**
5. **#15 · `/audit` tail-segment hash-chain verification** (deferred pending soak-size evidence).
6. **#17 · `fleet.yaml#controlPlane:` block** (today per-agent listener pick + warn).
7. **#39 · `createAgentInboxAdapter` proper construction in `up` and `fleet-run`** (half-day refactor, deferred until second consumer).

### Tier 4 — transport breadth (live-broker CI rigs)

8. Live-broker fleet integration tests for AMQP + MQTT + SQS (transports themselves ship with unit coverage).

### Tier 5 — GitOps polish

9. **#32 · Fan channel/source/plugin configs into dedicated ConfigMaps + `envFrom` mounts.**
10. **#33 · Kustomize render target.**

### Tier 6 — builder fixture polish

11–15. **#34 / #35 / #36 / #37 / #38** — divergence policy, multi-turn granularity, `tool_result` blocks in `BUILDER_RECORD`, `FixtureEntry` cost-regression fields, longer-lived `RecordingProviderHandle`.

### Tier 7 — platform maturity

16. **#46 · Native `bun pm audit`** — deferred to upstream Bun feature.
17. **#51 · Grafana dashboard bundle** aggregating the four key counters into one importable JSON.

### Tier 8 — pre-cut operator items (ship-gate 0.7.5+)

18. **#1 · Flip Pillar 3 enterprise badge** after first green `weekly-soak.yml`.
19. **#2 · Cut `@declaragent/cli@0.7.0` release with full enterprise stack.** *(Superseded — 0.7.0 → 0.7.4 already shipped; row reads as done in spirit but hasn't been formally ticked.)*
20. **#3 · Flip website `/principles` 🟡 → ✅.**

### Blank-citation flags for maintainer follow-up

- **Pillar 3 Kafka soak receipt.** No deterministic citation in this doc — the `weekly-soak.yml` green-run count is tracked externally. Re-verify at each minor cut.
- **Live-broker CI results for JetStream** — integration tests exist (`FLEET_INTEGRATION=1 + NATS_INTEGRATION=1`) but no public dashboard of nightly green-rates similar to Kafka.

**Total remaining work to close the 21 open items:** roughly **6–9 focused engineer-weeks**, split across the seven sprints of the post-enterprise backlog push. No open-ended research; every row has a claimed agent or an explicit deferral reason.

---

## What "production scale" means in each sense

Because the user asked specifically about production scale:

### Single-machine production (one host, one agent or small fleet)
**Status today: ✅ ready on 0.7.4.**

Concrete scenarios that work:
- One `declaragent up -d` running for weeks, webhook + cron events flowing in, Claude calls out, Slack replies out. `/metrics` scraped by Prometheus. Circuit breakers trip + recover. Per-tool + per-provider rate limits keep Anthropic tier compliance. Dispatch DLQ tracks rejected events and supports active requeue through the control socket.
- A 3-agent orchestrator → classifier → reporter fleet running in `fleet run` (memory transport or any of Kafka / NATS / JetStream / SQS / AMQP / MQTT).
- Single-tenant SaaS product using agents as the backend for ~100-1000 events/day.

Honestly-named sharp edges:
- Weekly Kafka soak 7-green receipt still accumulating.
- Live-broker CI rigs for AMQP + MQTT + SQS not yet shipped (unit coverage only).
- No ship-with-dashboards flow (#51 open) — operators wire Grafana + Jaeger themselves (docs exist).

### Enterprise production (multi-host fleet, regulatory controls, SRE rotation)
**Status today: ✅ for 4 of 5 pillars; Pillar 4 is one MCP-polish item away.**

Shipped program: all 12 items on `ENTERPRISE_PRODUCTION_PLAN.md` closed during the 0.7.0 → 0.7.1 push. Post-enterprise follow-ups: 31 of 52 shipped across 0.7.1 → 0.7.4.

The single capability item left: **#27 per-MCP-server aggregate rate-limit cap** (Sprint 5). Two behavioural items (#5b zero-trust default flip, #10 schema-version policy) are planned for 0.8.0 with explicit migration plans. Everything else is polish.

What's **present** that enterprise requires (all shipped):
- Hash-chained audit + SIEM export with back-pressure + adaptive batch (for compliance)
- Multi-tenant runtime + unified ref-counted audit sink (for isolation)
- Secrets rotation (vault / AWS SM / GCP SM / k8s)
- Per-tool + per-provider rate limits (with tenant-keyed `rate_limited` audit events)
- Circuit breakers (dispatcher-level + MCP-supervisor level)
- Prometheus + OTel (observability) + control-plane cross-host fan-out
- GitOps `fleet render` (k8s + Helm + split ServiceMonitor)
- Declarative config + Git (change review)
- OIDC/OAuth2 envelope auth + per-agent `AuthVerifyRegistry` + proxy-aware loopback semantics
- Six broker transports (Kafka / NATS / JetStream / SQS / AMQP / MQTT)

The enterprise story is now a receipt / polish story, not an architecture story.

---

## Relationship to the roadmap

| Audit gap | Where in the roadmap |
| --- | --- |
| Kafka 7-green soak receipt | `ENTERPRISE_PRODUCTION_PLAN.md` §1 acceptance #4 — accumulating Sundays |
| Per-MCP aggregate rate-limit cap (#27) | `POST_ENTERPRISE_BACKLOG.md` row #27 — Sprint 5 → 0.7.5 |
| Zero-trust default flip at 0.8.0 (#5b) | `ZERO_TRUST_DEFAULT_MIGRATION.md` |
| Capability schema-version policy (#10) | `POST_ENTERPRISE_BACKLOG.md` row #10 — awaits product call |
| MCP graceful draining (#13) | `POST_ENTERPRISE_BACKLOG.md` row #13 |
| `fleet.yaml#controlPlane:` block (#17) | `POST_ENTERPRISE_BACKLOG.md` row #17 |
| Live-broker CI for AMQP / MQTT / SQS | `POST_ENTERPRISE_BACKLOG.md` transport tier 4 |
| Traffic-splitting canary | `FLEET_PLAN.md` — v1.2 |
| Grafana dashboard bundle (#51) | `POST_ENTERPRISE_BACKLOG.md` row #51 |
| Builder fixture polish (#34–38) | `POST_ENTERPRISE_BACKLOG.md` builder tier |

Recommended next planning effort: **none required** — the 21 remaining items each have a named backlog row, an owner, and a deferral reason or an active sprint. Sprint 5 closes #27 + drafts the 0.8.0 zero-trust migration plan; Sprints 6+ pick from the remaining tiers.

---

## Change log for this doc

- **2026-04-22** — initial audit after Slice 9 of `RELEASE_0_6_0_PLAN.md`. Theme framed as "agent to build and manage agents for enterprise."
- **2026-04-23** — refreshed for 0.7.4 post-enterprise Sprint 5 docs pass. Pillars 1–3 flipped to ✅ at enterprise scale; Pillar 4 holds at 🟡 pending #27; Pillar 5 remains ✅. Rewrote the Cross-pillar gap list from the stale 8-item post-0.6 framing to the 21-item post-enterprise-backlog framing. Added roadmap-table rows for #5b migration, #13, #17, #27, #51, #34–38.

Update rules:
- Refresh on every minor bump (0.7.0, 0.8.0, …) + whenever an enterprise customer reports a gap that maps to a row here.
- Never soften the enterprise assessment to match marketing copy. The website lives in `website/index.html`; this doc lives in `docs/`. Different audiences, different honesty budgets.
- When a row flips axis — e.g. Kafka soak lands and multi-machine transport becomes 🟢 — update the evidence pointer and bump the next-10-weeks table.

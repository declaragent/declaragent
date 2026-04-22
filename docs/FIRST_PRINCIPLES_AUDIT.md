# Declaragent — first-principles audit

**Theme:** *an agent for enterprises to build and manage fleets of agents.*

**Authored:** 2026-04-22, end of Slice 9 / staged 0.6.0. Refresh alongside each minor bump or whenever a new deployment pattern goes into production.

Pairs with [AGENTS.md](../AGENTS.md) — this doc maps the **intent** (first principles) onto the current code. AGENTS.md is the per-feature evidence ledger.

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
| Per-channel permission config (allow/deny, per-user overrides) | ✅ | 🟡 | `packages/core/src/channels/permissions.ts` exists; enterprise path needs identity-provider integration (SSO) which isn't shipped. |
| Typed capability schemas (request/response contracts between agents) | 🔵 | 🔵 | `AGENT_RPC_PLAN.md` §1 — v1.1 Agent Graph. Today agents coordinate through untyped JSON payloads; a loose contract but the envelope is validated. |
| Multi-tenant isolation (per-tenant extension scope, quotas, bus stamping) | ✅ | 🟡 | Phase 6 shipped — `packages/core/src/tenancy/`. Single-tenant soaked; multi-tenant has unit coverage + limited real-world time. |

**Single-machine status:** **fully covered.** An operator can scaffold, skill, and wire an agent declaratively; every inbound + outbound path has a runtime.

**Enterprise gaps:** typed capabilities, multi-tenant soak, SSO-bridged channel permissions. All roadmap items, not unknowns.

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
| **Dispatch DLQ tracking** (`rejected_events` table + `dlq list/show/drop --kind dispatch`) | ✅ | ✅ | 0.6.0 Slice 5. **Active requeue requires an `up` control socket → 🟡 follow-up.** |
| Hash-chained SQLite audit (`audit verify`) | ✅ | 🟡 | `packages/core/src/audit/sqlite-sink.ts`. Enterprise needs WORM / immutable storage export; today the chain lives next to the agent. |
| Secrets resolution (env / file / vault / aws-sm / gcp-sm / k8s) | ✅ | ✅ | `packages/core/src/secrets/` — TTL cache + rotation monitor; vault provider tested |
| **`declaragent fleet deploy` strategies** — rolling / all-or-nothing / per-agent / canary | ✅ | 🟡 | Code ships; canary needs a real-world rollback drill against docker-compose / Cloud Run before "enterprise" tick |
| `declaragent deploy gcp-cloud-run` generator (emits `Dockerfile` + `service.yaml`) | ✅ | 🔵 | Deliberately stops short of invoking `gcloud` (per `PHASE_7_PLAN.md` §9). Enterprise expectations lean toward GitOps — see gap list below. |
| Grafana dashboards + alert rules | 🟡 | 🟡 | `packages/testkit/dashboards/` + `OTEL_SETUP.md` alerting examples. Operator must import + tune. No ship-with-dashboards flow. |
| Multi-machine coordinated deploy (traffic-splitting canary, blue/green, multi-region) | ❌ | ❌ | Today's canary is "deploy 1 agent, soak, deploy rest". True traffic-splitting needs per-target-adapter support. |
| Managed control plane (fleet status UI, incident tracking, SLO alerting) | ❌ | ❌ | No built-in console. Intentional for v1.0 but enterprise customers often expect one. |

**Single-machine status:** 0.6.0 closed the four biggest observability + reliability gaps. One `declaragent up -d` on a host running for a week with Prometheus + OTel attached is real.

**Enterprise gaps:** traffic-splitting canary, managed control plane, GitOps integration, audit export to SIEM. All tracked as post-0.6 roadmap items.

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
| **Kafka RPC transport** (cross-process / cross-host) | ✅ | 🟡 | 0.6.0 Slice 7 — `createKafkaTransport` + 7 unit tests + `FLEET_INTEGRATION=1` harness + nightly CI. **Soak-proof pending (plan requires 7 consecutive greens).** |
| NATS / SQS / AMQP / MQTT RPC transports | ❌ | ❌ | Factory plumbing exists in `fleet-run.ts:228-244`; no broker-specific packages ship yet. Kafka is the template; others are ~1 day each. |
| Typed capabilities between agents (schema-validated request/response) | 🔵 | 🔵 | v1.1 Agent Graph — `AGENT_RPC_PLAN.md` §1 |
| Dynamic peer discovery (agent registry, not static YAML) | 🔵 | 🔵 | Not in roadmap. Current model is static `rpc-peers.yaml`. Enterprise fleets likely want something like Consul / service-mesh integration. |
| Full `fleet run` boot over a real broker with LLM handlers | 🟡 | 🟡 | 0.6.0 Slice 7 proved the transport layer. End-to-end `RequestAgent` through mocked LLM is the remaining piece. |

**Single-machine status:** ✅. Memory transport + in-process fleet-run carries the `templates/fleet-starter/` workflow today. The test we just ran (`/tmp/test-0.6.0-local-triage-fleet.sh`) is a 3-agent orchestration proof.

**Enterprise gaps:** Kafka soak, missing broker factories (NATS/SQS/AMQP/MQTT), no dynamic peer discovery. Kafka unblocks cross-host; the missing broker factories unblock existing-infra customers. Dynamic discovery is a post-v1.1 feature.

---

## Pillar 4 · Agents have access to tools and MCP servers

The capability surface — what an agent can *do* when the LLM decides to act.

| Capability | Single-machine | Enterprise | Evidence / gap |
| --- | --- | --- | --- |
| 7 built-in tools (Read, Write, Edit, Glob, Grep, Bash, Agent) | ✅ | ✅ | `packages/cli/src/builtin-tools.ts` — same list every runtime uses |
| Permission gate (bypass / prompt / deny + per-rule globs) | ✅ | ✅ | `packages/core/src/permission/` — prompt mode wired into REPL; bypass is the default for `up` |
| MCP server activation at runtime (stdio) | ✅ | ✅ | 0.5.x slices 2a–2e — `loadScopedMCPServers` + `startMCPServers` in `bringUp` |
| MCP transports: HTTP + SSE + streamable HTTP | ✅ | ✅ | 0.5.x slices 2b–2c |
| MCP OAuth PKCE | ✅ | ✅ | 0.5.x slice 2d — remote MCP servers with full PKCE flow |
| `@server:resource` references + `readResource` | ✅ | ✅ | 0.5.x slice 2e |
| Plugin-contributed tools (install + consent-gated permissions) | ✅ | ✅ | 0.5.x slice 4 — `startPluginRuntime` in `attachDispatcherToAgent` |
| `SendMessage` tool for channel emit | ✅ | ✅ | 0.5.x slice 3 |
| Per-call tool audit (who ran what, when, outcome) | ✅ | 🟡 | `packages/core/src/audit/sqlite-sink.ts` — records every tool call. Enterprise audit typically wants export to SIEM / immutable WORM; current sink is local SQLite. |
| Tool-level rate limiting (e.g. cap `Bash` at 20/min) | ❌ | ❌ | Rate limits today are per-provider (LLM side). Tool-level limiting isn't designed. |
| MCP server crash recovery | 🟡 | 🟡 | Fail-closed per server at boot; no auto-restart. A crashed MCP silently stops serving until restart. |
| Enterprise tool gating (approval workflows, break-glass) | ❌ | ❌ | Permission gate has prompt/deny modes; no approval-workflow / ticket-integration. |

**Single-machine status:** ✅. The tool + MCP + plugin stack is the strongest pillar — four 0.5.x slices + prior Phase-3 work mean every extension mechanism is wired from boot.

**Enterprise gaps:** tool rate limiting, approval workflows, SIEM audit export, MCP crash auto-recovery.

---

## Cross-pillar: what's honestly missing for "enterprise production"

Eight items sit between "0.6.0 on a single box" and "a Fortune-500 SRE team would approve this for production." Ranked by estimated leverage:

1. **Kafka soak + NATS factory (~2 weeks).** Finishes Slice 7's integration arc. Unblocks any customer whose existing message bus isn't Kafka.
2. **Enterprise auth between agents (~3 weeks).** OAuth2 / OIDC on the RPC envelope's `auth` field. Today envelopes travel with `auth: { kind: 'internal' }`; cross-org / cross-tenant calls need a real identity claim. `packages/core/src/rpc/envelope.ts` already models `RpcAuth` — needs provider implementations.
3. **Managed control plane (~4 weeks, probably a separate repo).** Aggregate `ps / logs / events list / dlq list` across many hosts into a single UI. Today operators SSH per-host. Option: ship a tenant-aware `declaragent control-plane` verb that polls the metrics endpoint + aggregates audit rows.
4. **GitOps deploy model (~1 week + integration).** `fleet deploy` generates `kubectl apply`-style commands; enterprise customers typically prefer ArgoCD / Flux flows. Ship a `declaragent fleet render` verb that produces the K8s manifests directly into the GitOps repo.
5. **SIEM-grade audit export (~1 week).** `audit verify` works locally; enterprise audit wants tamper-evident export to Splunk / Sumo / Datadog. The hash chain is the building block; needs a `declaragent audit export --to otlp/splunk/s3` verb.
6. **Traffic-splitting canary (~2 weeks).** Current canary is "deploy 1, soak, deploy rest." Traffic-split canary (10% → 50% → 100%) needs target-adapter support. Cloud Run revisions do this natively; K8s needs an ingress controller; Docker Compose can't.
7. **Tool-level rate limits + approval workflows (~2 weeks).** The permission gate hooks are there — needs a prompt-mode integration with Slack approval / PagerDuty runbooks for break-glass scenarios.
8. **MCP crash auto-recovery (~3 days).** Today: soft-fail at boot, silent after. Needs a `startMCPServers` option that re-spawns on exit with backoff, with a counter so a crash-looping server eventually gets quarantined.

**Total to "enterprise production":** roughly **10–12 focused weeks of eng time**. The work is well-understood — no open-ended research required.

---

## What "production scale" means in each sense

Because the user asked specifically about production scale:

### Single-machine production (one host, one agent or small fleet)
**Status today: ✅ ready with 0.6.0 staged.**

Concrete scenarios that work:
- One `declaragent up -d` running for weeks, webhook + cron events flowing in, Claude calls out, Slack replies out. `/metrics` scraped by Prometheus. Circuit breakers trip + recover. Rate limits keep you under Anthropic's tier cap. Dispatch DLQ lets you audit rejected events.
- A 3-agent orchestrator → classifier → reporter fleet running in `fleet run` (memory transport) — proven end-to-end by `/tmp/test-0.6.0-local-triage-fleet.sh` against real LLM calls.
- Single-tenant SaaS product using agents as the backend for ~100-1000 events/day.

Honestly-named sharp edges:
- Kafka transport shipped but not soaked (use memory for now).
- Active DLQ requeue missing — `dlq drop` is the current escape hatch.
- No built-in dashboards — operators wire Grafana + Jaeger themselves (docs exist).

### Enterprise production (multi-host fleet, regulatory controls, SRE rotation)
**Status today: 🟡 10-12 weeks away.**

What's missing boils down to: (1) finish the Kafka soak, (2) ship enterprise auth between agents, (3) ship a control-plane aggregator, (4) GitOps + SIEM audit export. Each item is ≤3 weeks; none is open-ended.

What's **present** that enterprise requires:
- Hash-chained audit (for compliance)
- Multi-tenant runtime (for isolation)
- Secrets rotation (vault / AWS SM / GCP SM)
- Rate limits (provider-level)
- Circuit breakers (dispatcher-level)
- Prometheus + OTel (observability)
- Declarative config + Git (change review)

The enterprise gap isn't *architectural* — it's *integration*. The building blocks are here.

---

## Relationship to the roadmap

| Audit gap | Where in the roadmap |
| --- | --- |
| Kafka soak | `RELEASE_0_6_0_PLAN.md` Slice 7 — nightly proof pending |
| DLQ active requeue | `RELEASE_0_6_0_PLAN.md` Slice 5 — needs `up` control socket |
| NATS/SQS/AMQP/MQTT transports | `AGENT_RPC_PLAN.md` §5 — v1.1 Agent Graph |
| Typed capabilities | `AGENT_RPC_PLAN.md` §1 — v1.1 |
| Traffic-splitting canary | `FLEET_PLAN.md` — v1.2 |
| Managed control plane | Not in any plan doc yet — **should be the next planning doc** |
| Enterprise auth (OIDC on envelopes) | `AGENT_RPC_PLAN.md` §6 mentions RpcAuth; full design pending |
| SIEM audit export | Not in any plan doc yet — small feature, belongs in 0.6.x patch or 0.7.0 |

Recommended next planning effort: **`docs/CONTROL_PLANE_PLAN.md`** — scopes a thin aggregator that turns N `up` processes into a single monitored fleet. Unlocks items 3 + 5 from the gap list.

---

## Change log for this doc

- **2026-04-22** — initial audit after Slice 9 of `RELEASE_0_6_0_PLAN.md`. Theme framed as "agent to build and manage agents for enterprise."

Update rules:
- Refresh on every minor bump (0.7.0, 0.8.0, …) + whenever an enterprise customer reports a gap that maps to a row here.
- Never soften the enterprise assessment to match marketing copy. The website lives in `website/index.html`; this doc lives in `docs/`. Different audiences, different honesty budgets.
- When a row flips axis — e.g. Kafka soak lands and multi-machine transport becomes 🟢 — update the evidence pointer and bump the next-10-weeks table.

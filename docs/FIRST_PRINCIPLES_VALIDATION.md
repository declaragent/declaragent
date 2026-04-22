# Declaragent — First-Principles Validation

**Authored:** 2026-04-22 · **Verified against:** `@declaragent/cli@0.6.0` (live on npm), `@declaragent/core@0.4.0`, `@declaragent/plugin-agent-rpc@3.0.0`.

**Sibling docs:**
- [CLAUDE.md](../CLAUDE.md) — project-orientation guide
- [AGENTS.md](../AGENTS.md) — per-feature evidence ledger
- [docs/FIRST_PRINCIPLES_AUDIT.md](./FIRST_PRINCIPLES_AUDIT.md) — exhaustive capability matrix

This document answers one question: **"How much of the first-principles vision is genuinely possible at production scale today?"** Every claim below is backed by file:line evidence. When the code is incomplete, it is marked 🟡 or ❌ — not ✅.

---

## The first-principles statement

> An enterprise operator should be able to **converse with `declaragent` itself** to build a fleet of AI agents — each agent with declared capabilities, skills, inbound/outbound channels, peers, tools, and MCP access — and then **deploy and monitor that fleet** at production scale, with each agent independent but free to delegate work over a typed RPC boundary.

That statement decomposes into **five** capabilities, not four. The builder-as-agent is the differentiator and is treated as a first-class pillar here.

| Pillar | Single-machine | Enterprise (multi-host, SSO/SIEM/GitOps, soak-proven) |
| --- | --- | --- |
| 1 · **Define** agents declaratively | ✅ | 🟡 |
| 2 · **Deploy + monitor** fleet | ✅ | 🟡 |
| 3 · **Independent agents** + delegation | ✅ | 🟡 |
| 4 · **Tools + MCP** access | ✅ | 🟡 |
| 5 · **Conversational builder** → deployable fleet | ✅ | 🟡 |

**Headline:** Single-machine production is ✅ ready end-to-end for all five pillars. Enterprise is uniformly 🟡 — the architecture exists, the integrations don't.

---

## Pillar 1 · Define agents declaratively

What an agent **is**, what it **can do**, who **talks to it**, who **it calls**.

### Works today ✅ (single-machine)

- **Agent identity** — `agent.yaml` loaded by `packages/core/src/agents/load-agent.ts:57-172` (Zod-validated: name, model, systemPrompt, temperature, maxTokens, subagentDepthCap, skills[], tools.defaults[]). Hard-fails on malformed skill frontmatter.
- **Markdown skills** — tiered discovery + frontmatter inputs/outputs + `{{var}}` interpolation in `packages/core/src/skills/{loader,frontmatter,runner}.ts`.
- **Tool allowlist per skill** — composed with channel + tenant overrides by the permission gate.
- **Inbound event sources** — webhook, cron, file-watch in-process + `@declaragent/source-{kafka,nats,sqs,amqp,mqtt}` auto-discovered by `packages/cli/src/run-agent-sources.ts`.
- **Outbound channels** — Slack, Telegram, Discord, WhatsApp via `createSendMessageTool` wired in `packages/core/src/channels/channels-runtime.ts`.
- **Inbound channels → skills** — route table in `channels.json#inbound.routes` via `createChannelInboundBridge` (0.6.0 Slice 6).
- **Per-channel permissions** — `packages/core/src/channels/permissions.ts` (allow/deny, per-user overrides).
- **Peers + capabilities** — `rpc-peers.yaml` + `capabilities.yaml` loaded by `packages/core/src/rpc/{peers-loader,capabilities-loader}.ts`. Dispatch attaches `RequestAgent` only when peers exist.

### Gaps at enterprise scale 🟡

- Typed capability schemas (v1.1 Agent Graph — `AGENT_RPC_PLAN.md §1`) not shipped; today's RPC payloads are loose JSON with an envelope check.
- SSO-bridged channel permissions not wired (no OIDC/OAuth2 identity provider integration).
- `agent.yaml` top-level schema uses `passthrough()` — channel/source/plugin refs are only validated by their downstream loaders, not at agent-load time.

**Verdict:** Declaration works. Typed contracts + SSO are the remaining enterprise increments.

---

## Pillar 2 · Deploy and monitor a fleet

### Works today ✅ (single-machine)

- **Lifecycle verbs** — `up [-d]`, `ps`, `logs`, `down`, `events list`, `dlq list/show/drop`, `audit verify` all implemented as standalone files in `packages/cli/src/`.
- **Prometheus `/metrics`** — real OpenMetrics exporter in `packages/core/src/observability/prometheus.ts:25-95`; bound on `127.0.0.1:9464` in detached mode (`up-cli.ts:944-961`). Threaded into every source + channel via shared `PrometheusRegistry`.
- **OpenTelemetry** — `createOtelBridge()` in `packages/core/src/events/observability.ts:253` dynamically loads `@opentelemetry/api` as an optional peer dep; activates only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`up-cli.ts:1051-1058`).
- **Circuit breakers** — per-skill, 10 failures → 30s cooldown → half-open probe (`packages/core/src/events/circuit-breaker.ts`).
- **Provider rate limits** — token-bucket wrapper `ProviderTokenBucket` in `packages/core/src/providers/rate-limit.ts:49-126` (Anthropic 50rps / OpenRouter 20rps / 10rps default).
- **Dispatch DLQ** — rejected events tracked in SQLite `rejected_events`; `dlq list/show/drop --kind dispatch` CLI (active requeue is a 0.6.x follow-up).
- **Canary deploys** — real sequential-agent canary with soak window + post-soak re-probe (`fleet-deploy-cli.ts:326-346`, `canaryWaitMs` lines 215-220).
- **Deploy target** — `deploy gcp-cloud-run` generates Dockerfile + service.yaml (user invokes `gcloud` themselves).
- **Hash-chained audit** — SHA-256 over every tool call / channel send / tenant boundary / secret resolve (`audit verify` checks the chain).

### Gaps at enterprise scale 🟡

- **No managed control plane.** There is no aggregator over N `up` daemons across hosts. `docs/CONTROL_PLANE_PLAN.md` exists; implementation does not.
- **Canary is sequential-agent, not traffic-splitting.** Enterprises expecting per-request weighted rollouts will need reverse-proxy help.
- **Audit is local SQLite only** — no SIEM export (Splunk/Elasticsearch/Datadog) shipped.
- **No GitOps render.** `fleet render` target from SPEC_AND_PLAN not implemented.
- **`deploy` generates Cloud Run only.** No EKS/GKE/Fargate/Nomad targets shipped.

**Verdict:** The runtime telemetry + breakers + canary story is genuinely enterprise-grade *at single-machine scale*. Multi-host coordination + compliance export are the remaining work.

---

## Pillar 3 · Independent agents with delegation

Each agent runs in its own process. Calls between agents go through a transport envelope with pending-response correlation, not a shared mutable state.

### Works today ✅ (single-machine)

- **Plugin-agent-rpc** — ~2100 LOC of real implementation in `packages/plugin-agent-rpc/src/`:
  - `request-agent.ts` (350 lines) — the `RequestAgent` LLM tool.
  - `agent-inbox.ts` (329 lines) — peer-side inbox + handler dispatch.
  - `memory-transport.ts` (105 lines) — in-process transport for single-machine fleets.
  - `kafka-transport.ts:81-220` — `createKafkaTransport(opts)` with dynamic `kafkajs` import (line 222-228).
  - `pending-registry.ts`, `envelope.ts`, `respond.ts` — request/response correlation.
- **Integration test** — `packages/plugin-agent-rpc/src/integration.test.ts` (173 lines) proves two-agent round trip in-process.
- **Cross-process Kafka test** — `packages/testkit/src/fleet-integration/kafka-rpc.test.ts` exercises `createKafkaTransport` against a live Redpanda, gated by `FLEET_INTEGRATION=1`.
- **Nightly CI** — `.github/workflows/nightly-integration.yml` boots Redpanda via `docker compose`, runs the suite with 3 retries, auto-files a GitHub issue on failure. Beta→rc exit criterion is 7 green nightlies.
- **Reference fleet** — `templates/fleet-starter/` ships a concierge + pr-reviewer fleet with `rpc-peers.yaml`, `capabilities.yaml`, `fleet.yaml`, per-agent skills.
- **Version-skew detection** — `packages/core/src/fleet/version-skew.ts`, opt-in per `templates/fleet-starter/fleet.yaml:29-32`.

### Gaps at enterprise scale 🟡

- **Kafka soak proof incomplete.** The integration test explicitly excludes "full `declaragent fleet run` boot with real LLM handlers" (`kafka-rpc.test.ts:17-20`). Transport works; end-to-end fleet-over-Kafka is the next slice.
- **No NATS / SQS / AMQP / MQTT transport factories.** Source adapters for these brokers exist as separate packages, but `createNatsTransport`, `createSqsTransport`, etc. do not — plugin-agent-rpc only ships the memory + Kafka transports today. (CLAUDE.md §"Next priorities" #3 confirms.)
- **RPC authentication shape without providers.** `RpcAuth` exists in `envelope.ts`; no OIDC/OAuth2 implementations wire up to real IdPs yet.
- **Typed capabilities roadmapped, not built** — v1.1 Agent Graph (`AGENT_RPC_PLAN.md §1`).

**Verdict:** Agent-to-agent delegation works in-process and can work over Kafka. Declaring it "production-proven" for cross-host enterprises needs the soak + NATS + auth increments.

---

## Pillar 4 · Tools + MCP access

### Works today ✅

- **8 built-in tools** (CLAUDE.md previously said "7" — current count on disk is **8**): `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Agent` (sub-agent spawn), `SendMessage`. All colocated with tests in `packages/core/src/tools/`.
- **MCP client** covers all four transport kinds (`packages/core/src/mcp/index.ts`): stdio (`stdio-client.ts`), HTTP (`http-client.ts:39`), SSE (`sse-client.ts:47`), streamable HTTP (`streamable-http-client.ts:52`).
- **OAuth 2.1 + PKCE** for MCP servers — `packages/cli/src/mcp-oauth.ts:1-60`. Real `.well-known/oauth-authorization-server` discovery, S256 PKCE, token persistence at `~/.declaragent/mcp-oauth.json` mode 0600.
- **Consent gate for MCP** — `mcp-consent.ts` + `mcp-consent-ui.tsx` (user must approve tool grants on first install).
- **Plugin system** — skills, tools, channels, sources bundled as npm packages; consent-gated on install.

### Gaps at enterprise scale 🟡

- **No per-tool rate limit** — provider-level only.
- **No approval-workflow integration** for sensitive tool calls (Slack "/approve"-style gates aren't built in).
- **No auto-recovery for crashed MCP servers.** Restart today requires operator intervention.
- **No centralized tool catalog / policy push** — every agent installs its MCP list independently.

**Verdict:** Tool + MCP surface is production-quality at single-machine scale. Rate-limits + auto-recovery + approval workflows are the enterprise deltas.

---

## Pillar 5 · Conversational builder → deployable fleet

**This is the differentiating claim.** "An agent to build and manage agents" only lands if a user can start `declaragent`, describe what they want, and walk away with a working fleet.

### How it works today ✅ (single-machine)

- **Entry point.** Running `declaragent` with no subcommand launches the Ink REPL (`packages/cli/src/index.tsx:259-263`). Builder tools unlock when `DECLARAGENT_BUILDER=on` is set (strict — `"ON"` / `"1"` do **not** enable; see `register.ts:62-64` and `register.test.ts:6-9`).
- **14 builder tools registered** into the LLM's tool array (`register.ts:71-96`) alongside the 8 built-ins:
  - Authoring — `DeclaraAddSkill`, `DeclaraAddSecret`, `DeclaraAddSource`, `DeclaraAddChannel`, `DeclaraAddMCP`, `DeclaraAddPlugin`, `DeclaraAuthPlaybook`
  - Fleet — `DeclaraFleetAdd`, `DeclaraAddPeer`, `DeclaraFleetStatus`
  - Plan/apply — `DeclaraProposeChange`, `DeclaraApplyChange`
  - Ops — `DeclaraEventsTail`, `DeclaraAuditVerify`, `DeclaraDlqShow`
- **300-line system prompt** (`packages/cli/src/app.tsx:83-…`) teaches mental model, starter templates, CLI verbs, fleet heuristic (multi-responsibility → multi-agent), design rules, plan-confirm-execute protocol, hard rule against writing secrets.
- **Plan-confirm-execute** — model emits `DeclaraProposeChange`; REPL blocks on `/yes | /no | /edit <n> …` (slash parser in `slash-commands.test.ts:91-118`); on confirm, `DeclaraApplyChange({ proposalId })` runs per-kind runners with git-backed rollback (`apply-change.ts:11-23`).
- **Scope + safety** — `scope.ts` restricts writes to the project directory; `secret-guard.ts` blocks literal secret leakage; `proposals.ts` (376 lines) manages TTL + edits.
- **End-to-end test** — `packages/cli/src/builder/fleet-e2e.test.ts` scaffolds a real fleet, runs proposal→apply with `addAgent×2 + addPeer`, asserts on-disk `agents/concierge/agent.yaml`, `agents/pr-reviewer/agent.yaml`, `rpc-peers.yaml`, `fleet.yaml` all materialize correctly (lines 118-128).
- **Multi-agent fleet supported.** System prompt's fleet heuristic (`app.tsx:239-261`) + `DeclaraFleetAdd` (refuses without pre-existing `fleet.yaml` → directs user to `declaragent init --fleet <name>` first, `fleet-add.ts:54-57`) + `DeclaraAddPeer` produce a multi-agent starter with `addAgentFromTemplate` copying from `templates/fleet-starter/`.
- **24 colocated unit tests** in `packages/cli/src/builder/` plus the end-to-end test. Total builder directory ≈ 9,400 LOC.

### Gaps and sharp edges 🟡

- **No live-LLM conversation fixture.** All e2e tests hand-construct proposals to simulate what the model emits; there's no recorded-conversation test proving a real model drives the full understand→propose→apply loop without derailing.
- **Deploy handoff is manual by design.** The builder writes `${env:VAR}` placeholders — operator must still populate `.env` and run `declaragent up` / `fleet run` themselves.
- **Env var is case-sensitive.** `DECLARAGENT_BUILDER=on` works; `ON` or `1` silently leaves the builder off. Will trip at least one user.
- **No documented onboarding tour** for the conversational flow — the capability is implicit in tool descriptions and the system prompt.

### Verdict

> **Yes — a user can converse with declaragent today to build a usable single-machine fleet.** The plumbing is real: 14 builder tools, git-backed rollback, scope + secret guards, 24 unit tests plus a deterministic fleet-e2e test. The rough edges are the live-LLM test gap (we trust the system prompt without automated regression protection) and the intentional manual hand-off at deploy. For enterprise — where "usable" means multi-host + SSO + audit export — the builder produces artifacts the single-machine runtime can boot; the same enterprise gaps listed under pillars 2–4 apply to whatever the builder generates.

---

## Cross-pillar enterprise gap list (ranked)

Order reflects leverage — what unblocks the most downstream value per engineer-week.

1. **Finish Kafka soak** — boot `declaragent fleet run` across hosts with real LLM handlers, 24h soak, alert on drift. (~1 week)
2. **Dispatch-DLQ active requeue** — needs a control socket on `up`. (~1 day once socket exists)
3. **NATS transport factory** — mirror `createKafkaTransport` pattern. Unblocks non-Kafka shops. (~3 days)
4. **OIDC/OAuth2 on RPC envelopes** — `RpcAuth` shape exists, provider implementations don't. (~1 week)
5. **Managed control plane** — aggregator over N `up` processes, HA, multi-tenant quotas visible. **Needs its own plan doc.** (~4 weeks)
6. **GitOps `fleet render`** — emit k8s manifests / helm from `fleet.yaml`. (~1 week)
7. **SIEM audit export** — push `audit_log` rows to Splunk/Elastic/Datadog via an adapter. (~1 week)
8. **Per-tool rate limit + auto-recovery for crashed MCP.** (~1 week combined)
9. **v1.1 Agent Graph typed capabilities** — codegen request/response contracts from `capabilities.yaml`. (~2 weeks)
10. **Recorded-conversation regression tests for the builder.** (~3 days)

Rough total for "enterprise production ✅ across all five pillars": **10–14 engineer-weeks** of *integration* work. No new architecture is required.

---

## Bottom line

- ✅ **Single-machine production across all 5 pillars.** A single host running `declaragent up -d` behind a webhook, with Claude + MCP + Slack + Kafka peers, with `/metrics` scraped + audit verified, is a real product today.
- 🟡 **Enterprise production is one release-cycle away**, not one rewrite away. The architecture is right; the remaining work is in integration surfaces (control plane, SSO, SIEM, GitOps, broker breadth).
- ✅ **The conversational builder works.** The "agent to build agents" claim is not aspirational — 14 builder tools, plan-confirm-execute, git rollback, fleet-e2e test all ship in `@declaragent/cli@0.6.0`.

If we're honest about what "production scale" means to the buyer, the pitch is:
> *"Declaragent runs your first fleet on one host, today. Your multi-host / SSO / SIEM / GitOps rollout is a focused integration project against a shipped runtime — not a platform bet."*

# CLAUDE.md

Project memory for Declaragent. Read this first when starting work here.

- **Name:** Declaragent (official).
- **Domain:** [declaragent.dev](https://declaragent.dev)
- **npm scope:** [`@declaragent/*`](https://www.npmjs.com/org/declaragent) — 13 packages on npm. CLI ships independently; latest published `@declaragent/cli@0.7.7` (`npm view @declaragent/cli dist-tags` → `latest: 0.7.7`, verified 2026-08-16; core@0.6.0, satellites@5.0.0 — peer-major on core 0.5→0.6).
- **GitHub org:** `declaragent`.
- **Theme:** *an agent for enterprises to build and manage fleets of agents.* Declaragent itself is an agent — same core, same tools, same audit — that helps operators author + run everyone else's agents.
- **Honest capability status:** see **[AGENTS.md](./AGENTS.md)** for the feature-level ledger. For the intent→code audit ("does the first-principles vision actually work at production scale?") see **[docs/FIRST_PRINCIPLES_AUDIT.md](./docs/FIRST_PRINCIPLES_AUDIT.md)** (exhaustive capability matrix) and **[docs/FIRST_PRINCIPLES_VALIDATION.md](./docs/FIRST_PRINCIPLES_VALIDATION.md)** (pillar-by-pillar yes/no verdict with ranked enterprise gap list). This file is a project-orientation guide, not a status dashboard.

## What this project is

Declaragent is a declarative, git-versioned AI agent platform. An agent = immutable runtime **core** + git-versioned declarative **configuration** (`agent.yaml`: identity, tools, skills, plugins, event sources, channels, permissions, secrets, deployment).

The reference implementation archive — the leaked Claude Code source — lives at `/Users/ssvk/Documents/GitHub/claude-code/` and is read-only. Treat it as a study/reference codebase, not a dependency.

## Canonical plan

`docs/SPEC_AND_PLAN.md` is the source of truth for requirements and phased implementation. It supersedes the 8 background design docs (also in `docs/`), which are kept for historical context only.

When the plan and a background doc disagree, `SPEC_AND_PLAN.md` wins.

## First-principles scoreboard

The enterprise pitch — "an agent to build and manage fleets of agents" — decomposes into **five** pillars, not four. The builder-as-agent is the differentiator and has its own row.

> ⚠️ **Accuracy note (2026-06, branch `agent-durability-followups`).** A multi-agent audit found the "✅ enterprise (5 of 5)" marks below **overstated** — several primitives were designed but not wired at runtime (bypass permission gates, memory-pinned cross-host respond, DLQ-requeue no-op, etc.). A production-readiness pass (see [`docs/PRODUCTION_READINESS_PLAN.md`](./docs/PRODUCTION_READINESS_PLAN.md) and the evidence ledger in [`AGENTS.md §0`](./AGENTS.md)) has since closed the security/reliability/observability/cost spine across all 11 workstreams (tested), but **enterprise readiness is still partial** — live-broker cross-host delegation, k8s deploy, real OTel export, multi-tenancy, and the soak proof remain. Trust the AGENTS.md ledger + the plan doc over the marks in this table until they're reconciled at release.

Current state (see `docs/FIRST_PRINCIPLES_VALIDATION.md` for evidence + ranked gap list):

| Pillar | Single-machine | Enterprise (multi-host, soak-proven, SSO/SIEM/GitOps) |
| --- | --- | --- |
| 1 · Define agents (capabilities, skills, inbound/outbound channels, peers) | ✅ | ✅ (v0.7.4) — typed capabilities shipped; per-agent auth registry (#18); SSO-bridged channel permissions remain a polish item, not a blocker |
| 2 · Deploy + monitor fleet (up/down/ps/logs + Prometheus + OTel + canary) | ✅ | ✅ (v0.7.4) — managed control plane Slices 1–3 shipped incl. cross-host fan-out (#50); GitOps render + SIEM export + back-pressure + adaptive batch all live; traffic-splitting canary remains roadmap |
| 3 · Independent agents with optional delegation (memory + broker RPC) | ✅ | 🟡 — `fleet run` wires **kafka + nats** from `rpc-peers.yaml` (JetStream via `kind: nats`); SQS/AMQP/MQTT ship as `@declaragent/plugin-agent-rpc` library factories only (declared kinds warn-skip at boot); per-agent `AuthVerifyRegistry` (#18); Kafka soak proof accumulating Sundays |
| 4 · Tools + MCP (7 built-ins, + SendMessage when channels are configured; MCP stdio via `mcp add`, HTTP/SSE via hand-edited config + plugins) | ✅ | ✅ (v0.7.5) — per-tool + per-MCP-server aggregate rate limits shipped (#27), graceful drain across respawn (#13), auto-recovery + supervised mode live; approval workflows remain roadmap |
| 5 · **Conversational builder → deployable fleet** (`DECLARAGENT_BUILDER=on`) | ✅ | ✅ (v0.7.1) — recorded-conversation regression fixtures shipped via PR #24; fixture polish #36/#37/#38 all landed at 0.7.6 |

**Single-machine production: ✅** ready — `@declaragent/cli@0.7.7` on npm. A single host runs `declaragent up -d`, webhook/cron in, Claude + MCP tools + Slack/Telegram/Discord/WhatsApp in/out, `/metrics` + circuit breakers + per-tool + provider rate limits + dispatch DLQ on by default (OTel span export is opt-in: env var + installed `@opentelemetry/*` packages). Conversational builder (`DECLARAGENT_BUILDER=on`) produces deployable single-agent and multi-agent fleets end-to-end.

**Enterprise production: ⚠️ partial** (see the accuracy note above — the AGENTS.md evidence ledger is authoritative). All 12 items on `docs/ENTERPRISE_PRODUCTION_PLAN.md` shipped during the 0.7.0 → 0.7.1 push; the follow-up backlog has closed **34 of 52 items** across 0.7.1 → 0.7.5. See **[docs/POST_ENTERPRISE_BACKLOG.md](./docs/POST_ENTERPRISE_BACKLOG.md)** for the 18 remaining follow-ups. Top open work:
1. **#5b `rpc.auth.enabled: true` default flip** — behavioural change deferred to **0.8.0**; see [`docs/ZERO_TRUST_DEFAULT_MIGRATION.md`](./docs/ZERO_TRUST_DEFAULT_MIGRATION.md) for the migration plan.
2. ~~#51 Grafana dashboard bundle~~ — shipped: `docs/grafana/declaragent-fleet-dashboard.json` (+ README + tests).
3. **Builder polish** — #36 (`tool_result` blocks), #37 (cache-token cost regression fixture), and #38 (`swapInnerProvider` on RecordingProviderHandle) all landed at 0.7.6.
4. **#50 Slice 6b** — `fleet dlq drop/requeue` cross-host mutations: shipped in the working tree (`--host` / `--all-hosts --yes`).

See `docs/FIRST_PRINCIPLES_AUDIT.md` §"Cross-pillar: what's honestly missing" for the evidence ledger.

## Upcoming breaking changes

- **0.8.0 · zero-trust default flip.** `rpc.auth.enabled` will default to `true` when `rpc-peers.yaml` is present on a fleet. Fleets without an `auth:` block on every peer-using agent will fail boot with `AUTH_REJECTED`. Migration inspector shipped at 0.7.3 (`declaragent fleet audit-rpc --suggest-enable [--strict]`). Full plan: **[docs/ZERO_TRUST_DEFAULT_MIGRATION.md](./docs/ZERO_TRUST_DEFAULT_MIGRATION.md)**. Recommended pre-flight: 2–3 weeks of `--strict` runs in CI before taking 0.8.0. **Release plan for the full four-flip cutover (rpc.auth + allowLoopback + strict schema + tools default): [docs/RELEASE_0_8_0_PLAN.md](./docs/RELEASE_0_8_0_PLAN.md)** — blockers, CI-window mechanics, rolling-upgrade rehearsal, and the go/no-go checklist.

---

## Current status (verified 2026-08-16, @declaragent/cli@0.7.7 live on npm)

**What works end-to-end** (production-usable single-machine + multi-host path):
- `declaragent init` → scaffold with `agent.yaml` + skills + `event-sources.yaml`
- `declaragent auth login` → OpenRouter / Anthropic / env-var credentials
- `declaragent up [-d]` → binds sources (webhook/cron/file-watch + any installed `@declaragent/source-*`), routes events to skills, LLM turn runs, outcome recorded. Runtime threads shared `PrometheusRegistry` + optional OTel tracer, wraps provider with token-bucket rate limiter, applies per-skill circuit breakers, routes tool calls through per-tool rate-limit gate with `TenantAuditSink` recording (`rate_limited` audit events), and supervises MCP servers with auto-restart + circuit counter.
- `declaragent ps / logs / down` → lifecycle verbs; `logs` prefixes each line with its agent id (the 50-watcher fan-out cap with 413 over-cap applies to the control-plane `/logs` route, not the local verb).
- `declaragent events list / audit verify / dlq list` → observability backed by SQLite with hash-chained audit; dispatch-DLQ active requeue via control socket (#3); `events list --state circuit-open` + `dlq drop --kind dispatch` shipped.
- `declaragent fleet audit-rpc [--suggest-enable] [--strict] [--json]` → pre-flight inspector for `rpc.auth.enabled` gaps; outputs copy-pasteable YAML diffs pre-filled with each peer's declared provider. See [`docs/ZERO_TRUST_DEFAULT_MIGRATION.md`](./docs/ZERO_TRUST_DEFAULT_MIGRATION.md).
- `declaragent fleet render --target k8s|helm [--format helm|kustomize]` → GitOps manifests; optional `--no-servicemonitor` / split ServiceMonitor files.
- `declaragent fleet run` → multi-agent runtime over `memory` (single-process), `kafka`, and `nats` transports (JetStream registers via `kind: nats`; SQS/AMQP/MQTT are library factories not yet constructible from fleet config); per-agent `AuthVerifyRegistry` from `<agent>/rpc-peers.yaml`.
- `declaragent fleet ps / events / dlq / logs [--host <name>] [--json]` → Slice 3 cross-host fan-out via `fleet.yaml#hosts[]` + `CrossHostControlPlaneClient`; one bad host tagged, survivors returned.
- `declaragent deploy gcp-cloud-run` → generates Dockerfile + service.yaml (user runs `gcloud` themselves).
- `declaragent fleet deploy --canary --canary-wait-ms <n>` → canary strategy with post-soak re-probe.
- SIEM audit export (Splunk / Elastic / Datadog) with **back-pressure** (#11) + **adaptive batch interval** (#12) + cursor held across restarts.
- Builder toolkit (`DECLARAGENT_BUILDER=on`): conversational authoring for skills, sources, channels, MCP, plugins, secrets, peers, fleet-add; **recorded-conversation regression fixtures** (PR #24) replayed on every CI run.

**0.7.1 → 0.7.4 cumulative ship manifest (31 of 52 post-enterprise backlog items):**
- **Security** (#5a, #6, #7, #8, #9): fleet audit-rpc inspector; per-route scope overrides on control-plane routes; `allowLoopback` + reverse-proxy / X-Forwarded-For semantics; `AUTH_REJECTED` promoted to `RPC_ERROR_CODES` constant; capability schema-violation audit cardinality decided.
- **Topology** (#18, #19, #20, #21, #22): per-agent `AuthVerifyRegistry`; `/events` + `/dlq` + `/logs` multi-agent fan-out with scope-gated `?all=1`; `/logs` fan-out cap (default 50) with 413 + coalescing; streaming `idleTimeout: 0` narrowed to `/logs` only; in-process log-rotation signal.
- **Transports** (#23, #24, #25, #26): JetStream + SQS + AMQP + MQTT RPC transport factories; NATS per-topic queue groups; literal `fleet run` subprocess spawn for Kafka soak harness.
- **Robustness** (#11, #12, #14, #16, #52): SIEM back-pressure + adaptive batch; MCP `mcp_server_circuit_open_total` counter; `TenantAuditSink` threaded into `up`; SIEM loop + `/audit` route share one singleton SQLite sink.
- **MCP** (#28, #29, #30): `burst = 2×rps` default; `>=` boundary comparator fix; supervised-recipe doc.
- **Platform** (#31, #40, #47, #50): GitOps ServiceMonitor file-split + `regen-snapshots`; ref-counted `acquireTenantAuditSink` owner API; prod-smoke Kafka scaffold fix; **Slice 3 cross-host fan-out** for all four observability verbs.
- **Architectural** (#41, #42, #43, #44, #45, #48, #49): `ChannelMessageContent` rename; `control-socket-client.ts` shared helper; memoized `loadAgent` in fleet-run; `cliVersion` on `UpState`; per-agent `hostedBy.pid` fidelity; pre-push hook for CLI-surface docs + `docs-site/sidebars.ts` Biome drift.

**See [AGENTS.md](./AGENTS.md)** for the full evidence-backed matrix with file:line references. If you're about to promise a user a capability, verify against AGENTS.md first.

**Next priorities after 0.7.5 ships** (ordered by leverage, per `docs/POST_ENTERPRISE_BACKLOG.md`):
1. **#5b zero-trust default flip** at 0.8.0 — migration plan [`docs/ZERO_TRUST_DEFAULT_MIGRATION.md`](./docs/ZERO_TRUST_DEFAULT_MIGRATION.md); pre-flight inspector `declaragent fleet audit-rpc --suggest-enable --strict` already shipped at 0.7.3.
2. ~~#51 Grafana dashboard~~ — shipped at `docs/grafana/declaragent-fleet-dashboard.json` (importable JSON aggregating the MCP/audit/rate-limit counters).
3. **#50 Slice 6b** — shipped in the working tree: `fleet dlq drop/requeue` cross-host mutations (`--host` / `--all-hosts --yes`).
4. **Builder fixture polish** — #36/#37/#38 all landed at 0.7.6 (`swapInnerProvider` in `recording-provider.ts`).
5. **Soak evidence accrual** — Pillar 3's Kafka 24h soak needs 7+ consecutive Sunday greens; tracked externally to repo.

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

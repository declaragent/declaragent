# Post-Enterprise Backlog

**Authored:** 2026-04-23 · **Source:** 52 follow-ups surfaced during the 6-round Enterprise Production Plan push (`docs/ENTERPRISE_PRODUCTION_PLAN.md` — all 12 items shipped).

This doc is the honest 0.7.x+ backlog. Every entry was flagged by a shipped PR's "Open questions" / "Follow-ups" section or by a legitimate scope-out. Grouped by priority + category so the next release can be cut against a short pre-flight list instead of spelunking through PR descriptions.

---

## 0 · Summary banner

```
Status:               31 open follow-ups from the enterprise push (21 shipped across 0.7.1 + 0.7.2)
Shipping-gate count:  4 (must land before 0.7.0 cut)
Security count:       6 (address within 0.7.x)
Robustness count:     7 (enterprise-nice-to-have)
Topology count:       5 (correctness under specific deploys)
Transport count:      4 (broker breadth)
MCP ergonomics:       4
GitOps polish:        3
Builder testing:      5
Architectural:        5 (#41, #42 shipped → 0.7.1)
CI infra:             4
Platform maturity:    3
```

Update this banner when items tick through.

---

## 1 · Status board

Tick checkboxes as work lands. Group ordering = priority. Within a group, ordering is free.

| # | Item | Group | Est. | Status | PR / Evidence |
| - | --- | --- | :-: | --- | --- |
| 1 | [ ] Flip Pillar 3 enterprise badge in `CLAUDE.md` + `FIRST_PRINCIPLES_VALIDATION.md` after first green `weekly-soak.yml` | Ship-gate | 5 min | Pending weekly run | PR #10 acceptance #4 |
| 2 | [ ] Cut `@declaragent/cli@0.7.0` release with full enterprise stack + peer-dep cascade | Ship-gate | 1 d | Not started | — |
| 3 | [ ] Flip website `/principles` 🟡 → ✅; replace "10–14 engineer-weeks" with "shipped" | Ship-gate | 30 min | Not started | — |
| 4 | [ ] Regenerate `docs/FIRST_PRINCIPLES_AUDIT.md` + `FIRST_PRINCIPLES_VALIDATION.md` capability matrix | Ship-gate | 2 h | Not started | — |
| 5 | [ ] `rpc.auth.enabled: true` default flip + `declaragent fleet audit-rpc --suggest-enable` pre-flight inspector | Security | 1 wk | Not started | PR #25 open Q1 |
| 6 | [x] Per-route scope overrides on `/audit` + `/events` + `/logs` + `/status` + `/metrics` | Security | 3 d | Shipped — branch `agent-a/security-sprint-2-items-6-7` | `controlPlane.auth.routeScopes: Record<path, string[]>` in `packages/core/src/agents/load-agent.ts`; enforced by `applyControlPlaneAuth` in `packages/core/src/observability/control-plane-auth.ts` with new `ControlPlaneAuthContext.routePath`; one test per route in `control-plane-auth.test.ts` |
| 7 | [x] `allowLoopback` + reverse-proxy semantics (X-Forwarded-For / proxy-IP-as-loopback) | Security | 2 d | Shipped — branch `agent-a/security-sprint-2-items-6-7` | `allowLoopback: boolean \| { trustedProxies: string[] }` in `load-agent.ts`; `resolveEffectivePeer()` in `control-plane-auth.ts` rejects XFF from untrusted peers with new `untrusted-proxy` reason; `control-plane-server.ts` threads `peerIp` via `Bun.serve`'s `server.requestIP(req)` |
| 8 | [x] Add `AUTH_REJECTED` to `RPC_ERROR_CODES` constant (today string literal) | Security | 30 min | Shipped — branch `agent-a/security-sprint-1-items-8-9` | `packages/core/src/rpc/errors.ts` + `errors.test.ts`; `fleet-run.ts` literals swapped for `RPC_ERROR_CODES.AUTH_REJECTED` (wire value preserved) |
| 9 | [x] Audit cardinality for `capability.schema_violation` — per-envelope vs per-violation | Security | 1 d | Shipped — decision: batched per envelope (pinned) | `packages/plugin-agent-rpc/src/request-agent.ts` JSDoc + multi-violation regression test in `request-agent.test.ts`; inline `POST_ENTERPRISE_BACKLOG.md #9` notes in `audit/types.ts` + `fleet-run.test.ts` |
| 10 | [ ] Schema-version policy: hard-fail vs soft-warn on breaking capability schema bumps | Security | 3 d | Not started | PR #23 open Q1 |
| 11 | [ ] SIEM back-pressure policy (pause writes after `>1h` backlog?) | Robustness | 3 d | Not started | PR #22 open Q1 |
| 12 | [ ] SIEM adaptive batch interval for high-volume fleets (10k tool-calls/sec) | Robustness | 3 d | Not started | PR #22 open Q2 |
| 13 | [ ] MCP graceful draining of in-flight tool calls across respawn | Robustness | 1 wk | Not started | PR #21 scope-out |
| 14 | [x] MCP dedicated `mcp_server_circuit_open_total` counter for alertmanager simplicity | Robustness | 1 d | Shipped (0.7.1) | `agent-c/robustness-sprint-1-warmups` — `packages/core/src/mcp/supervisor.ts` |
| 15 | [ ] `/audit` tail-segment-only hash-chain verification when soak-size evidence justifies it | Robustness | 3 d | Deferred (need soak numbers) | PR #15 open Q1 |
| 16 | [x] Wire `TenantAuditSink` into `up-cli`'s engine path (round-5 shipped fleet-run side only) | Robustness | 1 d | Shipped (0.7.2) | `agent-c/robustness-sprint-2-items-16-22-52` — `packages/cli/src/up-cli.ts` threads `DEFAULT_TENANT_CONTEXT` into `createEngine` so single-process deployments key `rate_limited` audit records on the same `tenantId` fleet-run uses |
| 17 | [ ] `fleet.yaml`-level `controlPlane:` block (today: process-wide listener reads per-agent; picks first + warns) | Robustness | 3 d | Not started | PR #27 open Q3 |
| 18 | [ ] Fleet-side per-agent auth registry (today collapses if an agent needs a different peer set than fleet root) | Topology | 1 wk | Not started | PR #28 open Q1 |
| 19 | [ ] `/events` + `/dlq` multi-agent fan-out via `?all=1` once Slice 2 auth lands | Topology | 2 d | Not started | PR #15 open Q1 |
| 20 | [ ] `/logs` multi-agent fan-out guard via `?all=1` (today opens N watchers at N=50 agents) | Topology | 2 d | Not started | PR #19 open Q1 |
| 21 | [ ] Narrow `idleTimeout: 0` to `/logs` only once Slice 2 adds remote bind | Topology | 1 d | Not started | PR #19 open Q4 |
| 22 | [x] In-process log-rotation signal for `openAgentLog` (external rotation already handled via inode) | Topology | 2 d | Shipped (0.7.2) | `agent-c/robustness-sprint-2-items-16-22-52` — `openAgentLog().rotate()` closes the active stream, renames to `<agentId>-<ISO>.log`, opens a fresh append-mode stream; concurrent writes buffered + drained, no drops; 5 new tests in `up-lifecycle.test.ts` |
| 23 | [x] `createJetStreamTransport` for at-least-once RPC with replay | Transport | 1 wk | Shipped (0.7.2) | `agent-b/transport-sprint-2-item-23` — `packages/plugin-agent-rpc/src/jetstream-transport.ts` + 16-case unit suite + `packages/testkit/src/fleet-integration/jetstream-rpc.test.ts` (FLEET_INTEGRATION=1 + NATS_INTEGRATION=1) |
| 24 | [ ] SQS / AMQP / MQTT RPC transport factories (same pattern as Kafka + NATS) | Transport | 2 wk | Not started | PR #13 scope-out |
| 25 | [x] NATS per-topic queue-group semantics (today one at construction-time) | Transport | 2 d | Shipped (0.7.1) | agent-b/transport-sprint-1-items-25-26 — `createNatsTransport` accepts `queueGroups: string \| Record<topic, group>`; legacy `queueGroup` stays as fallback |
| 26 | [x] Kafka soak harness: literal `declaragent fleet run` subprocess spawn (today worker replicates broker loop) | Transport | 2 d | Shipped (0.7.1) | agent-b/transport-sprint-1-items-25-26 — subprocess now boots via `loadFleet` + real `fleet.yaml`/`capabilities.yaml` scaffolded per run; gap documented on the `startFleetDaemon` memory-hardwired respond path |
| 27 | [ ] Per-MCP-server aggregate rate-limit cap (`mcp.rateLimit` block) | MCP | 2 d | Not started | PR #18 open Q1 |
| 28 | [x] `burst = rps` default revisit (classic token-bucket wisdom is `2×rps`) | MCP | 30 min | Shipped (0.7.1) | `agent-c/robustness-sprint-1-warmups` — `packages/core/src/tools/rate-limit-gate.ts` |
| 29 | [x] Audit-threshold comparator: strict `>` 1s boundary → `>=` (today `rps=1` sits silently on the line) | MCP | 30 min | Shipped (0.7.1) | `agent-c/robustness-sprint-1-warmups` — `packages/core/src/tools/rate-limit-gate.ts` |
| 30 | [x] Document `mcp.supervised: [other-healthy-server]` recipe for flaky-one-server debugging | MCP | 1 h | Shipped (0.7.1) | `agent-c/robustness-sprint-1-warmups` — `docs-site/docs/reference/agent-yaml.mdx` |
| 31 | [ ] Split ServiceMonitor into optional separate file in GitOps render | GitOps | 1 d | Not started | PR #20 open Q1 |
| 32 | [ ] Fan channel/source/plugin configs into dedicated ConfigMaps + `envFrom` mounts | GitOps | 3 d | Not started | PR #20 open Q2 |
| 33 | [ ] Kustomize render target (Helm covers the common case today) | GitOps | 3 d | Not started | PR #20 scope-out |
| 34 | [ ] Builder fixture-divergence policy when system prompt changes — re-author vs re-record | Builder | 2 h | Product call | PR #24 open Q1 |
| 35 | [ ] Multi-turn builder fixture granularity (today: one user turn + N assistant responses) | Builder | 3 d | Defer until real recording produces one | PR #24 open Q3 |
| 36 | [ ] Capture `tool_result` blocks in `BUILDER_RECORD` JSONL if future providers stream them | Builder | 2 d | Not started | PR #29 open Q1 |
| 37 | [ ] Extend `FixtureEntry` usage fields (cache tokens + per-block timestamps) for cost-regression coverage | Builder | 2 d | Not started | PR #29 open Q2 |
| 38 | [ ] Longer-lived `RecordingProviderHandle` with swappable inner provider ref (today re-wraps on mode/model rebuild) | Builder | 1 d | Not started | PR #29 open Q3 |
| 39 | [ ] Proper `createAgentInboxAdapter` construction in `up` and `fleet-run` (today: inline verify-auth as pragmatic equivalent) | Architectural | 1 wk | Deferred | PR #28 arch finding |
| 40 | [ ] Unify `TenantAuditSink` handle management between `up` and `fleet run` (today each opens its own) | Architectural | 3 d | Not started | PR #28 scope-out |
| 41 | [x] Resolve `MessageContent` name collision at `@declaragent/core` export surface (LLM vs channels type) | Architectural | 1 d | Shipped (0.7.1) | agent-d/architectural-sprint-1-items-41-42 · channels type renamed to `ChannelMessageContent`; all channel packages + testkit + SendMessage tool updated |
| 42 | [x] Extract `packages/cli/src/control-socket-client.ts` shared helper (before a 3rd caller lands) | Architectural | 1 d | Shipped (0.7.1) | agent-d/architectural-sprint-1-items-41-42 · `withControlSocketClient` / `tryFetchControlSocketStatus` / `unwrapOpResult`; `ps-cli` + `dlq-dispatch-cli` refactored; +6 focused tests |
| 43 | [x] Memoize `loadAgent` calls in fleet-run (today: probe + handler factory both load) | Architectural | 30 min | Shipped — branch `agent-d/platform-sprint-2-items-43-44-45-48-49` | `packages/cli/src/fleet-run.ts` → `createMemoizedLoadAgent` + `loadAgentFn` threaded into `createLLMHandlerFactory`; failed loads stay cached so the probe does not re-read a known-bad disk path |
| 44 | [x] Thread `cliVersion` through `UpState` at write time (today: env-var per-scrape) | Architectural | 1 h | Shipped — branch `agent-d/platform-sprint-2-items-43-44-45-48-49` | `UpState.cliVersion?: string` (optional for pre-0.7.2 state files) written at boot from `CLI_VERSION`; `buildUpStatusSnapshot` reads state first, env-var is fallback override |
| 45 | [x] `status.agents[].pid` per-agent fidelity (today: all agents in one process report same pid) | Architectural | 2 d | Shipped — branch `agent-d/platform-sprint-2-items-43-44-45-48-49` | Field shape: `UpAgentStatus.hostedBy?: { pid: number; index: number }`; today `hostedBy.pid === snapshot.pid` (single-process host), `index` is the 0..n-1 slot. Future out-of-process topology can populate distinct pids without a schema break |
| 46 | [ ] Native `bun pm audit` via third-party scanner (Snyk) when Bun's feature stabilizes | CI | 1 d | Defer to upstream | PR #16 follow-up |
| 47 | [ ] Fix `prod smoke — kafka source end-to-end` pre-existing failure on push-to-main | CI | 2 d | Not started | Round-4 discovery |
| 48 | [x] Pre-push hook / CI autofix for `bun run scripts/docs-cli-extract.ts` on CLI-surface PRs | CI | 1 h | Shipped — branch `agent-d/platform-sprint-2-items-43-44-45-48-49` | `.githooks/pre-push` runs the extractor when `packages/cli/src/index.tsx` is in the push range; CI `ci.yml` has a "Drift guard — docs-cli-extract (#48)" step as safety net. `bun run hooks:install` wires `core.hooksPath` |
| 49 | [x] Pre-push hook for Biome formatting on `docs-site/sidebars.ts` (recurring drift) | CI | 30 min | Shipped — branch `agent-d/platform-sprint-2-items-43-44-45-48-49` | Extended the same `.githooks/pre-push` + mirrored as CI drift-guard step. Hook runs `biome format --write docs-site/sidebars.ts` and aborts the push on drift |
| 50 | [ ] Slice 3 of `CONTROL_PLANE_PLAN.md` — CLI fan-out across hosts (`declaragent fleet ps` calls each host's `/status`) | Platform | 2 wk | Not started | PR #19 follow-up |
| 51 | [ ] Ready-made Grafana dashboard aggregating `mcp_server_restarts_total`, `mcp_server_circuit_state`, `audit_export_queue_depth`, `rate_limit_waits_total` | Platform | 3 d | Not started | 0.7.x polish |
| 52 | [x] Dedupe SIEM loop + `/audit` route to one shared `createSqliteAuditSink` handle | Platform | 1 d | Shipped (0.7.2) | `agent-c/robustness-sprint-2-items-16-22-52` — new `packages/cli/src/audit-sink-singleton.ts` memoises sink handles by absolute path; `up-cli` routes all callers (rate-limit gate, `/audit` route, SIEM export loop) through the singleton; 6 new tests cover concurrent opens, release idempotency, post-release reopen |

**Status vocabulary:** *Not started · In-progress · Deferred (reason) · Blocked (cite blocker) · Shipped (link PR + version)*

---

## 2 · Group-level notes

### Ship-gate (§1 rows 1–4)
All four close out the 0.6.0 → 0.7.0 cut. #1 is timing-gated (Sunday cron). The other three are small operator actions, not engineering work.

### Security (§1 rows 5–10)
Prioritize #5, #6, #7 — those three are the difference between "opt-in trust-the-network" and "zero-trust enterprise deploy." #10 (schema version policy) needs a product call before eng.

### Topology (§1 rows 18–22)
Mostly same shape: "today works for N=1 or bind=127.0.0.1; enterprise needs N=many or remote bind." These land together when the first customer asks.

### Architectural (§1 rows 39–45)
#39 (`agent-inbox` adapter) is the biggest — it's the one the round-6 PR #28 description called out as a half-day+ refactor. Worth doing once there's a second consumer that benefits (e.g. a non-fleet-run transport mode).

### Builder testing (§1 rows 34–38)
All five are polish on `#12`'s regression suite. Can be picked up as-needed when a system-prompt change makes a fixture obsolete.

---

## 3 · How to use this doc

1. **Pre-release:** before every minor cut, walk rows 1–10 (ship-gate + security). Must either ship or have a dated deferral.
2. **Sprint planning:** pull the next 3–5 items into active work via the main `ENTERPRISE_PRODUCTION_PLAN.md`-style tracking (or equivalent). Mark here as "In-progress."
3. **New follow-up surfaces during a PR?** Append a row; don't open a separate ticket until it's claimed for active work.
4. **Scope disagreement?** Edit the row here before writing code. The backlog is the source of truth.

---

## 4 · Cross-references

- [`ENTERPRISE_PRODUCTION_PLAN.md`](./ENTERPRISE_PRODUCTION_PLAN.md) — the shipped program these follow-ups came out of.
- [`FIRST_PRINCIPLES_VALIDATION.md`](./FIRST_PRINCIPLES_VALIDATION.md) — pillar-level verdict; flips after ship-gate #1.
- [`CONTROL_PLANE_PLAN.md`](./CONTROL_PLANE_PLAN.md) — Slice 3 (platform row #50) lives here.
- [`POST_DEMO_BACKLOG.md`](./POST_DEMO_BACKLOG.md) — older backlog; cross-check before re-filing.

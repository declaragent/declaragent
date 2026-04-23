# Enterprise Production Plan

**Authored:** 2026-04-22 · **Target:** Enterprise ✅ across all 5 pillars of [FIRST_PRINCIPLES_VALIDATION.md](./FIRST_PRINCIPLES_VALIDATION.md) · **Total estimate:** 10–14 engineer-weeks serial, 6–8 weeks calendar with 2 engineers in parallel.

This is the **tracking doc**. Keep the status board (§1) accurate. Detailed specs live in §3, sequencing in §2. When an item completes, tick its checkbox, fill in the Evidence column, and update the summary banner below.

---

## 0 · Summary banner

```
Enterprise pillars status:  ▓▓▓▓▓▓▓▓▓▓▓▓  ( 12 / 12 items complete ✅ — all five pillars shipped; all CLI integrations live in `up` + `fleet run` )
Latest release:             @declaragent/cli@0.6.0 (all 12 plan items + #5 Slice 2 + #4/#7/#8/#11 CLI integrations + #12 BUILDER_RECORD all merged 2026-04-23; unreleased)
Next milestone:             Pillar 3 enterprise badge flip after first green `weekly-soak.yml` run (scheduled Sunday 00:00 UTC per #1 acceptance #4); release @declaragent/cli@0.7.0 with the enterprise stack
Active blocker:             none
```

Update this banner whenever an item ships.

---

## 1 · Status board

Tick checkboxes as work lands. One line per item. If the scope changes, **edit the matching §3 spec first**, then reflect the new estimate here.

| # | Item | Milestone | Est. | Status | Owner | PR / Evidence |
| - | --- | --- | :-: | --- | --- | --- |
| 1 | [x] Finish Kafka soak — cross-host `fleet run` + 24h drift alarm | M1 | 1 wk | Shipped | Eng-A | [PR #10](https://github.com/declaragent/declaragent/pull/10) · `20c6e35` — pillar flip pending first green weekly run |
| 2 | [x] NATS RPC transport factory | M1 | 3 d | Shipped | Eng-A | [PR #13](https://github.com/declaragent/declaragent/pull/13) · `e233ac6` |
| 3 | [x] Dispatch-DLQ active requeue | M1 | 1 d | Shipped | Eng-B | [PR #14](https://github.com/declaragent/declaragent/pull/14) · `757b71d` |
| 4 | [x] OIDC / OAuth2 on RPC envelopes | M2 | 1 wk | Shipped | Eng-A | [PR #17](https://github.com/declaragent/declaragent/pull/17) · `71b752e` — follow-ups: wire `clientSecretRef` resolver + `AuthVerifyRegistry` factory into `up` boot |
| 5 | [x] Managed control plane (aggregator over N `up`) | M4 | 4 wk | Shipped (Slice 1 full + Slice 2 auth) | Eng-C / Eng-A | [PR #12](https://github.com/declaragent/declaragent/pull/12) · `3cafaaa` (1a) · [PR #15](https://github.com/declaragent/declaragent/pull/15) · `af684cf` (1b) · [PR #19](https://github.com/declaragent/declaragent/pull/19) · `06dc6e3` (1c /logs SSE) · [PR #27](https://github.com/declaragent/declaragent/pull/27) · `e5319c4` (Slice 2 auth middleware). Follow-up: per-route scope overrides; fleet-level `controlPlane:` block |
| 6 | [x] Control socket on `up` daemon | M5 | 2 d | Shipped | Eng-B | [PR #11](https://github.com/declaragent/declaragent/pull/11) · `d53baed` — `reload` op still stubbed as `unsupported` |
| 7 | [x] Per-tool rate limit | M5 | 3 d | Shipped | Eng-B | [PR #18](https://github.com/declaragent/declaragent/pull/18) · `10da017` — follow-up: wire `TenantAuditSink` into `up-cli` so `rate_limited` records land |
| 8 | [x] Auto-recovery for crashed MCP servers | M5 | 4 d | Shipped | Eng-B | [PR #21](https://github.com/declaragent/declaragent/pull/21) · `1a120f8` — follow-up: wire supervisor into `packages/cli/src/mcp-runtime.ts` + product decision on default-supervised vs opt-in |
| 9 | [x] GitOps `fleet render` — k8s manifests + Helm | M3 | 1 wk | Shipped | Eng-A | [PR #20](https://github.com/declaragent/declaragent/pull/20) · `98c120a` — `--no-servicemonitor` for non-Prometheus-Operator clusters; follow-up: optional ServiceMonitor file split + channel/source/plugin ConfigMap fan-out |
| 10 | [x] SIEM audit export — Splunk / Elastic / Datadog adapter | M3 | 1 wk | Shipped | Eng-C | [PR #22](https://github.com/declaragent/declaragent/pull/22) · `b8f6f94` — cursor-held across restarts; follow-up: back-pressure policy, adaptive batch interval, shared audit sink |
| 11 | [x] v1.1 Agent Graph typed capabilities | M6 | 2 wk | Shipped | Eng-A | [PR #23](https://github.com/declaragent/declaragent/pull/23) · `4115fb1` — hand-rolled draft-07 validator + deterministic codegen + typed fleet-starter concierge→reviewer; follow-up: wire `peerCapabilities` + shared `CapabilityValidatorRegistry` into `up`/`fleet-run` |
| 12 | [x] Recorded-conversation regression tests for the builder | M6 | 3 d | Shipped | Eng-B | [PR #24](https://github.com/declaragent/declaragent/pull/24) · `2aba945` — 5 canonical fixtures + replay harness + PR-template gate; stretch `BUILDER_RECORD=1` deferred |

**Status vocabulary:** *Not started · In-progress · Review · Blocked (cite blocker) · Shipped (link PR + version)*.

**Ownership rule:** if an item has no owner, it's pickable. The first engineer in each sprint claims their items here before starting. No silent forks.

---

## 2 · Milestone sequencing

Six milestones. M1–M3 + M5 + M6 are mostly parallelizable; M4 (control plane) has its own multi-slice plan and runs in the background.

```
Week:            1    2    3    4    5    6    7    8
                 │    │    │    │    │    │    │    │
Eng-A (broker):  [ M1.1 Kafka soak─][ M1.2 NATS ]
Eng-A (auth):                         [ M2.1 OIDC/OAuth2─]
Eng-A (gitops):                              [ M3.1 render ][ M3.2 SIEM ]
                 │    │    │    │    │    │    │    │
Eng-B (runtime): [ M5.1 socket ][ M1.3 DLQ requeue ]
Eng-B (hard.):               [ M5.2 rate limit ][ M5.3 MCP recov ]
Eng-B (quality):                                  [ M6.1 builder tests ]
Eng-B (typed):                                       [ M6.2 Agent Graph v1.1 ─────]
                 │    │    │    │    │    │    │    │
Eng-C (cplane):  [ M4 · control plane — see CONTROL_PLANE_PLAN.md ─────────────────]
```

**Critical-path items** (slip these and the whole program slips):
1. **#6 Control socket** — blocks #3 (dispatch-DLQ requeue) and makes #5 (control plane) much cleaner.
2. **#1 Kafka soak** — single largest credibility hit if unmoved, because "cross-host fleets work" is a headline claim.
3. **#4 OIDC/OAuth2** — blocks every buyer with an enterprise IdP.

**Independent streams** (start any time, run in parallel):
- #2 NATS · #9 GitOps render · #10 SIEM export · #7 per-tool rate limit · #12 builder regression tests.

---

## 3 · Per-item specifications

Each item has: **Why · Scope (in / out) · Acceptance criteria · Test plan · Files touched · Dependencies · Estimate risk.** If a spec stays empty after work starts, that's a sign to clarify before coding.

---

### #1 · Finish Kafka soak

**Milestone:** M1 · **Estimate:** 5 working days · **Risk:** medium — flake sensitivity on Kafka integration, not code complexity.

**Why.** CLAUDE.md + FIRST_PRINCIPLES_VALIDATION both cite "Kafka transport shipped 0.6.0, soak pending" as the single largest enterprise credibility gap. `createKafkaTransport` is tested in `packages/testkit/src/fleet-integration/kafka-rpc.test.ts` but explicitly excludes "full `declaragent fleet run` boot with real LLM handlers" (`kafka-rpc.test.ts:17-20`). Until a real fleet holds up for 24h across hosts, the pillar-3 enterprise column stays 🟡.

**Scope in:**
- A new integration harness that boots two `declaragent fleet run` processes against a shared Redpanda, with mocked LLM handlers (deterministic Claude stub).
- 24-hour soak fixture: 1 req/s mixed traffic (inter-agent RPC + channel sends + cron ticks), drift-alarm if p99 latency > 2× baseline or dropped envelope count > 0.
- Promote the existing `nightly-integration.yml` workflow to gate on 7 consecutive green runs before the next minor is allowed to publish (release-gate rule).

**Scope out:**
- Production provisioning of Redpanda / MSK. Customer responsibility; we document the config.
- Load testing beyond 1 req/s — that's a separate perf workstream.

**Acceptance.**
1. `bun test --preload fleet-integration` passes across **two** processes talking over Redpanda (not just one process round-tripping).
2. A new `packages/testkit/src/fleet-integration/kafka-soak.test.ts` runs ≥ 24h in CI weekly with zero dropped envelopes and p99 ≤ 3s RTT.
3. `.github/workflows/release-gate.yml` requires the last 7 `nightly-integration.yml` runs to be green before allowing a minor release.
4. CLAUDE.md + FIRST_PRINCIPLES_VALIDATION both flip Pillar 3 enterprise from 🟡 to ✅ with the soak as cited evidence.

**Test plan.**
- Unit: none (transport already unit-tested).
- Integration: a new multi-process harness that uses the existing Redpanda `docker compose` fixture.
- Long-soak: `.github/workflows/weekly-soak.yml` (new).

**Files touched.**
- `packages/testkit/src/fleet-integration/kafka-soak.test.ts` (new).
- `packages/testkit/src/fleet-integration/harness/multi-process.ts` (new — shared fixture).
- `.github/workflows/weekly-soak.yml` (new).
- `.github/workflows/release-gate.yml` (add "7 green nightlies" check).

**Dependencies.** None — can start immediately.

---

### #2 · NATS RPC transport factory

**Milestone:** M1 · **Estimate:** 3 working days · **Risk:** low — pattern already established by `createKafkaTransport`.

**Why.** Multiple prospects use NATS, not Kafka. The `packages/source-nats` adapter exists but there's no `createNatsTransport` — so inter-agent RPC has no NATS option today. Without it, the "bring your own broker" story is hollow.

**Scope in:**
- `packages/plugin-agent-rpc/src/nats-transport.ts` — mirrors `kafka-transport.ts:81-220` structure.
- Dynamic `nats` import (peer dep, don't hard-depend).
- Integration test at `packages/testkit/src/fleet-integration/nats-rpc.test.ts` against `nats:latest` in docker-compose.
- Docs page: `docs-site/docs/reference/rpc.mdx` — add NATS to the transport table.

**Scope out:**
- SQS / AMQP / MQTT transports. Same pattern; done after NATS proves the template. Track as follow-ups in POST_DEMO_BACKLOG.md.

**Acceptance.**
1. `import { createNatsTransport } from '@declaragent/plugin-agent-rpc/nats'` works.
2. Two-agent round trip passes with the new transport.
3. Nightly CI green on both Kafka and NATS integration tests.

**Test plan.**
- Unit tests for the wire format conversion (same as Kafka transport tests).
- Integration: new `nats-rpc.test.ts` + docker-compose service.

**Files touched.**
- `packages/plugin-agent-rpc/src/nats-transport.ts` (new).
- `packages/plugin-agent-rpc/src/index.ts` — re-export.
- `packages/plugin-agent-rpc/package.json` — add `nats` as optional peer dep.
- `packages/testkit/src/fleet-integration/nats-rpc.test.ts` (new).
- `.github/workflows/nightly-integration.yml` — add NATS service.
- `docs-site/docs/reference/rpc.mdx`.

**Dependencies.** None — can parallelize with #1.

---

### #3 · Dispatch-DLQ active requeue

**Milestone:** M1 · **Estimate:** 1 working day (after #6 lands) · **Risk:** low.

**Why.** 0.6.0 shipped dispatch-DLQ *tracking* (`rejected_events` SQLite table + `dlq list/show/drop --kind dispatch`). Active requeue — "pull item back out of the DLQ and let the engine retry" — still needs a way to signal the `up` daemon from the CLI. That signal arrives with #6 (control socket).

**Scope in:**
- `declaragent dlq requeue --kind dispatch <id>` CLI verb.
- `up` daemon control-socket handler: `{ op: 'dlq.requeue', kind, id }` → read row from SQLite → inject back into in-process dispatch queue → delete from DLQ.
- Idempotence: requeuing the same id twice is a no-op with a structured error (not a silent duplicate).

**Scope out:**
- Bulk requeue. Add later if demand exists.
- Cross-host requeue via control plane. Falls out of #5 for free.

**Acceptance.**
1. `declaragent dlq requeue --kind dispatch <id>` removes the row from `rejected_events` and the engine processes it within 1s.
2. If the item fails again, it lands back in the DLQ with an incremented retry counter.
3. Unit test + control-socket integration test.

**Test plan.**
- Unit: requeue handler logic.
- Integration: `packages/cli/src/dlq-cli.test.ts` — spawn `up`, DLQ an item, requeue, assert dispatched.

**Files touched.**
- `packages/cli/src/dlq-cli.ts` — new subcommand.
- `packages/cli/src/up-cli.ts` — control-socket handler.
- `packages/core/src/events/dlq.ts` — requeue function.

**Dependencies.** **Blocks on #6 (control socket).**

---

### #4 · OIDC / OAuth2 on RPC envelopes

**Milestone:** M2 · **Estimate:** 5 working days · **Risk:** medium — identity integration is full of edge cases (token refresh, audience validation, clock skew).

**Why.** `RpcAuth` envelope shape exists in `packages/plugin-agent-rpc/src/envelope.ts` but no provider implementations wire up to real IdPs. Any enterprise buyer with Okta / Azure AD / Auth0 / Google Workspace will want this on day zero. Without it, inter-agent RPC is "trusted network required" — which is a non-starter for anyone sharing a cluster with non-agent workloads.

**Scope in:**
- Two concrete provider implementations:
  - **OIDC** — discovery via `/.well-known/openid-configuration`, JWKS fetch + cache, audience claim validation, 60s clock-skew tolerance.
  - **OAuth2 Client Credentials** — token endpoint + refresh + scope check. For service-to-service where no user is present.
- `rpc-peers.yaml` extension: per-peer `auth: { provider: oidc|oauth2-client, ... }` block.
- Reject path: envelopes without a valid token go to a new `auth-rejected` DLQ kind so an operator can see why.
- Audit: every accept + reject emits an `auth_check` record on the hash chain.

**Scope out:**
- mTLS — separate workstream, pairs with #5 control plane's mTLS-ready auth floor.
- SAML — deferred; modern buyers prefer OIDC. Revisit if a deal blocks on it.
- Token caching semantics beyond 5-minute TTL — start simple.

**Acceptance.**
1. Round trip two agents with an OIDC-protected peer against a test IdP (dex or keycloak).
2. A malformed / expired token lands in `rejected_events` with `kind=auth-rejected` + a typed error code.
3. `DeclaraAuditVerify` shows `auth_check` records in the chain.
4. Docs: `docs-site/docs/reference/rpc.mdx` gains an "Authenticated RPC" section.

**Test plan.**
- Unit: JWKS cache, clock-skew logic, audience validation.
- Integration: dex container in docker-compose; two-agent test with + without valid token.

**Files touched.**
- `packages/plugin-agent-rpc/src/auth/oidc.ts` (new).
- `packages/plugin-agent-rpc/src/auth/oauth2-client.ts` (new).
- `packages/plugin-agent-rpc/src/envelope.ts` — wire auth check into receive path.
- `packages/core/src/rpc/peers-loader.ts` — schema extension.
- `docs-site/docs/reference/rpc.mdx`.

**Dependencies.** None — can parallelize with M1, M3, M5 work.

---

### #5 · Managed control plane

**Milestone:** M4 · **Estimate:** 4 weeks · **Risk:** high — the biggest item; has its own plan.

**Why.** SSH-per-host doesn't scale past ~5 agents. Without a control plane, "fleet" is a rhetorical term, not an operational one.

**See the dedicated plan:** [`docs/CONTROL_PLANE_PLAN.md`](./CONTROL_PLANE_PLAN.md) — 0.7.0 target, 6 calendar weeks detailed. This entry exists here only so the status board tracks it with everything else.

**Key integration points** with items in this plan:
- **#6 control socket** lands early and becomes a dependency for the aggregator's write path.
- **#4 OIDC/OAuth2** feeds directly into the control-plane HTTP endpoint auth layer (re-use the same provider implementations).
- **#10 SIEM export** and the control plane both read `audit_log` — share the exporter adapter.

**Acceptance.** See `CONTROL_PLANE_PLAN.md` §6.

**Dependencies.** Best-but-not-strictly-blocked on #6 + #4. Can start in parallel.

---

### #6 · Control socket on `up` daemon

**Milestone:** M5 · **Estimate:** 2 working days · **Risk:** low.

**Why.** Unblocks #3 (DLQ requeue) and is a prerequisite for the control plane's local write path (#5). Today `declaragent up -d` exposes `/metrics` (read-only) and nothing else — there's no way to ask the daemon "do X" from outside the process.

**Scope in:**
- Unix domain socket at `~/.declaragent/<agent-id>/control.sock` (Windows: named pipe).
- JSON-RPC line protocol. Five ops to start:
  - `ping` — liveness.
  - `dlq.requeue` — pull a row from `rejected_events` and inject into dispatch queue.
  - `status` — returns a struct (process id, bound sources, uptime, last-event timestamp).
  - `reload` — re-read `agent.yaml` without restart (best-effort; fail cleanly if skills changed).
  - `shutdown` — graceful drain then exit.
- Auth: socket perms 0600 (owner-only). Remote-bind is out of scope — see #5 control plane for that.

**Scope out:**
- Remote-reachable HTTP control endpoint (that's #5's job).
- Pluggable op registry — start with the 5 fixed ops.

**Acceptance.**
1. `declaragent ps` upgrades to use the socket's `status` op (currently reads `up-state.json` on disk — which can go stale).
2. #3 requeue works end-to-end.
3. Socket auto-cleans on process exit; a stale socket doesn't wedge the next `up`.

**Test plan.**
- Unit: protocol parser, op dispatch table.
- Integration: spawn `up`, connect over socket, exercise all 5 ops.

**Files touched.**
- `packages/core/src/daemon/control-socket.ts` (new).
- `packages/cli/src/up-cli.ts` — bind socket at startup.
- `packages/cli/src/ps-cli.ts` — switch from state-file read to socket query.

**Dependencies.** None.

---

### #7 · Per-tool rate limit

**Milestone:** M5 · **Estimate:** 3 working days · **Risk:** low.

**Why.** Today's rate limiting is provider-level (Anthropic 50rps / OpenRouter 20rps / 10rps default, per `packages/core/src/providers/rate-limit.ts:49-126`). An agent with an `Bash` tool that runs `curl` against a prod API can still hammer that API at provider-limit speed. Buyers want per-tool ceilings.

**Scope in:**
- New `tools.rateLimit: { ToolName: { rps, burst } }` block in `agent.yaml`.
- Re-use the `ProviderTokenBucket` implementation — the mechanics are identical.
- Applies before the tool's `.execute()` fires; blocks with a cooperative sleep, emits a `rate_limited` audit record if the wait exceeds 1s.

**Scope out:**
- Per-user / per-tenant rate limits on tools. Pairs with multi-tenant quota work in #5.
- Dynamic rate limits (adjust based on 429 response headers). Later.

**Acceptance.**
1. Config example in `agent.yaml` caps `Bash` at 1rps; a burst of 10 executions takes ≥ 9s end-to-end.
2. Over-limit calls emit `rate_limited` audit rows.
3. Docs: `reference/agent-yaml.mdx` gains a `tools.rateLimit` section.

**Files touched.**
- `packages/core/src/tools/rate-limit-gate.ts` (new wrapper).
- `packages/core/src/agents/load-agent.ts` — schema extension.
- `packages/core/src/engine/tool-runner.ts` — call the gate before `execute`.

**Dependencies.** None.

---

### #8 · Auto-recovery for crashed MCP servers

**Milestone:** M5 · **Estimate:** 4 working days · **Risk:** medium — process lifecycle + backoff state is easy to get subtly wrong.

**Why.** If `mcp__github__list_issues` stops responding because the MCP stdio server crashed, today the operator has to notice and restart. Enterprise expectation: supervisor respawns, backoff prevents crash-loops, an alarm fires if backoff gives up.

**Scope in:**
- Health-check loop: ping each MCP server every 10s; if 2 consecutive fails, consider it dead.
- Exponential backoff: 1s → 2s → 4s → ... → 60s cap; after 5 consecutive give-ups, open a "mcp-server-down" circuit and emit a Prometheus alert.
- Recovery: on successful restart, re-issue the `initialize` handshake + re-register tool catalog.

**Scope out:**
- MCP server version pinning / upgrade orchestration — that's package-manager territory.
- Graceful draining of in-flight tool calls across a respawn. First iteration drops them with a typed error; full draining in a follow-up.

**Acceptance.**
1. `kill -9` an MCP server during a session; within 20s it's respawned and the next tool call succeeds.
2. Kill it 6 times in rapid succession; the circuit opens, an alert fires in `/metrics`, subsequent tool calls fail fast with a typed error until the circuit half-opens.
3. Integration test covers both the happy respawn and the crash-loop path.

**Files touched.**
- `packages/core/src/mcp/supervisor.ts` (new).
- `packages/core/src/mcp/stdio-client.ts` — emit lifecycle events.
- `packages/core/src/observability/prometheus.ts` — new `mcp_server_restarts_total`, `mcp_server_circuit_state`.

**Dependencies.** None.

---

### #9 · GitOps `fleet render`

**Milestone:** M3 · **Estimate:** 5 working days · **Risk:** low — spec is well-scoped.

**Why.** Enterprises running GitOps (Argo, Flux) want their `fleet.yaml` to become their k8s reality via a PR + merge, not a `declaragent fleet deploy` command hitting an imperative API. `fleet render` outputs the manifests; the operator commits them; their GitOps stack reconciles.

**Scope in:**
- `declaragent fleet render --target k8s [--out <dir>]` emits: Deployment per agent, Service, ConfigMap, Secret refs (not values), per-agent ServiceMonitor.
- `declaragent fleet render --target helm [--out <dir>]` emits a Helm chart with `values.yaml` exposing common knobs (replicas, image, env).
- Deterministic: same input → identical output (for `diff` stability).

**Scope out:**
- Kustomize target. Helm covers the common case; add later if asked.
- Auto-pushing to a git remote. Operator does that themselves (the whole point).

**Acceptance.**
1. `fleet render --target k8s -o /tmp/out` on `templates/fleet-starter/` produces manifests that pass `kubectl apply --dry-run=server`.
2. `fleet render --target helm -o /tmp/chart` produces a chart that `helm lint` passes and `helm template` can render.
3. Golden-file tests in CI catch unintended output drift.

**Files touched.**
- `packages/cli/src/fleet-render-cli.ts` (new).
- `packages/cli/src/fleet-render/k8s-renderer.ts` (new).
- `packages/cli/src/fleet-render/helm-renderer.ts` (new).
- `packages/cli/src/fleet-render/__snapshots__/` — golden files.

**Dependencies.** None.

---

### #10 · SIEM audit export

**Milestone:** M3 · **Estimate:** 5 working days · **Risk:** low.

**Why.** Today's audit chain lives in a per-`up` SQLite file. Compliance teams need it in their SIEM. No export, no SOC2 / FedRAMP story.

**Scope in:**
- Pluggable exporter trait: `interface AuditExporter { push(entries: AuditEntry[]): Promise<PushResult> }`.
- Three concrete exporters:
  - **Splunk HEC** (HTTP Event Collector).
  - **Elastic** (bulk `_doc` endpoint).
  - **Datadog Logs** (v2 intake).
- Exporter runs in-process in the `up` daemon, on a 10s batching interval with high-water-mark tracking in SQLite (`audit_export_cursor` table — so restart doesn't re-push).
- Failure mode: exporter errors re-queue (simple retry); after 5 consecutive failures, emit an alert + pause until next `up` restart or manual resume.

**Scope out:**
- Generic syslog / CEF. Revisit if a deal blocks on it.
- Historical backfill CLI. Forward-only is enough for MVP; operators who need backfill can dump SQLite manually.

**Acceptance.**
1. With `audit.export.kind: splunk` + a valid HEC token, every new audit row lands in Splunk within 15s.
2. Kill the Splunk endpoint; after restart, no gaps (cursor held).
3. Unit + integration tests per exporter (use docker-compose Splunk / Elastic for integration).

**Files touched.**
- `packages/core/src/audit/exporters/{splunk,elastic,datadog}.ts` (new).
- `packages/core/src/audit/exporter-loop.ts` (new).
- `packages/core/src/audit/schema.sql` — add `audit_export_cursor` table.
- `packages/cli/src/up-cli.ts` — start exporter loop when config enables it.

**Dependencies.** None.

---

### #11 · v1.1 Agent Graph — typed capabilities

**Milestone:** M6 · **Estimate:** 2 weeks · **Risk:** medium — schema design is subtle and easy to over-engineer.

**Why.** Today's inter-agent RPC payloads are loose JSON. `capabilities.yaml` names a capability but doesn't constrain request / response shape. See `AGENT_RPC_PLAN.md §1`.

**Scope in:**
- Extend `capabilities.yaml` schema: `request` + `response` JSON Schema per capability.
- Codegen: `declaragent capabilities gen --peer <id>` emits TypeScript types per capability into `generated/` of the caller.
- Runtime validation: `RequestAgent` checks request against schema before send, response after receive. Violations emit `capability.schema_violation` audit rows.
- Back-compat: omitted schemas → legacy loose JSON behaviour.

**Scope out:**
- gRPC / protobuf — JSON Schema is enough for now.
- Cross-language codegen — TypeScript only initially.

**Acceptance.**
1. A capability declared with inputs `{ title: string, severity: 'low'|'med'|'high' }` rejects `severity: 'critical'` at the caller with a typed error.
2. Codegen output passes `tsc --noEmit` across the whole workspace.
3. Example fleet in `templates/fleet-starter/` uses typed capabilities for the concierge → reviewer call.

**Files touched.**
- `packages/core/src/rpc/capabilities-loader.ts` — schema extension.
- `packages/core/src/rpc/capability-validator.ts` (new).
- `packages/plugin-agent-rpc/src/request-agent.ts` — validation hooks.
- `packages/cli/src/capabilities-gen-cli.ts` (new).

**Dependencies.** None, but best sequenced after #4 (OIDC) and #1 (soak) so the RPC path is stable before layering type enforcement on top.

---

### #12 · Recorded-conversation regression tests for the builder

**Milestone:** M6 · **Estimate:** 3 working days · **Risk:** low.

**Why.** FIRST_PRINCIPLES_VALIDATION §Pillar 5 flagged this as the only gap in the conversational builder: "all e2e tests hand-construct proposals to simulate what the model emits; there's no recorded-conversation test proving a real model drives the full understand→propose→apply loop." Without these, the system prompt can silently regress between releases.

**Scope in:**
- Fixture format: JSONL conversation transcripts captured from real `claude-sonnet-4-6` / `claude-opus-4-7` calls. Each entry is `{role, content, tool_calls?, tool_results?}`.
- Replay harness: feeds the fixture back through the Engine with a stub provider that returns the recorded assistant messages verbatim. Asserts the same `DeclaraApplyChange` fires with the same step kinds.
- Five canonical fixtures to start:
  1. Single-agent webhook triager.
  2. Two-agent fleet (concierge + reviewer).
  3. Cron-driven daily digest.
  4. User paste of a leaked token → redaction path.
  5. Scope escape attempt → rejection path.

**Scope out:**
- Full adversarial fuzzing (jailbreak attempts). Separate security workstream.
- Cross-model recording (Gemini / GPT). Claude first; expand later.

**Acceptance.**
1. `bun test --preload builder/fixtures` replays all 5 fixtures and asserts expected `DeclaraApplyChange` step kinds land.
2. A new fixture can be recorded with `BUILDER_RECORD=1 declaragent` (stretch goal — the transcript capture is optional; manual JSONL authoring is acceptable for MVP).
3. PR template gains a "record a new builder fixture" checkbox when the system prompt changes.

**Files touched.**
- `packages/cli/src/builder/fixtures/*.jsonl` (new).
- `packages/cli/src/builder/__tests__/replay-harness.ts` (new).
- `packages/cli/src/builder/__tests__/fixture-replay.test.ts` (new).

**Dependencies.** None.

---

## 4 · How to use this doc

1. **Starting an item** — claim the Owner column in §1. Move Status to *In-progress*. If scope changes from §3, **edit §3 first**, then update §1 estimate.
2. **Blocking on another item** — set Status to *Blocked on #N* and drop a line in that item's PR description with what's needed.
3. **Shipping an item** — tick the §1 checkbox, paste the PR URL and merged SHA into Evidence, flip Status to *Shipped*, update §0 banner.
4. **Scope disagreement** — prefer editing this doc's §3 spec over a side conversation that evaporates. Future-you needs the paper trail.
5. **New gap discovered mid-program** — add it as row #13+ with full §3 spec. Don't silently append to an existing item — each row must map to one deliverable.

## 5 · Definition of "Enterprise ✅ across all 5 pillars"

All twelve boxes in §1 ticked. Plus:
- All five pillars in [FIRST_PRINCIPLES_VALIDATION.md](./FIRST_PRINCIPLES_VALIDATION.md) flip their enterprise column to ✅ with cited evidence.
- CLAUDE.md scoreboard matches.
- [AGENTS.md](../AGENTS.md) feature rows updated with file:line references for every newly-enterprise capability.
- Website `/principles` section flips its 🟡 badges to ✅ and the "10–14 engineer-weeks" claim is replaced with "shipped."

## 6 · Cross-references

- [FIRST_PRINCIPLES_VALIDATION.md](./FIRST_PRINCIPLES_VALIDATION.md) — origin of the gap list.
- [FIRST_PRINCIPLES_AUDIT.md](./FIRST_PRINCIPLES_AUDIT.md) — exhaustive capability matrix.
- [CONTROL_PLANE_PLAN.md](./CONTROL_PLANE_PLAN.md) — the M4 deep plan.
- [AGENT_RPC_PLAN.md](./AGENT_RPC_PLAN.md) — the M6 typed-capabilities background.
- [RELEASE_0_6_0_PLAN.md](./RELEASE_0_6_0_PLAN.md) — what shipped so far.
- [THREAT_MODEL.md](./THREAT_MODEL.md) — pairs with #4 auth and #10 audit export.

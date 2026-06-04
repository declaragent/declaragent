# Release 0.6.0 Plan — "Production hardening"

**Status:** Draft · **Target tag:** `@declaragent/cli@0.6.0` · **Authored:** 2026-04-22

This plan picks up where the five 0.5.x wiring items (AGENTS.md §"Prioritized path") leave off. Those closed the runtime gaps between *designed* and *wired*. 0.6.0 closes the next tier: the Phase 4/5/6 🔵 items and the remaining 🟡/❌ gaps that actually gate running an agent fleet in production.

**Theme:** *make a running agent safe to leave unattended* — reliability, observability, and the inbound channel loop.

See **[AGENTS.md](../AGENTS.md)** for the evidence-backed capability matrix this plan works against.

---

## Baseline assumption

The five wiring items ship as 0.5.x patches before 0.6.0 work begins:

1. External source adapter discovery in `up`
2. MCP runtime activation
3. `SendMessage` + channel runtime activation
4. Plugin runtime activation
5. Non-memory transports in `fleet run` + `RequestAgent` in `BUILTIN_TOOLS`

Slice 0 (below) is the gate that enforces this.

---

## Work-item summary

| Track | Item | Status change | Effort |
| --- | --- | --- | --- |
| A1 | Circuit breakers wired into dispatcher | 🔵 → ✅ | 2d |
| A2 | Event-dispatch DLQ with requeue | ❌ → ✅ | 2d |
| A3 | Default rate limiting on | 🔵 → ✅ | 1d |
| B1 | Prometheus `/metrics` endpoint | 🔵 → ✅ | 1.5d |
| B2 | OpenTelemetry auto-enable | 🟡 → ✅ | 1d |
| C1 | Inbound channel events route to skills | 🟡 → ✅ | 3d |
| D1 | Multi-agent-over-real-broker integration test | ❌ → ✅ | 3d + 1w soak |
| D2 | `declaragent fleet deploy` orchestration | 🟡 → ✅ | 2d |

**Total:** ~15 engineer-days + 1 week soak. Realistic calendar: 3–4 weeks.

---

## Track A · Reliability at runtime

### A1 — Circuit breakers (🔵 → ✅)

Instantiate `packages/core/src/reliability/circuit-breaker.ts` around (a) source pulls and (b) per-target skill invocations inside the event dispatcher. State transitions (`closed → open → half-open`) surface through existing counters plus a new `events list --state circuit-open` filter.

- **Files:** `packages/core/src/dispatcher/*`, wired from `packages/cli/src/up-lifecycle.ts`; config schema extension in `agent.yaml` under `reliability.circuitBreaker`.
- **Accept:** unit tests simulate a 5xx burst → breaker opens; integration test with a webhook source proves recovery after cool-down.

### A2 — Event-dispatch DLQ with requeue (❌ → ✅)

First-class gap today — rejected events stay rejected. Add a `rejected_events` table, a `dlq requeue <id>` verb, and a poison-message threshold so the source DLQ and dispatch DLQ cooperate instead of overlap.

- **Files:** `packages/core/src/store/*`, `packages/cli/src/dlq-cli.ts`, dispatcher reject path.
- **Accept:** a skill that throws every time pushes the event into `rejected_events`; `dlq list` shows it; `dlq requeue <id>` reinjects through the dispatcher.

### A3 — Default rate limits (🔵 → ✅)

`up-cli.ts` stops passing an empty rate-limit spec. Ship per-provider defaults (Anthropic, OpenRouter) and a `reliability.rateLimits` knob in `agent.yaml`.

- **Files:** `packages/cli/src/up-cli.ts`, default provider limits in `packages/core/src/providers/*`.
- **Accept:** 100-rps synthetic firehose against a webhook agent caps outbound LLM calls without dropping events — they queue.

---

## Track B · Observability by default

### B1 — Prometheus `/metrics` endpoint (🔵 → ✅)

The exposition endpoint the testkit dashboards are already waiting for. `declaragent up` opens a `--metrics-port` HTTP listener serving the text-format exporter. On by default when `-d`.

- **Files:** new `packages/core/src/observability/prometheus.ts`, wired from `up-lifecycle.ts`.
- **Accept:** `curl :9464/metrics` after `declaragent up -d` returns counters matching `events list`; testkit's Grafana dashboard lights up against a real scrape.

### B2 — OpenTelemetry auto-enable (🟡 → ✅)

`createOtelBridge()` attaches automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No per-command flags. Traces cover `source → dispatch → skill → LLM` span tree.

- **Files:** `packages/core/src/observability/otel.ts` wiring in `up-lifecycle.ts` + `fleet-run.ts`.
- **Accept:** Jaeger receives a single connected trace for one webhook event.

---

## Track C · Channels — close the inbound half

### C1 — Inbound channel events route to skills (🟡 → ✅)

0.5.x's `SendMessage` delivers outbound; this slice completes the loop so a Slack mention triggers a skill. Wire `ChannelOutboundBridge`'s inbound counterpart into the dispatcher registry.

- **Files:** `packages/core/src/channels/*`, `packages/cli/src/up-lifecycle.ts`, channel adapters' inbound paths.
- **Accept:** mention-bot in a Slack test workspace → skill runs → replies via `SendMessage` → audit row records both edges. Telegram/Discord/WhatsApp follow as adapter-local deltas.

---

## Track D · Fleet production path

### D1 — Multi-agent-over-real-broker integration test (❌ → ✅)

Two-agent fleet in CI against Redpanda (reusing `source-kafka/test/integration.test.ts` infra), proving `RequestAgent` traverses the broker end-to-end. Gated behind `FLEET_INTEGRATION=1`; runs nightly.

- **Files:** `packages/testkit/src/fleet-integration/*`, `.github/workflows/nightly-integration.yml`.
- **Accept:** green nightly for 7 consecutive runs before promoting beta → rc.

### D2 — `declaragent fleet deploy` orchestration (🟡 → ✅)

Flesh out strategy flags (`--rolling`, `--canary`) so an N-agent rollout sequences with health checks between steps. Stays generator-style for cloud invocation (push-button `gcloud` remains 🔵 — intentional).

- **Files:** `packages/cli/src/fleet-deploy-cli.ts`.
- **Accept:** rolling deploy of `templates/fleet-starter/` against a local docker-compose target shows staggered cutover; failed health check halts the roll.

---

## Explicitly out of scope

- Push-button `gcloud run deploy` — permanent non-goal per `PHASE_7_PLAN.md` §9.
- `agent.yaml` inline channels/sources/plugins — `SPEC_AND_PLAN.md` §2.1 keeps them separate.
- v1.1 "Agent Graph" beyond D1 — schema work waits.

---

# Slice-by-slice build plan

Nine vertical slices. Each slice is a **1–3 day PR cluster** that ships as a prerelease tag, is independently revertible, and leaves `main` green. Slices are ordered so every later slice can *observe* itself through machinery landed by earlier slices.

**Release cadence:** `0.6.0-alpha.{1..5}` → `0.6.0-beta.{1..2}` → `0.6.0-rc.1` → `0.6.0`. Tag after each slice; promote when the nightly suite is green for 24h.

## Slice 0 · Pre-flight gate (½ day, no release)

**Goal:** prove the 0.5.x baseline is real before we build on it.

- Run the full happy-path smoke from AGENTS.md §"The happy path that works today" against `@declaragent/cli@0.5.x`.
- Confirm MCP/plugin/channel/source-discovery/RPC paths show ✅ in a fresh AGENTS.md diff.
- Cut a `0.6.0-alpha.0` tag as a baseline marker so regressions are bisectable.

**Exit:** AGENTS.md PR merged reclassifying the five items 🟡 → ✅.

---

## Slice 1 · Prometheus `/metrics` endpoint (Track B1)

**Ship as:** `0.6.0-alpha.1` · **Size:** 1.5 days · **PRs:** 2

### Why first
Every subsequent slice mutates counters that already exist in `packages/core/src/observability.ts`. Without exposition, they're invisible and we can't verify later slices behaviorally.

### PR 1.1 — exporter module
- New `packages/core/src/observability/prometheus.ts` — text-format serializer over the existing counter registry.
- Unit tests: snapshot the exposition for a handful of fixture counter states.
- No CLI changes.

### PR 1.2 — wire into `up`
- `packages/cli/src/up-lifecycle.ts` opens an HTTP listener on `--metrics-port` (default `:9464`, off when not `-d`, configurable via `agent.yaml#observability.metricsPort`).
- Testkit Grafana dashboard confirmed against a local `curl :9464/metrics`.
- Smoke test: `declaragent up -d` → fire a webhook → `curl` shows `declaragent_events_dispatched_total` tick.

**Acceptance:** Grafana board from `packages/testkit` lights up without manual shims.

**Risk:** port collision — document override path in release notes.

---

## Slice 2 · OpenTelemetry auto-enable (Track B2)

**Ship as:** `0.6.0-alpha.2` · **Size:** 1 day · **PRs:** 1

- `createOtelBridge()` attaches in both `up-lifecycle.ts` and `fleet-run.ts` **iff** `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No new flags.
- Span tree: `source.receive` → `dispatch.route` → `skill.run` → `llm.call`. Re-use existing counter labels so traces and metrics share cardinality.
- Update `docs/OTEL_SETUP.md` to remove the manual-enable instructions.

**Acceptance:** point a local Jaeger at the agent, fire one webhook, see a single connected trace.

**Risk:** noisy spans in tight loops — rate-limit span creation on the LLM retry path.

---

## Slice 3 · Circuit breakers in the dispatcher (Track A1)

**Ship as:** `0.6.0-alpha.3` · **Size:** 2 days · **PRs:** 2

### Why after Slice 1
Breaker transitions are only useful if operators can see them. Slice 1 gave us `declaragent_breaker_state{target,state}`.

### PR 3.1 — breaker integration
- Instantiate `packages/core/src/reliability/circuit-breaker.ts` at (a) source pulls and (b) per-target skill invocations.
- `agent.yaml#reliability.circuitBreaker` schema — `failureThreshold`, `cooldownMs`, `halfOpenProbes`. Sensible defaults so the feature is on without config.
- Emit `declaragent_breaker_state` + `declaragent_breaker_transitions_total` counters.

### PR 3.2 — CLI surface
- `declaragent events list --state circuit-open` filter.
- `declaragent ps` adds a column when any breaker is open.
- Integration test: burst 5xx against a webhook source; assert breaker opens, cools down, re-closes on healthy probes.

**Acceptance:** the integration test above + a manual demo scripted into `docs/RELIABILITY.md`.

**Risk:** false-positive trips from LLM retry storms — land with `failureThreshold` generous (default 10) and tunable.

---

## Slice 4 · Default rate limits on (Track A3)

**Ship as:** `0.6.0-alpha.4` · **Size:** 1 day · **PRs:** 1

- `up-cli.ts` stops passing an empty `rateLimits` spec; per-provider defaults (Anthropic 50 rps, OpenRouter 20 rps — pulled from their published limits).
- `agent.yaml#reliability.rateLimits` for overrides.
- **Migration note in CHANGELOG:** loud-dev workloads can opt out with `reliability.rateLimits: { enforce: false }`.

**Acceptance:** 100-rps synthetic firehose through a webhook agent → LLM calls cap at the provider limit; events queue instead of drop (verifiable via Slice 1 queue-depth counter).

**Risk:** surprise throttling for existing users — highlight in release notes and keep the opt-out one-liner stable.

---

## Slice 5 · Event-dispatch DLQ with requeue (Track A2)

**Ship as:** `0.6.0-alpha.5` · **Size:** 2 days · **PRs:** 2

### PR 5.1 — storage + outcome
- New `rejected_events` SQLite table with `event_id`, `source_id`, `skill_id`, `rejection_reason`, `attempt_count`, `first_seen`, `last_seen`.
- Dispatcher's reject path writes a row instead of dropping; outcome extended with `rejected→<reason>` (joins existing `dispatched→<sessionId>` convention).
- Idempotency cache participates so a requeue of an already-succeeded event is a no-op.

### PR 5.2 — CLI surface
- `declaragent dlq list --kind dispatch`, `declaragent dlq show <id>`, `declaragent dlq requeue <id>` (all follow existing `dlq-cli.ts` verbs for source DLQs so the two DLQs share UX).
- Poison-message threshold (`reliability.maxRequeueAttempts`) — beyond it, `dlq requeue` refuses without `--force`.
- Integration test: a skill that throws deterministically produces a `rejected_events` row; `dlq requeue` re-runs through the full dispatcher; a fixed skill succeeds the second time.

**Acceptance:** AGENTS.md §7 row "Event dispatch DLQ" flips ❌ → ✅.

**Risk:** new table collides with existing migrations — test upgrade from a 0.5.x SQLite file in CI.

---

## Slice 6 · Inbound channels (Track C1)

**Ship as:** `0.6.0-beta.1` · **Size:** 3 days · **PRs:** 2

### Why gated on 0.5.x
Outbound `SendMessage` must be live — otherwise we deliver inbound but can't reply, and the demo is unconvincing.

### PR 6.1 — Slack inbound
- `ChannelInboundBridge` in core: listens on the adapter's inbound stream, converts to an `EventSourceAdapter`-shaped event, routes through dispatcher.
- Slack adapter's `onMessage` / `onMention` hook wired to the bridge.
- `channels.json` entry grows an `inbound: { events: ["mention", "dm"] }` selector.

### PR 6.2 — Telegram / Discord / WhatsApp
- Same bridge, adapter-local inbound hooks — each adapter's PR is a small delta.
- Live workspace test per adapter (documented in `docs/COMMUNICATION_CHANNELS.md` §5 appendix).

**Acceptance:** mention-bot loop — Slack mention triggers skill, skill replies via `SendMessage`, both edges show in `audit verify` as a linked pair.

**Risk:** provider webhooks require public ingress — ship with a built-in `--tunnel` shim (reuse `webhook` source's tunnel) or document ngrok for dev.

---

## Slice 7 · Fleet-over-real-broker integration test (Track D1)

**Ship as:** `0.6.0-beta.2` · **Size:** 3 days (code) + 1 week soak · **PRs:** 1

- Harness in `packages/testkit/src/fleet-integration/` reuses `source-kafka`'s Redpanda docker-compose.
- Two-agent test: agent A's skill calls `RequestAgent("B.ping")`; agent B runs on a separate process, connected via Kafka transport; assert reply within 2s.
- `.github/workflows/nightly-integration.yml` runs with `FLEET_INTEGRATION=1`. Failures file an issue, don't block PRs.

**Exit criterion:** 7 consecutive green nightlies before promoting beta → rc.

**Acceptance:** AGENTS.md §3 row "Multi-agent-over-real-broker integration test" flips ❌ → ✅.

**Risk:** Redpanda flake in CI — run each test with 3x retry at the test level (not the workflow level, so flake patterns are visible).

---

## Slice 8 · Fleet deploy orchestration (Track D2)

**Ship as:** `0.6.0-rc.1` · **Size:** 2 days · **PRs:** 1

- Flesh out `fleet-deploy-cli.ts` strategies:
  - `--rolling`: sequential cutover with per-agent health check (reuse `declaragent ps` health signal).
  - `--canary`: deploy 1 agent, wait N minutes, promote if healthy, else roll back.
- Stays generator-style for cloud invocation — we emit `docker compose` / `kubectl` / `gcloud` commands per step; users run them. (Explicit non-goal per AGENTS.md §7.)
- Integration test: rolling deploy of `templates/fleet-starter/` against local docker-compose, inject a failing health check mid-roll, assert rollback.

**Acceptance:** the integration test + a demo video linked from `docs/FLEET_PLAN.md`.

**Risk:** rollback semantics are fragile — conservative default: rollback means "stop the roll", not "revert already-deployed agents". Document clearly.

---

## Slice 9 · 0.6.0 release cut (½ day)

**Ship as:** `0.6.0` · **PRs:** 1

- Consolidate `.changeset/` entries into a single `CHANGELOG.md` section.
- Refresh AGENTS.md: every row this plan touched flips to ✅ with new evidence pointers; deferrals list trimmed.
- Update `CLAUDE.md` "Current status" and "Next priorities" — next priorities become v1.1 items (agent graph, non-memory transport coverage for the other 4 brokers).
- Version bump via changesets, `npm publish` all 13 packages, tag `@declaragent/cli@0.6.0`.
- Post-release: create GitHub milestone `v1.0` with the remaining 🔵 items.

---

## Dependency graph

```
Slice 0 ──┬─► Slice 1 ─► Slice 2
          ├─► Slice 3 (needs Slice 1 for visibility)
          ├─► Slice 4
          ├─► Slice 5
          ├─► Slice 6 (needs 0.5.x SendMessage)
          ├─► Slice 7 (needs 0.5.x non-memory transports)
          └─► Slice 8
                    Slice 9 ◄── all of above
```

Slices 1→2, 3, 4, 5, 6, 7, 8 are independent after Slice 0 — **safe to parallelize across engineers** if available. Single-engineer sequential path is ~15 working days of code + 1 week of Slice 7 soak = **~4 calendar weeks**.

## Per-slice checklist

Apply to every slice:

- [ ] Unit tests colocated next to changed files
- [ ] Integration test where a runtime boundary is crossed
- [ ] Counters emitted for anything that can fail
- [ ] `docs/` updated in the same PR (plan doc or user doc, whichever fits)
- [ ] Changeset entry written
- [ ] AGENTS.md row updated if status mark changes
- [ ] Smoke against `templates/fleet-starter/` before tagging the prerelease

## Kill-switch criteria

If any slice blows past 2× its estimate, **stop and reassess** — don't extend the slice, descope it and push the overflow to a follow-up 0.6.x. The goal is a steady cadence of small shippable increments, not a single big-bang 0.6.0.

---

## Relationship to other plans

- **`SPEC_AND_PLAN.md`** — remains source of truth for *intent*. This plan cites its phase assignments for 🔵 items and does not redefine them.
- **`PHASE_4_PLAN.md` / `PHASE_5_PLAN.md` / `PHASE_6_PLAN.md`** — this plan operationalizes the 🔵 deferrals those phases named. When a slice lands, mark the corresponding phase item shipped in its own doc.
- **`AGENTS.md`** — the evidence ledger. Every slice's acceptance criteria include an AGENTS.md mark-change.
- **`PATCH_0_5_2_PLAN.md`** — sibling pattern for in-series plan docs. Follow the same convention.

# Declaragent — Status (single source of truth)

**This file is the canonical answer to "which plan is current?", "what's the backlog?",
"where does the project stand?", and "what versions are we on?"** Every other doc that
asks those questions should resolve here. When this file and any other doc disagree about
*current* status, this file wins; when this file and `SPEC_AND_PLAN.md` disagree about
*requirements*, the spec wins.

**Last refreshed:** 2026-06-04.

---

## Current canonical plan & backlog

| Question | Resolves to |
| --- | --- |
| What are the requirements / phased plan? | [`SPEC_AND_PLAN.md`](./SPEC_AND_PLAN.md) — supersedes the background design docs. |
| What's the active follow-up backlog? | [`POST_ENTERPRISE_BACKLOG.md`](./POST_ENTERPRISE_BACKLOG.md) — 52-item tracker. |
| What was the enterprise-readiness tracker? | [`ENTERPRISE_PRODUCTION_PLAN.md`](./ENTERPRISE_PRODUCTION_PLAN.md) — 12 items, closed. |
| What's the next breaking change? | [`ZERO_TRUST_DEFAULT_MIGRATION.md`](./ZERO_TRUST_DEFAULT_MIGRATION.md) — 0.8.0 `rpc.auth.enabled` flip. |
| What does 1.0 promise not to break? | [`COMPAT.md`](./COMPAT.md). |
| Where are the older, superseded plan docs? | [`archive/README.md`](./archive/README.md). |

The detailed evidence ledgers behind the scoreboard below are
[`FIRST_PRINCIPLES_VALIDATION.md`](./FIRST_PRINCIPLES_VALIDATION.md) (pillar-by-pillar
yes/no verdict) and [`FIRST_PRINCIPLES_AUDIT.md`](./FIRST_PRINCIPLES_AUDIT.md) (exhaustive
capability matrix with `file:line` evidence).

---

## Scoreboard

Reproduced verbatim from [`FIRST_PRINCIPLES_VALIDATION.md`](./FIRST_PRINCIPLES_VALIDATION.md)
(the evidence ledger). The five-pillar decomposition treats the conversational builder as a
first-class pillar.

| Pillar | Single-machine | Enterprise (multi-host, SSO/SIEM/GitOps, soak-proven) |
| --- | --- | --- |
| 1 · **Define** agents declaratively | ✅ | ✅ (v0.7.4) |
| 2 · **Deploy + monitor** fleet | ✅ | ✅ (v0.7.4 — Slice 3 cross-host fan-out #50) |
| 3 · **Independent agents** + delegation | ✅ | ✅ (v0.7.4 — JetStream / SQS / AMQP / MQTT all shipped; soak accumulating) |
| 4 · **Tools + MCP** access | ✅ | ✅ (v0.7.5 — #27 per-MCP aggregate rate-limit cap shipped) |
| 5 · **Conversational builder** → deployable fleet | ✅ | ✅ (v0.7.1) |

**Single-machine production: ✅.** **Enterprise production: ✅ (5 of 5 pillars).** The Kafka
24h soak (pillar 3) is a *receipt accruing Sundays*, not a capability gate — see the live CI
signal below for the real, machine-readable status rather than this snapshot.

---

## Current package versions

These are the **verifiable** `package.json` values at HEAD — the source of truth. Where
prose elsewhere (CLAUDE.md, ZERO_TRUST_DEFAULT_MIGRATION.md) cites a different CLI number,
it is describing the npm-published-vs-in-flight nuance, not contradicting these.

| Package | Version | Notes |
| --- | --- | --- |
| _root_ (`declaragent`) | `0.0.0` | `private: true`; never published. |
| `@declaragent/cli` | `0.7.5` | In-flight at HEAD. `npm view @declaragent/cli dist-tags` shows the last *published* `latest` (0.7.4 at last refresh) — published and in-flight can differ by one. |
| `@declaragent/core` | `0.5.4` | |
| `@declaragent/plugin-agent-rpc` | `4.0.3` | |
| `@declaragent/testkit` | `4.0.4` | |
| `@declaragent/channel-{slack,telegram,discord,whatsapp}` | `4.0.0` | |
| `@declaragent/source-{kafka,nats,mqtt,amqp,sqs}` | `4.0.0` | |

**Known version-coherence gaps** (tracked, not yet resolved here): the package versions are
not lockstep (cli `0.7.x`, core `0.5.x`, channels/sources `4.0.x`), and **no `v<cli-version>`
git tag exists** — the newest `v*` tag is `v0.5.21`, so the binary-release pipeline keyed on
`v*` tags has not fired for any 0.6.0→0.7.5 release. Both are owned by the release/versioning
workstream (PROD_PARITY_ACTIONS.md P0-1 / P1-8). Version-*policy* questions (what 1.0 will
freeze) resolve to [`COMPAT.md`](./COMPAT.md).

---

## Live CI signal

Hardcoded status copy on the site/docs is **not** authoritative. The machine-readable signal
is the `STATUS.json` artifact written by the CI workflows on every scheduled run (green or red):

- [`.github/workflows/nightly-integration.yml`](../.github/workflows/nightly-integration.yml)
  — daily Kafka + NATS fleet-RPC round-trip. Writes `STATUS.json`
  (`status`, per-job `conclusion`, ISO `timestamp`, `commit`, `run_url`) as artifact
  `status-json-<run_id>`.
- [`.github/workflows/weekly-soak.yml`](../.github/workflows/weekly-soak.yml)
  — Sunday 24h Kafka soak. Writes the same `STATUS.json` shape as artifact
  `status-json-<run_id>`.

Failure history is consolidated into **one rolling tracker issue per workflow** (labels
`ci-tracker:nightly-integration` and `ci-tracker:weekly-soak`), one comment per failure —
not one issue per night. The green-before-merge policy and quarantine-label convention live in
[`../CONTRIBUTING.md`](../CONTRIBUTING.md#ci-status--green-before-merge).

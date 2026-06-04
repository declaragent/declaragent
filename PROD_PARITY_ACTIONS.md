# PROD_parity — Action List

**Source:** [`PROD_parity.md`](./PROD_parity.md) (independent production-readiness review, 20 May 2026).
**Status of this file:** fact-checked against the codebase at HEAD on `main` (2026-06-04). Every item below carries a **verdict** (is the review's claim actually true?) and **evidence** (`file:line`) so we act on reality, not on the review's framing. Several review claims were overstated or already mitigated — those are corrected inline, not copied verbatim.

Cross-references the canonical backlog: [`docs/POST_ENTERPRISE_BACKLOG.md`](./docs/POST_ENTERPRISE_BACKLOG.md).

---

## Verification summary

| # | Review claim | Verdict | One-line reality |
| --- | --- | --- | --- |
| 1 | Install pipeline broken (tag mismatch → 404) | **TRUE** | No `v0.6+`/`v0.7.x` git tag exists; binary release never fired for any 0.6→0.7.5 release. |
| 2 | `init` next-command fails + templates unshipped | **TRUE (npm), PARTIAL (dev)** | `templates/` absent from npm `files`; `init` unpacker is stub-only (code TODO). |
| 3 | Nightly red, no triage | **PARTIAL** | Auto-triage workflows *exist*; the gap is green-gate policy + issue consolidation, not tooling. |
| 4 | Pen-test signoff is a placeholder | **TRUE** | All fields `TBD`, findings table empty. |
| 5 | No `SECURITY.md` / disclosure path | **TRUE** | Absent at root and `.github/`. |
| 6 | Bus factor = 1 | **TRUE** | 206/207 commits one author; AI co-author doesn't diversify. |
| 7 | Versioning incoherent | **TRUE** | cli 0.7.5 / core 0.5.4 / channels+sources 4.0.x / root 0.0.0; no `v0.7.x` tag. |
| 8 | No 1.0 / SemVer | **TRUE** | All pre-1.0; 0.8.0 breaking flip documented but under 0.x. |
| 9 | Plan-doc cardinality | **TRUE** | 36 docs, ~22 plan/backlog; no `docs/STATUS.md`, no `docs/archive/`. |
| 10 | Status is hardcoded marketing, not CI-driven | **TRUE** | Site HTML hardcodes status; no `STATUS.json` artifact. |
| 11 | Error messages dead-end | **TRUE** | binary-not-found remedies all assume the (broken) pipeline works. |
| 13 | Brand split (Declaragent vs d9t) | **TRUE** | Both binaries ship; BRAND.md itself calls it "indecision". |
| A | **Agents spin up as single-cycle single-prompt** | **FALSE within a turn / TRUE across events** | 50-iteration tool loop per turn, but fresh stateless session per event + no memory layer. See **Item A**. |

---

## P0 — blocks any honest production use

### P0-1 · Fix the release→install pipeline (the lynchpin)
**Verdict: TRUE.** `postinstall.js:176` builds the download URL as `v${pkgVersion}` → e.g. `…/releases/download/v0.7.5/declaragent-linux-x64.tar.gz`. `release-binaries.yml:27-30` only fires `on: push: tags: ['v*']`. But the newest `v*` tag is **`v0.5.21`** — every 0.6.0→0.7.5 release shipped to npm under scoped `@declaragent/cli@*` tags with **no matching `v*` tag**, so `release-binaries.yml` never ran and the binary 404s. The `bin/declaragent.js` Bun fallback is the only reason this hasn't been reported.
- **Do:** make `release.yml` cut a `v<cli-version>` tag (and GitHub release) after each CLI publish, **or** retrigger `release-binaries.yml` on `@declaragent/cli@*` and derive the `v*` release name from it.
- **Do:** add a CI job that runs a true `npm i -g @declaragent/cli` from the **real npm registry** against the **real GitHub release** (not the local-mirror smoke that `npm-install-smoke.yml` / `installer-smoke.yml` currently do against a fake `v0.0.1-smoke` tag).
- **Evidence:** `packages/cli/bin/postinstall.js:176,187-192`; `.github/workflows/release-binaries.yml:27-30`; `git tag | grep '^v'` → max `v0.5.21`; `git tag | grep '@declaragent/cli@'` → up to `@declaragent/cli@0.7.5`.

### P0-2 · Ship templates + fix `fleet add --template` resolution
**Verdict: TRUE for npm installs.** `init` prints `declaragent fleet add --template rpc-server --id pr-reviewer` (`fleet-init-cli.ts:69`). `fleet add` resolves templates via `defaultTemplatesDir()` which walks up to the **repo-root** `templates/` (`fleet-add-cli.ts:134-146`) — works from source, breaks from an npm install because `templates/` is **not** in the `files` array (`packages/cli/package.json:14-21`). Separately, `init-template-unpacker.ts:14-15` is **stub-only** (`// TODO: replace stubs with real templates`).
- **Do:** add `templates` to the cli package `files` array; resolve from the installed package root (not 8-levels-up); finish the stub→real template unpacker.
- **Do:** add an `npm-pack-and-run` CI job: `npm pack` → install the tarball → run `init` → run the exact printed next command.
- **Evidence:** `packages/cli/package.json:14-21`; `packages/cli/src/fleet-add-cli.ts:134-146`; `packages/cli/src/fleet-init-cli.ts:69`; `packages/cli/src/init-template-unpacker.ts:14-15`.

### P0-3 · Make the nightly a hard gate + consolidate failure issues
**Verdict: PARTIAL.** The tooling the review says is missing already exists: `nightly-integration.yml` (Kafka+NATS, daily) and `weekly-soak.yml` (24h Kafka, Sundays) both auto-file tracking issues on failure (`report-failure` job). The real gaps are (a) no policy that the nightly must be green before new features land, and (b) one-issue-per-night creates an unreadable wall.
- **Do:** adopt a green-before-merge rule (fix or quarantine-with-deadline each failing test); switch auto-filing to a single rolling tracker issue with one comment per failure tagged flake-vs-signal.
- **Evidence:** `.github/workflows/nightly-integration.yml` (`report-failure` job), `.github/workflows/weekly-soak.yml`. *Live red/green status not verifiable from the repo — confirm against Actions history.*

### P0-4 · Land `SECURITY.md` + a real disclosure path
**Verdict: TRUE.** No `SECURITY.md` at root or `.github/`. For a runtime shipping hash-chained audit, multi-tenant isolation, OAuth2/OIDC RPC, and secret resolvers, this is table stakes.
- **Do:** add `SECURITY.md` with a `security@declaragent.dev` (or equivalent) disclosure address and a response-time commitment.

### P0-5 · Resolve the pen-test signoff (or demote enterprise claims)
**Verdict: TRUE.** `docs/PEN_TEST_SIGNOFF.md` is a template: Firm/Lead/Window all `TBD`, findings table empty.
- **Do:** either engage a scoped third-party review, or demote "enterprise" positioning until one lands; in the interim, harden `docs/THREAT_MODEL.md` to be CISO-reviewable without an NDA.

### P0-6 · First real users (the only fix that isn't code)
**Verdict: TRUE.** Two stars, zero forks/watchers; every operational primitive has only ever run under the maintainer's own patterns. The features most likely wrong under real load (Kafka soak, multi-tenant fairness, SIEM at 10k tool-calls/s, JetStream at-least-once redelivery) have no production telemetry.
- **Do:** recruit 2–3 early adopters with real workloads; white-glove them. Not schedulable here — owner-driven.

---

## P1 — operational maturity

### P1-7 · Co-maintainer + multi-owner npm/org
**Verdict: TRUE** (206/207 commits one author; AI co-author present but doesn't diversify ownership; no governance doc names a second maintainer). **Do:** recruit ≥1 co-maintainer with publish rights; move npm packages to multi-owner; document AI-authorship transparently.

### P1-8 · Coherent public version
**Verdict: TRUE** (cli 0.7.5, core 0.5.4, channels/sources 4.0.x, root 0.0.0; no `v0.7.x` tag). **Do:** pick the CLI version as the project version and surface it everywhere (`--version`, homepage, docs, release notes), or move to lockstep. Pairs naturally with P0-1's `v<cli-version>` tag.

### P1-9 · Decide the 1.0 contract
**Verdict: TRUE.** All packages pre-1.0; 0.8.0 will flip `rpc.auth.enabled: true` (`docs/ZERO_TRUST_DEFAULT_MIGRATION.md`, real breaking change, preview shipped). **Do:** define the back-compat surface (agent.yaml / fleet.yaml schema, CLI verbs, audit-record schema); cut 1.0 once P0-1/P0-5/P0-6 land — or state "0.x, breaks allowed" plainly on the homepage.

### P1-10 · Consolidate plan docs
**Verdict: TRUE** (36 docs in `docs/`, ~22 plan/backlog; no `docs/STATUS.md`, no `docs/archive/`). **Do:** move pre-0.6.0 plans to `docs/archive/` with a supersession note; add a single `docs/STATUS.md` naming the current plan + backlog + scoreboard. (This file points there once it exists.)

### P1-11 · CI-driven live status
**Verdict: TRUE** (site HTML hardcodes status; no `STATUS.json` written by any workflow). **Do:** have `weekly-soak.yml` (and nightly) write `STATUS.json`; the site reads it so pillar grades move with the real signal.

### P1-12 · Error-message next-action sweep
**Verdict: TRUE.** binary-not-found message (`bin/declaragent.js:85-87`) offers re-run-postinstall / reinstall / manual-download — all presuppose a working pipeline; no source-build or JS-launcher fallback hint. **Do:** 1–2 day sweep so every failure surfaces an action that works even when the pipeline doesn't.

### P1-13 · One published case study
**Verdict: TRUE** (no quote/benchmark/case study from anyone but the maintainer). **Do:** publish one real story with real numbers — the maintainer's own triage agent counts.

---

## P2 — trust & positioning

- **P2-14 · Brand split.** TRUE — both `declaragent` + `d9t` binaries ship (`packages/cli/package.json` `bin`); `docs/website/BRAND.md` itself calls it "indecision." Pick one, 301 the other.
- **P2-15 · Disclose AI authorship** in README/GitHub description, not just CLAUDE.md.
- **P2-16 · Right-size homepage copy** to "thoughtful declarative runtime seeking first adopters," not a Series-A pitch.

---

## Item A — Agent durability ("not just one-cycle single-prompt agents")

**This is the user's explicit second ask. Verified directly. Verdict: the fear is half-right.**

**Within a turn — NOT single-prompt (good).** The engine runs a real perceive→reason→act→observe loop, up to `DEFAULT_MAX_ITERATIONS = 50` tool-use iterations, breaking only when the model returns a non-`tool_use` stop reason. No entrypoint overrides this to 1.
- **Evidence:** `packages/core/src/engine/engine.ts:32` (`DEFAULT_MAX_ITERATIONS = 50`), `:245`, `:335-379` (the loop; `if (response.stopReason !== 'tool_use') break`). Reached by every entrypoint: dispatcher (`dispatcher.ts:185-286`), skills (`skills/runner.ts:54-59`), sub-agents (`tools/agent.ts:68-74`), fleet RPC (`fleet-run-llm-handler.ts:195-229`), REPL (`app.tsx:730-734`).

**Across events — stateless by default (the real gap).** The default inbound route is `{event, skill}` (`channels-runtime.ts:245,287,294`), which hits the dispatcher's `skill` target → `createChildSession(...)` → a **fresh transcript every event** (`dispatcher.ts:227-270`). Fleet RPC is explicitly "stateless between RPCs" (`fleet-run-llm-handler.ts:201-208`). A session-pinned path exists (`target: 'session'`, `dispatcher.ts:185-206`, persistent SQLite store) but is **not** the default. There is **no long-term memory layer** wired into turns (no summarization/recall; only the in-session transcript + the inter-agent mailbox).

So a spun-up agent today is a **stateless reactive** unit: it reasons over many steps for one event, then forgets. That's correct for pure event handlers, wrong for "an ongoing agent that builds context."

**Do (recommended, in order):**
1. **Session pinning for inbound routes.** Let a route declare a `sessionKey`/`conversationId` (e.g. per Slack thread, per tenant, per entity) so repeated events resolve-or-create the *same* durable session and accumulate context. Infra already exists — persistent session store + `target: 'session'`; this is wiring + route-config, not new subsystems.
2. **Memory layer (optional, opt-in).** Long-term store with `recall`/`store` tools or turn-start context injection, plus transcript summarization/pruning to stay within `maxTokens`.
3. **Make multi-step observable.** Surface `maxIterations` in `agent.yaml` and emit an iterations-per-turn metric/log so operators can confirm agents actually take multiple steps and tune the cap.
4. **Document the three modes** (stateless-reactive / session-pinned / durable-with-memory) so users pick deliberately instead of inheriting "fresh every time" silently.

---

## Suggested sequencing (mirrors the review's 90-day shape)

- **Now (days 1–14):** P0-1, P0-2, P0-3, P0-4, P1-10. These are days of work and unblock everything downstream.
- **Foundation (days 15–45):** P0-5, P1-7, P1-8, P1-11, P1-12, and **Item A step 1** (session pinning — the highest-leverage durability fix).
- **Earn the label (days 46–90):** P0-6, P1-9, P1-13, P2-16, plus **Item A steps 2–4**.

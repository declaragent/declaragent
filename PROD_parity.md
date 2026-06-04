# Declaragent — Production-Readiness Study

**Date:** 20 May 2026
**Subject:** declaragent / d9t.dev — `@declaragent/cli@0.7.5`, `@declaragent/core@0.5.4`
**Scope:** What it would take to honestly call this "production-ready."

---

## TL;DR

Declaragent is a substantive piece of engineering (~155k LOC, 44% test ratio, sound primitives) wrapped in production-grade marketing that the project itself doesn't yet earn. The internal documentation is candid about this — the USABILITY_PLAN.md openly admits the test-your-agent journey was marked ❌ as recently as a few releases ago — but the public-facing site frames the product two or three releases ahead of its operational reality.

To genuinely deserve the "production AI agents" tagline, the project needs roughly three things in this order: a working install + release pipeline, a CI signal anyone can trust, and at least one real user in production who isn't the maintainer. Everything else — pen test, SemVer, dashboards, Grafana JSON — is downstream of those three.

Estimated work: ~90 focused days to clear P0, another 60–90 days for P1, then a 6–12 month adoption flywheel that no roadmap can compress.

---

## Methodology

What I actually looked at:

- Cloned the repo at HEAD on main (14 MB, 144 commits).
- Counted code and tests across all 13 packages: 154,679 LOC source, 68,000 LOC test, 272 test files.
- Verified each cited PR on the homepage exists and was merged (spot-checked #10, #13, #14, #17, #18, #20–24).
- Ran the actual `npm i -g @declaragent/cli` install on a fresh sandbox.
- Walked the GitHub release pipeline (`release.yml`, `release-binaries.yml`, `npm-install-smoke.yml`, `installer-smoke.yml`) to understand why install fails.
- Read the maintainer's own assessment docs: `POST_ENTERPRISE_BACKLOG.md`, `USABILITY_PLAN.md`, `PEN_TEST_SIGNOFF.md`, `FIRST_PRINCIPLES_AUDIT.md`, `THREAT_MODEL.md`, `POST_DEMO_BACKLOG.md`.
- Sampled critical code paths: `audit/chain-verify.ts` (hash chain), `audit/sqlite-sink.ts`, `mcp/supervisor.ts`, the postinstall shim.
- Reviewed the 32 currently open issues and the pattern of nightly CI failures from May 10–20, 2026.

---

## What's genuinely good

This needs to be said up front, because the criticism that follows is sharper than the praise but the praise is the larger surface area.

The core abstractions are well-chosen and the code that implements them is clean. The audit chain is a textbook hash-chained SHA-256 implementation with deterministic JSON canonicalization, tombstone-aware verification, and proper separation between content and continuity (you can verify the chain after a GDPR erase without seeing the erased PII). The permission gate, multi-tenant isolation, secret resolver abstraction, and MCP supervisor are all designed around clear contracts that look easy to extend without breaking.

Test coverage is real, not theater. A 44% test-to-source ratio is healthy, and the test files I sampled are scenario-driven (back-compat asserts, decode-fail policies, drain-supersede races) rather than line-counting unit tests. The PR descriptions are unusually thorough — PR #23 spells out the architectural choice (hand-rolled validator vs AJV), the back-compat contract, the test plan, and three open questions that landed as deferrals. That's the level of rigor you'd expect from a mature open-source project.

The "honest status" framing is partially earned. Pillar 3 is in fact marked ◐ on the website, capability schema-violation auditing PR explicitly defers production wiring to a follow-up, and the internal backlog tracks 52 numbered items with status, owner, and PR evidence. Internally, the team behaves like adults who know what isn't done.

The conceptual frame — agent.yaml in your repo, git as the source of truth, plain CLI for everything — is genuinely differentiated against LangGraph (Python notebook ergonomics) and the various agent-framework SaaS products. The "no hidden console, no vendor dashboard" pitch is technically true and culturally important.

---

## P0 — Blockers that prevent any production use

### 1. The install pipeline is broken in production

The headline command on the homepage — `npm i -g @declaragent/cli` — does not produce a working CLI on a clean machine. The root cause is a CI pipeline mismatch I traced end-to-end:

- The npm postinstall (`packages/cli/bin/postinstall.js`) tries to download a single-file binary from `github.com/declaragent/declaragent/releases/download/v0.7.5/declaragent-linux-x64.tar.gz`. That URL returns 404.
- `release-binaries.yml`, which is the only workflow that builds those binaries, triggers `on: push: tags: ['v*']`.
- The actual release flow is `release.yml`, which runs changesets. Changesets creates per-package tags like `@declaragent/cli@0.7.5`, not `v0.7.5`. So `release-binaries.yml` has never fired for a real release.
- `installer-smoke.yml` and `npm-install-smoke.yml` both pass in CI because they stage binaries against a fake `v0.0.1-smoke` tag served from a local Python HTTP server. They verify the install code path can install if the binary exists; they never verify that the production pipeline actually publishes the binary.

The launcher has a hidden Bun fallback (`bin/declaragent.js` prefers `bun dist/index.js` if Bun is on PATH), which is the only reason users with Bun installed haven't filed this as a bug. Users without Bun get `declaragent: binary not found` and stop here.

**Fix:** Either change `release-binaries.yml` to trigger on the `@declaragent/cli@*` tag pattern, or make `release.yml` cut a `v<cli-version>` tag after each CLI publish. Add a CI job that does a true end-to-end `npm i -g @declaragent/cli` from the actual published npm registry against the actual GitHub release — not a local file mirror. This is half a day of work; it has gone undetected for months because no real user has tried it.

### 2. The first command suggested by `declaragent init` doesn't work

After scaffolding a fleet, the CLI prints `declaragent fleet add --template rpc-server --id pr-reviewer` as the next step. Running it errors with `template "rpc-server" not found at /home/.../node_modules/templates/rpc-server` — the path lookup is one level too high (missing `@declaragent/cli/` prefix), and the `templates/` directory isn't shipped in the npm tarball at all. So a user who manages to get past install hits a wall on the next command.

**Fix:** Ship `templates/` in the npm `files` array (currently lists `dist`, `bin/declaragent.js`, `bin/postinstall.js`, `bin/README.md`, `README.md`, `LICENSE` — no templates). Fix the resolution path in `init-template-unpacker.js` to look relative to the package root, not two-levels-up. One afternoon of work, and an `npm-pack-and-run.yml` CI job that runs `init` then the printed next command would have caught this.

### 3. CI signal is meaningless because no one triages failures

Every open issue on the repo is a bot-filed CI failure. The `nightly fleet-integration` workflow has failed every single night from at least May 10 to May 20, 2026 — issues #84 through #95, one per night. The weekly Kafka soak failed on May 17 (#91). No human assignee, no comments, no PR linked.

This is the broken-windows pattern. When the test suite goes red and stays red, "the tests pass" stops meaning anything, and every subsequent green run is just selection bias. The site's claim of "Every ✓ has a test" is technically true but operationally meaningless if those tests are red on the main branch and nobody is paying attention. It also directly invalidates the website's Pillar 3 status: the homepage marks Pillar 3 as ◐ partial pending the Kafka soak going green, and the most recent Kafka soak failed.

**Fix:** Adopt a non-negotiable rule that the nightly must be green before any new feature lands. Either fix the underlying flakes or quarantine the failing tests with a tracked deadline. Auto-filing fresh issues per failure was supposed to keep visibility high; in practice it has produced a wall of issues that all look identical and nobody reads. Switch to a single rolling tracker issue with a comment per failure and an open question: is this flake or signal?

### 4. The pen test signoff is a template

`docs/PEN_TEST_SIGNOFF.md` is a placeholder. Firm: TBD. Lead reviewer: TBD. Engagement window: TBD. Findings table: empty. For a runtime that ships hash-chained audit, multi-tenant isolation, OIDC/OAuth2 on RPC envelopes, control-plane HTTP auth, secret resolvers for Vault/AWS-SM/GCP-SM, and a webhook surface across five external platforms — and that positions itself for "the ops team, not just the prompt engineer" — shipping with zero third-party security review is a category mismatch.

**Fix:** Either engage an actual firm (rough budget: $20k–$60k for the scope described in the document) or quietly demote the enterprise positioning until you do. The intermediate version is documenting the threat model honestly enough that a CISO could review without a NDA; `docs/THREAT_MODEL.md` exists but I'd want a security-focused engineer to read it carefully before accepting it as a substitute.

### 5. Zero production users

Two GitHub stars, zero forks, zero watchers. No discussions, no external contributors, no case study, no benchmark from anyone other than the maintainer. This is not just a marketing problem — it means every operational primitive in the codebase has only ever been exercised by the author's own usage patterns, which are heavily biased toward what the author already knew to build.

The features that look most likely to be wrong in subtle ways under real load — the Kafka soak (already failing), the multi-tenant fairness under per-tenant quotas, the SIEM exporter under genuine 10k tool-calls/sec, the JetStream at-least-once redelivery with mixed handler-throw + decode-fail patterns — are also the features for which there is no production telemetry from anywhere except the test suite.

**Fix:** This isn't a code change. It's a six-to-twelve-month adoption flywheel that has to start with finding two or three early users with real workloads and giving them direct white-glove support. A side benefit: those users will find the next ten bugs no amount of test writing would have caught.

---

## P1 — Operational maturity gaps

### 6. Bus factor is one

The npm publisher field on every package resolves to `gatolgaj@gmail.com`. Almost every commit is co-authored `Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Three observations:

- One human means one point of failure for security disclosures, NPM publish keys, and the github org. There is no `SECURITY.md` in the repo, no `security@declaragent.dev` mailbox, no documented disclosure process.
- AI-generated code under one-person review means the maintainer's review process is the entire quality bar. This isn't disqualifying — the code I read is clean — but it does mean that a reviewer-fatigue regression would be invisible until production users found it.
- For an "enterprise primitives" positioning, vendors want to know "if the maintainer disappears tomorrow, who continues this?" The current answer is "nobody."

**Fix:** Recruit at least one co-maintainer with publish rights. Document the disclosure process. Move the npm packages under an org account with multiple owners. Publish a transparency note about AI involvement in code authorship — it's not a scandal, but it should be disclosed.

### 7. Versioning is incoherent at the user level

The website headline is "v0.7.1 shipped 2026-04-23." There is no `v0.7.1` git tag. The CLI on npm is 0.7.5. Core is 0.5.4. Channels are 4.0.0. Plugin-agent-rpc is 4.0.3. Source-* are 4.0.0. There's no project-level CHANGELOG; only per-package ones. A user asking "what version of Declaragent am I on?" has no good answer.

**Fix:** Adopt either lockstep versioning across all packages (every release bumps every package to the same version, even when source didn't change) or pick the CLI version as the project version and surface that everywhere — `declaragent --version`, the homepage banner, the docs site, the release notes. Right now the project is using changesets-style independent versioning, which is correct internally but creates a confusing public surface for a product that wants to be perceived as a single thing.

### 8. No 1.0 means no SemVer guarantees

The whole project is in the 0.x territory where `0.7 → 0.8` is technically allowed to break everything. The roadmap suggests 0.8.0 will flip `rpc.auth.enabled: true` as a default — a real breaking change with a migration doc. Doing breaking changes is fine; doing them under a 0.x version is a way to avoid promising back-compat to anyone who's depending on you.

**Fix:** Decide what the 1.0 contract is. Either commit to back-compat for a defined API surface (agent.yaml schema, fleet.yaml schema, the CLI verbs, the audit record schema) and cut 1.0 once the install pipeline + pen test + early adopters are in place, or stay 0.x but say so explicitly on the homepage. "Production AI agents" and "0.7.x with breaking changes any time" don't sit well together.

### 9. The plan-doc cardinality is a maintenance hazard

`docs/` contains 38 markdown files, of which roughly 20 are some form of plan: PHASE_2_PLAN, PHASE_3_PLAN, ... PHASE_7_PLAN, MASTER_PLAN, IMPLEMENTATION_PLAN, ENTERPRISE_PRODUCTION_PLAN, CONTROL_PLANE_PLAN, FLEET_PLAN, BUILDER_PLAN, AGENT_RPC_PLAN, PATCH_0_5_2_PLAN, RELEASE_0_6_0_PLAN, POST_ENTERPRISE_BACKLOG, POST_DEMO_BACKLOG, etc. The plans are clearly the artifact of an AI-assisted workflow where every release cycle generates a planning document, but they aren't being consolidated.

A new contributor (or a security reviewer, or an evaluator at a prospective adopter) doesn't know which plans are current, which are historical, and which were superseded. The internal scoreboard implies post-enterprise-backlog is the current source of truth, but you have to read several other documents to know that. POST_DEMO_BACKLOG.md says outright "Local-only (the `docs/` dir is gitignored)" — meaning some of these plans weren't even intended to be public, but the gitignore must have changed at some point.

**Fix:** Move historical plans to `docs/archive/` with a one-line note explaining what superseded them. Have a single `docs/STATUS.md` that names the current plan, the current backlog, and the current scoreboard. Mark anything pre-0.6.0 as historical context. This is two hours of work that would make new-contributor onramp dramatically easier.

### 10. The "honest status" lives on marketing, not in a live dashboard

The Pillar 3 status, the 12/12 enterprise scorecard, the cited PRs — these are baked into the homepage HTML. When the weekly Kafka soak fails (as it did on May 17), the homepage doesn't know. There's no automatic flip from ◐ to ✗ when CI goes red.

**Fix:** Build a real status page driven by CI artifacts. `weekly-soak.yml` should write a `STATUS.json` to a known location; the marketing site reads that at build time or at request time. The user-visible label moves with the actual signal. This is the truest version of "receipts-first."

### 11. Error messages do not lead users to the next action

When the postinstall fails to download the binary, the error message is: "declaragent: binary not found. Re-run the postinstall step: node \"...postinstall.js\" (or reinstall: npm install -g @declaragent/cli). If you set DECLARAGENT_NO_POSTINSTALL=1, re-run without it, or download the binary manually from https://github.com/declaragent/declaragent/releases."

Every option in that message leads to a dead end if the underlying release pipeline is broken. The principle from the project's own USABILITY_PLAN.md ("every failure mode surfaces the next action") isn't being followed at the entry-point error a new user hits first.

**Fix:** Audit every error message in the CLI for "is there a next action the user can actually take here?" The list isn't long; this is a 1–2 day sweep.

### 12. No public adoption metrics, no benchmarks, no case study

The site says "production AI agents" without a single quote, link, or screenshot from anyone running a production AI agent on it. For prospective users evaluating against LangGraph or CrewAI, the absence of "this team uses it to triage N issues per day" is a deafening tell.

**Fix:** Recruit one early adopter who will let you publish their story. Even a personal-project case study (the maintainer's own GitHub-triage agent, with real numbers) is better than the current zero.

---

## P2 — Trust and positioning

### 13. The brand split (Declaragent vs d9t) is a friction tax

The domain is d9t.dev, the package scope is `@declaragent/*`, the homepage title is "Declaragent — d9t," the CLI binaries are both `declaragent` and `d9t`. Either name on its own is fine; the split signals indecision. Pick one and let the other be a 301.

### 14. AI involvement should be disclosed, not buried

Almost every commit is co-authored "Claude Opus 4.7 (1M context)." The project description on GitHub doesn't mention this; the README doesn't mention this. The CLAUDE.md and AGENTS.md files in the repo make it obvious to anyone who clones, but a casual visitor won't see it. For an AI agent runtime, "this runtime was built primarily by an AI agent" is either a great narrative or a great risk depending on how it's framed — but it should be framed, not hidden.

### 15. Marketing copy is two releases ahead of the product

The site says "Production AI agents, declared in your repo." Internal USABILITY_PLAN.md marks J3 (test your scaffolded agent against real input and see output) as ❌ with no path — yes, this has likely been fixed in 0.7.x, but the gap between "we have built genuinely solid primitives that are 18 months from production-ready" and "production AI agents" is the kind of overclaim that turns evaluators into skeptics permanently.

**Fix:** Rewrite the homepage from the perspective of where the project actually is: an unusually thoughtful declarative runtime, with serious primitives, looking for first adopters. The current copy reads like a Series-A pitch deck for a product that has thousands of users; the substance reads like a 0.7 OSS project with zero. The mismatch is loud.

---

## Strategic concerns

### The market is brutal

LangGraph, CrewAI, AutoGen, OpenAI's Agents SDK, Anthropic's own MCP, Cloudflare Workers AI agent toolkits, n8n's AI nodes. Most of those have employer backing, real users, and visible feedback loops. Declaragent has a clear differentiator (declarative + git-versioned + Apache-2.0 + no SaaS) but no traction to prove the differentiator matters. The window for a solo project to define this category is narrow.

### AI-generated code at this scale is an unsolved governance question

154k LOC, 272 test files, almost all of it co-authored by an LLM. The codebase is clean — I read enough to say so — but the question of "how does one human keep up with that volume of AI-generated code" matters for production-readiness because it determines whether a critical security finding ten months from now gets a fix in a week or in a quarter.

### The honest path forward is narrower than the current pitch

If the project leaned into "ambitious open-source experiment in agent runtime design, built primarily by Claude with one human reviewer, looking for early adopters" — it would attract a different and probably better audience than "production-ready enterprise agent platform." The first framing is exciting; the second invites scrutiny the project can't yet survive.

---

## Recommended 90-day roadmap

A prioritized list that, if completed, would let the project honestly remove the ⚠ from the install row of its own USABILITY_PLAN and start telling early adopters "yes, you can run this."

### Days 1–14 — Stop the bleeding

1. Fix the release pipeline (cut binaries on the right tag).
2. Fix `fleet add --template` and ship templates in the npm tarball.
3. Add a real `npm i -g`-from-npm-registry CI job that runs against the actual GitHub release.
4. Triage the 10+ days of nightly failures; either fix or quarantine each.
5. Land a `SECURITY.md` with a disclosure address.
6. Move historical plan docs to `docs/archive/` and add a `docs/STATUS.md`.

### Days 15–45 — Foundation

7. Engage a third-party security review (even a small-scope one).
8. Recruit one co-maintainer with publish rights.
9. Adopt lockstep versioning or align all packages on the CLI version for public messaging.
10. Build a live status page driven by CI artifacts; let the homepage's pillar grades reflect actual nightly results.
11. Sweep every CLI error message for "does this lead to a next action?"

### Days 46–90 — Earn the label

12. Find two or three early adopters; embed with them for two weeks each.
13. Publish a real case study with real numbers.
14. Cut 1.0 with a clearly defined back-compat surface, contingent on (12) actually happening.
15. Rewrite the homepage to match where the product is, with the pen test as supporting evidence and the early adopter as the headline.

### Beyond 90 days

16. Earn or abandon the "enterprise" framing. If you keep it, you need at least one paying or named enterprise user, SOC 2 work, and a support model.
17. Decide whether the AI-coauthor framing is a strength to lean into or a liability to manage; either way, stop hiding it.

---

## Verdict

The substance is real, the rigor on the inside is unusually high, and the underlying ideas are good. The gap to "production-ready" is mostly not engineering — most of the engineering is done. The gap is in the pipeline that turns engineering into something a user can install, the social signal that turns code into something a user can trust, and the positioning honesty that turns a 0.7 OSS project into the right kind of bet for the right kind of adopter.

If the maintainer is willing to rewrite the homepage to match the actual maturity, fix the release pipeline this week, and spend the next quarter chasing two real users rather than building Pillar 4 → ✓, this project could be genuinely production-ready inside 12 months. If the marketing is allowed to keep running ahead of the substance, it'll stay where it is now: technically impressive, socially invisible, and one bad nightly away from looking like a hobby.

The kindest thing anyone could do for this project right now is to file an issue titled "I tried `npm i -g @declaragent/cli` on a clean machine and it failed" and force the bug into daylight. That single issue, properly triaged, would unblock everything else on this list.

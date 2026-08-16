# LAUNCH_PLAN.md

Go-to-market plan for Declaragent's first public launch. Scope: the announcement moment and the four weeks on either side of it. Not a product roadmap — that lives in `SPEC_AND_PLAN.md` and `POST_ENTERPRISE_BACKLOG.md`.

> Status anchor (refreshed 2026-08-16): `@declaragent/cli@0.7.6` live on npm. Single-machine ready; **enterprise partial** — see CLAUDE.md's accuracy note + the AGENTS.md evidence ledger (the earlier '5/5 pillars green' framing was overstated).

---

## 1 · Ship-gate checklist

These must be true before we press the button. No announcement scheduled until every box is checked.

- [ ] **License decision locked.** `LICENSE` + `README.md` say Apache 2.0; `SPEC_AND_PLAN.md` §Part 7 still lists it as open. Reconcile the spec (or change the LICENSE file) — don't launch with a public disagreement.
- [ ] **Product-name row removed from Part 7.** Declaragent is the canonical name (npm scope + domain + org all claimed). Spec is stale here.
- [ ] **Commercial-model one-liner on the website.** Even "open-core CLI + runtime; managed control plane in private beta Q3 2026" is enough. Investors and hiring funnels will ask Day 1.
- [ ] **3 design partners in active use.** Per `SPEC_AND_PLAN.md` Part 7, biased toward teams with "laptop script" pain. Launch without this and the Show-HN thread becomes vapor.
- [ ] **Kafka 24h soak** — 3+ consecutive Sunday greens on the bar before claiming Pillar 3 enterprise-ready publicly. 7 is the stated goal; 3 is the launch minimum.
- [ ] **#51 Grafana dashboard bundle** shipped. It's the only artifact that turns "we have the counters" into a screenshot for the launch post.
- [ ] **Getting-started video** (≤4 min) recorded against the actual CLI, not a slide deck. `declaragent init` → `up -d` → webhook fires → Slack reply.
- [ ] **Pricing page.** Even "Free. Managed control plane pricing TBD" is better than a 404.
- [ ] **Status page** (declaragent.dev/status or statuspage.io) — only needed once the managed plane lands, but register the subdomain now.
- [ ] **Incident comms playbook.** Who responds if the launch post surfaces a P0? One rotating phone number, not a mailing list.

## 2 · Positioning

One-liner (working draft, verify with design partners before freezing):

> *Declaragent is a declarative, git-versioned platform for building and operating fleets of AI agents. One agent builds the others.*

**Wedge against adjacent tools** — honest framing, not combat:

| They solve | We solve | When to pick us |
| --- | --- | --- |
| LangGraph / CrewAI: author one agent | Define + deploy + observe **a fleet**, plus the builder-as-agent | You have >1 agent in prod |
| Temporal / Inngest: durable workflow engine | Agent-native runtime (MCP, channels, audit, secrets) on top of a durable core | Your workflow *is* an LLM + tools |
| n8n / Zapier: no-code event glue | Declarative YAML in your repo, reviewable in PR, `fleet render` to K8s | You want agents under GitOps |
| Claude Code / Cursor: coding agent | Production long-running agents answering webhooks, cron, brokers | The agent runs without a human at the keyboard |

The defensible claim is Pillar 5: **the builder is itself an agent**, recorded-conversation fixtures included. Lead with that.

## 3 · Launch sequence (T-minus)

Calendar-driven; adjust around a Tue/Wed launch day for HN traffic.

- **T−4 weeks** — finalize Section 1 gate list. Freeze positioning with 3 design partners. Start recording the getting-started video.
- **T−3 weeks** — private beta invite to ~30 hand-picked operators (not influencers). Collect quotes. Ship #51 dashboard.
- **T−2 weeks** — publish 3 deep technical posts on declaragent.dev: *(a)* the builder-as-agent pattern, *(b)* audit hash-chain + SIEM back-pressure under load, *(c)* the `fleet.yaml` → K8s render flow. These become the HN comment ammunition.
- **T−1 week** — soft-launch via Changelog + X + LinkedIn from the maintainer account only. No paid. Watch for P0s.
- **T−0 (Tue/Wed, 08:00 PT)** — Show HN. Design partners pre-warned to comment with their actual use cases (not "great launch!"). X thread. LinkedIn post. Email list.
- **T+1 day** — respond to every HN comment within 1 hour for the first 8 hours. Write the "what we got wrong" post within 72 hours if the critique is valid.
- **T+1 week** — Product Hunt (secondary; their audience is not ours — do it for SEO backlinks, not traffic).
- **T+2 weeks** — one long-form guest post (The New Stack / InfoQ / Pragmatic Engineer — pick one, not three).

## 4 · Surfaces (ranked by leverage)

1. **Show HN** — primary. The audience reads `CLAUDE.md`-style honesty.
2. **X / Bluesky thread** — maintainer account, 8–12 posts, each a concrete capability with a code block, not marketing.
3. **r/LocalLLaMA** — high signal, expects evidence; post after HN traction, never before.
4. **LinkedIn** — where the enterprise buyers actually are. Tone: shorter than X, no jokes.
5. **Dev.to / Hashnode cross-post** — cheap SEO.
6. **Product Hunt** — SEO, not traffic. Skip if launch week is busy.
7. **YouTube Short** (≤60s, the webhook → Slack demo) — for the LinkedIn embed.
8. **Hacker Newsletter / TLDR / Pointer** — paid placements only after organic HN result is known.

Skip on Day 1: paid ads, conference CFPs, podcast circuit. All three are post-launch work.

## 5 · Design-partner outreach

Target profile: 2–10 person platform teams already maintaining a fragile cron → webhook → Slack pipeline in Python. Avoid hobbyists (they won't give feedback); avoid F500 (procurement will eat 6 months).

Outreach list to assemble before T−4 weeks:
- 15 names from `homebrew-tap` stargazers + existing GitHub issue commenters.
- 10 names from conference attendee lists (KubeCon, AI Eng Summit).
- 5 names from personal network.

Ask format: *"20 min call, I'll scaffold a working agent for your real pipeline by end of the call, no deck."* Conversion target: 30 contacts → 10 calls → 3 partners.

## 6 · Open decisions still blocking launch

Ranked by urgency:

1. **License reconciliation** (`SPEC_AND_PLAN.md` §Part 7 vs `LICENSE`). 15-minute fix.
2. **Commercial model public copy** — one sentence on pricing page.
3. **Who owns incident response** if the launch post surfaces a CVE.
4. **0.8.0 zero-trust flip timing** (see `docs/ZERO_TRUST_DEFAULT_MIGRATION.md`). If the flip ships the week of launch, launch post must cover it. If it ships 4+ weeks after, leave it out.
5. **Governance** — defer per spec. Non-blocker for launch.

## 7 · Post-launch gates

- **Week +4**: decide on paid HN / newsletter placements based on organic numbers.
- **Week +6**: first KPI review — npm installs, fleet-starter clones, GitHub stars *ignored*; usable metric is `declaragent up` invocations beyond the first 10 min (requires opt-in telemetry, which is itself an open question).
- **0.8.0 ship** — zero-trust flip. Separate launch moment (blog post + migration webinar), not bundled with 1.0.
- **1.0.0** — only after 3 design partners run fleets in prod for 90 days without a P0 that isn't in `docs/POST_ENTERPRISE_BACKLOG.md`.

## 8 · What this plan is not

- Not a marketing plan. Budgets, ad creative, SEO strategy — separate doc when we hire for it.
- Not a product roadmap. `SPEC_AND_PLAN.md` + `POST_ENTERPRISE_BACKLOG.md` are canonical.
- Not a fundraising plan. Different document, different audience.
- Not permission to soften the honesty in `FIRST_PRINCIPLES_AUDIT.md` / `AGENTS.md`. Evidence-based claims only; if a pillar regresses, the launch post reflects it.

# Declaragent — brand system

This is the single source of truth for how Declaragent looks, sounds,
and behaves across the website, docs, social, CLI output, and
swag. Read before designing, writing, or shipping anything public.

---

## 1 · Brand thesis — receipts-first

> Every infra platform promising "AI agents in production" overclaims.
> Declaragent's only durable moat is evidence-based honesty. Make
> receipts the product of the brand.

**What this means concretely:**

- Every capability claim carries a receipt — a `file:line` pointer, a
  commit SHA, a test name, an AGENTS.md anchor.
- Every claim gets a status chip: **✓ shipped** (has a test),
  **◐ partial** (scoped gap named), **○ tracked** (in the plan, not
  started).
- The word "enterprise-ready" is forbidden. Replace with graded rows.
- The word "revolutionary" is forbidden. Replace with receipts.

If a competitor copies our visual language, they have to actually
publish evidence. They won't, because they can't.

---

## 2 · Voice

### Do

- **Technical, specific, receipts-first.** *"Circuit breaker trips on
  10 consecutive failures, 30-s cooldown, half-open probe re-closes —
  see `core/src/breaker.ts:42`."*
- **Understated confidence.** "Ships 0.7.1 today" beats "proud to
  announce our revolutionary new release."
- **Irreverent to hype, reverent to craft.** Mock vibes-marketing;
  respect systems thinking.
- **Honest about gaps.** If a pillar is ◐, say ◐. Naming the gap out
  loud is what builds trust faster than anything else.

### Don't

Forbidden words — do not use, even in release notes or blog posts:

`revolutionary` · `game-changing` · `unlock` · `empower` · `seamless` ·
`democratize` · `best-in-class` · `enterprise-ready` · `cutting-edge` ·
`next-generation` · `innovative` · `synergy` · `AI-powered` (as a
modifier — if everything's AI-powered, nothing is) · `journey` (unless
describing an actual event stream) · `excited to announce` ·
`reimagine`.

### Sentence rhythm

- Short. Varied. Occasional semicolons; earned em-dashes.
- Title ≤ 65 chars. Lede ≤ 30 words. Every paragraph stands alone.
- No "In today's AI landscape…" openers. Start with the specific
  fact.

---

## 3 · Shortform / longform CLI

Two aliases, same binary, both ship from `@declaragent/cli`:

| Form | Usage |
| --- | --- |
| `declaragent` | Canonical. Use in docs, READMEs, blog posts, SEO. |
| `d9t` | Dev-friendly. Use in social, swag, URL shorteners (d9t.dev), CLI-reference code blocks alongside the long form. |

**Rules:**

- First mention in any piece of content: `Declaragent` (for search + recall).
- First code block of a page: show both forms side-by-side.
  ```bash
  declaragent up      # or: d9t up
  ```
- Subsequent blocks: pick one and stick.
- **Never** use `d9t` in isolation without establishing the
  Declaragent connection on the same page — it's a numeronym
  (d-e-c-l-a-r-a-g-e-n-t → nine letters between d and t), but
  brand-invisible to cold readers.
- Social handles: claim `@declaragent` and `@d9t` on every platform.
  Post primarily from `@declaragent`; `@d9t` amplifies.
- Numeronym origin: same family as `k8s`, `i18n`. Keep it lowercase.

---

## 4 · Visual system

### 4.1 Palette

The entire site uses **12 values, no exceptions.** If you need a new
color, escalate before adding.

| Token | Hex | Use |
| --- | --- | --- |
| `--bg` | `#0b0e14` | Page background |
| `--bg-elev` | `#12161f` | Cards, chips |
| `--bg-elev-2` | `#1a1f2b` | Hover state, nested surfaces |
| `--border` | `#242b3a` | Subtle outline |
| `--border-strong` | `#323a4d` | Buttons, separators |
| `--fg` | `#e6eaf3` | Primary text |
| `--fg-muted` | `#9aa3b5` | Body prose |
| `--fg-dim` | `#6b7486` | Tertiary, metadata |
| `--accent` | `#5eead4` | Teal brand mark |
| `--accent-strong` | `#2dd4bf` | Hover accent |
| `--ok` | `#4ade80` | ✓ shipped |
| `--warn` | `#fbbf24` | ◐ partial / 🟡 |
| `--danger` | `#f87171` | ✗ errors, finding chips |

**Accent gradient** (for headline accents + brand marks):
`#5eead4` → `#2dd4bf` → `#93c5fd` (left to right, 0%, 60%, 100%).

Dark mode is the default and, for now, the only mode. Light mode can
follow once the palette is proven on every surface.

### 4.2 Typography

- **Display + UI:** Inter (400 / 500 / 600 / 700 / 800).
- **Monospace, CLI, chips:** JetBrains Mono (400 / 500 / 600 / 700).

**Scale:**

| Role | Font | Weight | Size | Letter-spacing |
| --- | --- | --- | --- | --- |
| H1 hero | Inter | 800 | `clamp(36, 5vw, 64)` | `-0.022em` |
| H2 section | Inter | 700 | `clamp(28, 3.5vw, 44)` | `-0.02em` |
| H3 card | Inter | 700 | 17–20 | `-0.01em` |
| Body | Inter | 400 | 16 | `0` |
| Lede | Inter | 500 | 18 | `0` |
| Mono chip | JBM | 500 | 11–13 | `0.04–0.08em` |
| Eyebrow | JBM | 500 | 12.5 | `0.06em` uppercase |

Webfonts load from Google Fonts with `preconnect`; downstream PDFs
and print assets flatten to paths.

### 4.3 Logo mark

- 32×32 or scaled; rounded square (6px radius), accent fill, lowercase
  `d` glyph in JetBrains Mono 700 centered.
- The mark is *always* paired with the wordmark `declaragent` on web.
- On swag and social avatars, the mark alone is permitted (the
  wordmark is lost at small sizes).

**Don't:**
- Don't recolor the mark unless following the palette tokens above.
- Don't rotate or skew.
- Don't use the `d9t` numeronym as a logo mark — it's a verbal alias,
  not a visual one.

### 4.4 Receipts + status chips — the brand signature

These are the single most distinctive element of the system. Use
them liberally. If competitors copy anything, it'll be this (and
they can't without being as honest).

**Status chip** (shipped / partial / tracked):
```html
<span class="status status--ok">✓ shipped</span>
<span class="status status--wip">◐ Kafka soak pending</span>
<span class="status status--todo">○ scoped · not started</span>
```

**Receipt chip** (evidence pointer):
```html
<span class="receipt">
  <span class="receipt__ok">✓</span>
  <code>AGENTS.md:127</code>
</span>
```

**Rules:**
- Every pillar card on the site has at least one ✓ and one ◐ chip.
- Every blog post making a capability claim links to a receipt.
- Every release post carries a chip diff — which rows flipped ◐→✓
  this release.

### 4.5 Surfaces and shadows

- Card radius: 12 px (`--radius`). Large surface radius: 18 px
  (`--radius-lg`).
- Shadow tokens: `--shadow-lg: 0 12px 40px -8px rgb(0 0 0 / 0.5), 0 2px 8px rgb(0 0 0 / 0.25)` — only on hero terminal and meta inner. Don't shadow everything.
- Borders are the default elevation cue, not shadows. Hover →
  `border-color: var(--accent-dim)`.

### 4.6 Motion

- Hover transitions: 150 ms for color, 200 ms for transform.
- Entrance animations: single IntersectionObserver fade-in on
  `main > section`, 700 ms, `cubic-bezier(0.2, 0.6, 0.2, 1)`.
- **Respect `prefers-reduced-motion`.** The CSS guard is in
  `styles.css`; if you add new motion, wrap it in the media query.
- No parallax. No scroll-jacked video. No auto-playing sound.

---

## 5 · The OG image

See [`website/OG_IMAGE_SPEC.md`](./OG_IMAGE_SPEC.md) for the detailed
1200×630 brief. `og.svg` ships today; replace with `og.png` once a
designer produces it.

Per-release variants: regenerate with the new version in the pill
and one headline change (e.g., "NATS transport shipped"). A
`scripts/og-gen.ts` can automate this once the pattern stabilizes.

---

## 6 · Copy templates

### 6.1 One-liner

> *The declarative runtime for AI agent fleets. One `agent.yaml`.
> `git log`. Production.*

### 6.2 Elevator (≤ 60 words)

> Declaragent is an open-source declarative runtime for AI agent
> fleets. Write `agent.yaml`, commit it, run `declaragent up`. You
> get Prometheus, OpenTelemetry, audit chain, circuit breakers, rate
> limits, canary deploys, multi-host RPC, OIDC/OAuth2, SIEM export,
> GitOps render — all in the box. Single-machine + enterprise both
> shipped (12/12 items, v0.7.1). Every capability has a file:line
> receipt. No "contact sales," no vibes.

### 6.3 Tweet / Bluesky (≤ 280 / 300 chars)

> Stop shipping agent prototypes.
>
> Declaragent is the declarative runtime for AI agent fleets. One
> `agent.yaml`. `git log`. Production.
>
> Prometheus + OTel + audit chain + OIDC + SIEM + GitOps in the box.
>
> ✓ single-machine · ✓ enterprise (12/12 shipped, v0.7.1)
>
> d9t.dev

### 6.4 Newsletter blurb (≤ 120 words)

> Declaragent (v0.7.1 shipped 2026-04-23) is the declarative runtime
> for AI agent fleets. Write an `agent.yaml`, commit it, run
> `declaragent up` — you get Prometheus, OpenTelemetry, audit chain,
> circuit breakers, per-tool rate limits, dispatch DLQ, canary deploys,
> multi-host Kafka + NATS RPC, OIDC/OAuth2, SIEM export to Splunk /
> Elastic / Datadog, and GitOps `fleet render` without a single extra
> config file. The distinguishing move: every capability on the
> homepage is publicly graded — ✓ shipped with a PR-linked receipt.
> When we had gaps, we listed them with ETAs — then shipped all 12
> items. Worth a mention alongside LangGraph / CrewAI coverage?

---

## 7 · Forbidden moves

- **No fake social proof.** No purchased stars, no astroturfed HN
  comments, no AI-generated testimonials.
- **No SaaS dashboards in marketing shots.** The product is a CLI + a
  repo. Terminal screenshots only.
- **No "contact sales."** Price is zero. Product is open source.
- **No "as seen on" logos** unless we actually earned the mention and
  have written permission.
- **No decorative emojis** in copy. Status glyphs (`✓ ◐ ○ ★`) are
  functional and allowed.
- **No stock photography.** Ever.

---

## 8 · Measuring the brand

### Primary KPIs

1. GitHub stars — the brand's most honest feedback loop.
2. `npm install` weekly downloads — trailing-30-day moving average.
3. Install → activation funnel — install to `declaragent up` ratio
   (requires opt-in telemetry).
4. Unaided mentions in credible newsletters — Latent Space, TLDR AI,
   Pragmatic Engineer, Batch, Import AI, Software Engineering Daily.

### Secondary

- PR contributors outside the core team.
- Issues filed with real reproducible use cases.
- Design-partner qualified conversations per quarter.

### How we track

- **PostHog** — product analytics + session replay + funnels +
  feature flags. Enable by uncommenting the loader snippet in
  `index.html` and filling in the project API key. The `track()`
  helper in `app.js` routes every `data-track="..."` click through
  `posthog.capture(name, props)`, auto-tagging outbound links with
  `href` + `external` properties for attribution. Default region is
  US (`us.i.posthog.com`); swap to `eu.i.posthog.com` for EU hosting.
  `person_profiles: "identified_only"` means anonymous visitors
  don't create persistent profiles — set via `posthog.identify(...)`
  only when a visitor takes an account-level action.
- **npm-stat** public API for download trends.
- **GitHub stars/traffic API** for referrer attribution.

### Event-name convention

`<section>:<action>`, colon-delimited, all lowercase. Examples:
`hero:copy-install`, `hero:star`, `install:tab:npm`, `honest:audit`,
`notyet:plan`, `cta:star`. One convention keeps PostHog Insights
readable — sort alphabetically in the sidebar and every section
clusters.

---

## 9 · Owners + process

- The brand is owned by the core team.
- Copy changes to hero, H2s, and the honest-status chip copy require
  a PR with at least one core-team reviewer.
- Designers wanting to extend the system must propose in a GitHub
  Discussion with mocks + rationale linked to §1 (receipts-first).
  Additive extensions welcome; palette/typography changes need a
  higher bar.

See also:
- [`website/README.md`](./README.md) — deployment + local preview.
- [`website/OG_IMAGE_SPEC.md`](./OG_IMAGE_SPEC.md) — social card brief.
- [`templates/marketing/agent.yaml`](../templates/marketing/agent.yaml) —
  Declan, the dogfooded marketing agent that enforces all of the
  above when drafting content.

# Declan — Declaragent Marketing Operator

A Declaragent agent that runs marketing ops for Declaragent. Built as
dogfooding: Declan is the same `@declaragent/core` runtime everyone
else uses — same tools, same audit log, same git-versioned config.

## What it does

- **Draft blog posts, social threads, outbound pitches, and release
  bundles** — always to `./marketing-drafts/` for human review.
- **Never publishes automatically.** Every external-facing artifact
  requires a 👍 in `#marketing-review` Slack.
- **Pulls KPIs weekly** (stars, npm downloads, docs sessions,
  activation funnel) and posts a report every Monday 09:00.
- **Monitors brand mentions** 3x/day and digests them for review.
- **Fires on release webhooks** and produces a complete launch
  bundle in one pass.

## Why this shape?

- Declaragent's theme is *an agent for enterprises to build and
  manage fleets of agents*. Declan is a working example of the
  builder→deployable agent path: skills in markdown, channels in
  YAML, MCP servers declared in `agent.yaml`, git-versioned,
  hash-chain-audited.
- Marketing is high-stakes-low-volume: one bad post damages trust
  for thousands of future readers. The correct automation shape is
  *drafts everywhere, human approval at every publish point*.
- Evidence-based honesty is the project's brand (see
  `docs/FIRST_PRINCIPLES_VALIDATION.md`). Declan's system prompt
  enforces it: verify against `AGENTS.md` before any claim.

## Required MCP servers

Declan talks to external systems via MCP. The `mcp:` block in
`agent.yaml` declares them; at `declaragent up`, the CLI prompts
the operator to consent to each server on first run.

| Server | Package | Why Declan needs it | Setup |
|---|---|---|---|
| **github** | `@modelcontextprotocol/server-github` | Stars, issues, PRs, releases, repo traffic, comment drafting targets | GitHub PAT with `repo` + `read:org` + `read:user` scopes. Store in keychain: `declaragent auth store github-token`. |
| **brave-search** | `@modelcontextprotocol/server-brave-search` | Trend tracking, competitor monitoring, mention discovery, recipient research for outbound | [Brave Search API key](https://api.search.brave.com/) (free tier: 2000 queries/mo). Env: `BRAVE_API_KEY`. |
| **fetch** | `@modelcontextprotocol/server-fetch` | Fetch external URLs (npm-stat, blog posts, newsletter issues) for verification and research | No auth. Runs locally. |
| **filesystem** | `@modelcontextprotocol/server-filesystem` | Write drafts to `./marketing-drafts/`, maintain `mentions-seen.json` | Scoped to `./marketing-drafts` only — cannot escape. |
| **posthog** | `@posthog/mcp` | Docs-site analytics, install → activation funnel, top landing pages | PostHog personal API key + host URL. Keychain: `declaragent auth store posthog-personal-api-key`. Swap for Plausible if you standardize there — no first-party MCP yet. |
| **notion** | `@notionhq/notion-mcp-server` | Editorial calendar, campaign briefs, brand guidelines source of truth | Notion integration token. Keychain: `declaragent auth store notion-integration-token`. Skip if you keep all planning in GitHub issues. |
| **linear** | `@tacticlaunch/mcp-linear` | Campaign + marketing task tracking | Linear API key. Keychain: `declaragent auth store linear-api-key`. Swap for GitHub Projects if preferred — in that case drop this server and extend the `github` server scope. |

### Optional / gaps

- **Social scheduling (Buffer / Typefully / Publer)** — no stable
  first-party MCP exists at 2026-04-22. Declan writes approved
  threads to `./marketing-drafts/social/`; a separate human (or a
  follow-up scheduled Declaragent skill) POSTs them to the
  scheduler's HTTP API. Tracked as a follow-up.
- **Email (Gmail / Resend)** — intentionally NOT wired. Outbound
  pitches land as drafts; a human copy-pastes from their own
  mailbox. Rationale: outbound deliverability + relationship hygiene
  is worth the friction.
- **X / LinkedIn / Bluesky direct posting** — also intentionally NOT
  wired. First 90 days: human-gated publishing builds review
  muscle. Revisit once KPIs + review patterns are proven.

### Minimal viable subset

If you want to start lean, the first three are the only hard
requirements:

1. **github** (without this, Declan can't verify claims or draft
   replies)
2. **fetch** (without this, Declan can't pull npm-stat or external
   research)
3. **filesystem** (without this, drafts have no home)

Add **brave-search** next (mention monitoring + outbound research),
then **posthog** (weekly KPI report), then Notion/Linear if you want
structured planning.

## Channels required

- **Slack**: one bot token + app token (Socket Mode) for the
  `#marketing-review` channel. Env:
  - `SLACK_BOT_TOKEN`
  - `SLACK_APP_TOKEN`
  - `SLACK_MARKETING_REVIEW_CHANNEL_ID`

## Event triggers

- **Cron — Monday 09:00**: weekly KPI report.
- **Cron — 08:00 / 13:00 / 18:00 daily**: brand-mention digest.
- **Webhook — GitHub `release.published`**: release-comms bundle.
  Point your repo's webhook at `http://<your-declan-host>/webhook/github-release`
  with a shared secret in `GITHUB_WEBHOOK_SECRET`.

## Running Declan

```bash
# From the repo root
cp -r templates/marketing my-declan && cd my-declan

# Install required env vars (example)
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export SLACK_MARKETING_REVIEW_CHANNEL_ID=C0123ABCD
export BRAVE_API_KEY=...
export POSTHOG_HOST=https://app.posthog.com
export GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Store tokens in keychain
declaragent auth store github-token
declaragent auth store posthog-personal-api-key
declaragent auth store notion-integration-token         # optional
declaragent auth store linear-api-key                   # optional

# Verify the agent config
declaragent doctor              # or: d9t doctor

# Bring Declan up
declaragent up -d               # or: d9t up -d

# Logs
declaragent logs -f             # or: d9t logs -f

# Audit trail
declaragent audit verify        # or: d9t audit verify
```

## Guardrails baked in

Declan's system prompt and skill files enforce:

- No capability claim without `AGENTS.md` citation.
- No direct publish to public channels — drafts only.
- No competitor-naming without human approval.
- No paid spend triggers.
- Security reports → STOP + escalate, never reply.
- Forbidden-word list: "revolutionary," "game-changing," "unlock,"
  "empower," "seamless," "democratize."

## Layout

```
templates/marketing/
├── agent.yaml             # identity + model + MCP servers + skill list
├── channels.yaml          # Slack #marketing-review channel
├── event-sources.yaml     # cron + GitHub release webhook
├── skills/
│   ├── draft-blog-post.md
│   ├── draft-social-thread.md
│   ├── engage-github.md
│   ├── outbound-pitch.md
│   ├── weekly-ops-report.md
│   └── release-comms.md
└── README.md              # this file
```

## Known gaps / follow-ups

- Social scheduler MCP hand-off is manual today.
- No live-LLM regression fixture for Declan's skills yet (gap
  mirrors the project-wide Builder gap in
  `docs/FIRST_PRINCIPLES_VALIDATION.md`).
- The `mentions-seen.json` dedupe file is process-local; move to
  SQLite if Declan ever runs multi-host.

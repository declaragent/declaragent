---
name: weekly-ops-report
description: Every Monday 09:00, pull KPIs, summarize the week, and post to #marketing-review with next-week recommendations.
inputs:
  mode:
    type: string
    description: Optional. Default `weekly`. Set to `mentions` for the 3x-daily brand-mention digest.
    required: false
outputs:
  report_path:
    type: string
    description: Path to the full report markdown file.
  review_message:
    type: string
    description: The Slack summary posted to #marketing-review.
---

# Skill: weekly-ops-report

## Weekly mode (default)

### Pull KPIs

Use the MCP servers:

- **github**: stars (delta this week), new issues opened/closed, PR
  velocity, top referrers from repo traffic.
- **fetch**: npm-stat public endpoint for @declaragent/cli downloads
  this week vs last week. URL pattern:
  `https://api.npmjs.org/downloads/range/YYYY-MM-DD:YYYY-MM-DD/@declaragent/cli`
- **posthog**: docs-site sessions, install → activation funnel
  conversion, top landing pages.
- **linear** (or github-projects): campaign status for the week.

Missing any data source? Note it in the report explicitly — never
fabricate a number.

### Compose the report

Write to `./marketing-drafts/reports/{{YYYY-MM-DD}}-weekly.md` with
this shape:

```
# Weekly marketing ops — {{YYYY-MM-DD}}

## KPI snapshot
| Metric | This week | Last week | Δ | Target |
|---|---|---|---|---|
| GitHub stars | … | … | +… | +500/90d |
| npm installs (weekly) | … | … | +…% | 2× WoW |
| Install → `up` activation | …% | …% | … | ≥25% |
| Docs sessions | … | … | … | — |
| Issues opened / closed | …/… | …/… | … | — |
| Newsletter mentions | … | … | … | 3+/90d |

## What worked
- …

## What didn't
- …

## Notable mentions (external)
- …

## Recommendations for next week
- [ ] … (owner, est. hours, which objective)
```

### Post to Slack

Send a compact summary to `marketing-review`:
- One-line headline (the single most important metric this week).
- Top 3 things that worked.
- Top 3 things that didn't.
- Link to the full report markdown file.
- An explicit "next-week decisions needed" list if any.

## Mentions mode (3x daily: 08:00, 13:00, 18:00)

When invoked with `mode: mentions`:

1. Use MCP `brave-search` to query, last 24h:
   - `"Declaragent"`
   - `"d9t.dev"`
   - `"@declaragent/cli"`
   - `site:news.ycombinator.com Declaragent`
   - `site:reddit.com Declaragent`
2. Use MCP `github` to pull mentions in new issues, discussions, PRs
   that reference other repos.
3. De-dupe against `./marketing-drafts/mentions-seen.json`
   (read/write). If a URL was already reported, skip.
4. For each new mention:
   - URL
   - Author (if known)
   - One-sentence summary
   - Suggested action: `ignore`, `thank`, `engage`, `escalate`
     (negative / security).
5. Post the digest to `marketing-review`. If any items are
   `escalate`, flag them explicitly at the top.
6. Update `mentions-seen.json` and write the digest to
   `./marketing-drafts/reports/{{YYYY-MM-DD-HH}}-mentions.md`.

## Hard rules

- Every number in the report is sourced from a live tool call. NO
  "approximately" or "around" — cite the source or omit the row.
- NEVER take action on a mention (reply, DM, thank) directly. The
  digest suggests actions; a human or the `engage-github` skill picks
  them up.
- If a KPI source is down (e.g., PostHog 5xx), note "DATA MISSING"
  and post the partial report anyway. Don't block the weekly rhythm
  on one bad API.

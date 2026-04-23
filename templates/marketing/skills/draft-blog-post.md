---
name: draft-blog-post
description: Draft a long-form blog post (postmortem / benchmark / design doc / tutorial) to ./marketing-drafts/blog/ for human review.
inputs:
  topic:
    type: string
    description: The post topic in one sentence.
    required: true
  format:
    type: string
    description: One of `postmortem`, `benchmark`, `design`, `tutorial`, `opinion`. Priority for stars/trust is postmortem > benchmark > design > tutorial > opinion.
    required: true
  target_objective:
    type: string
    description: Which of the 5 north-star objectives this moves (1=stars, 2=installs, 3=activation, 4=brand-recall, 5=pipeline).
    required: true
  publish_date:
    type: string
    description: ISO date (YYYY-MM-DD). Used in slug and frontmatter.
    required: true
outputs:
  draft_path:
    type: string
    description: Absolute path to the drafted markdown file.
  review_message:
    type: string
    description: The Slack summary sent to #marketing-review.
---

# Skill: draft-blog-post

You are drafting a blog post for docs-site/blog. The draft lands in
`./marketing-drafts/blog/{{publish_date}}-<slug>.md` so it can be
reviewed, edited by a human, and then copied into the docs-site repo
via a PR. You do NOT write to `docs-site/blog/` directly.

## Step 1 — Verify every claim

Before writing a single sentence:

1. Read `AGENTS.md` and `docs/FIRST_PRINCIPLES_VALIDATION.md`. Note the
   current ✅ vs 🟡 status of every pillar you plan to mention.
2. For any specific API, flag, or command you'll reference, grep:
   `rg '<symbol>' packages/` via the Bash/Grep tools. Copy the
   file:line into a scratch list.
3. If the post needs a reproducible command, run it yourself in a
   scratch dir and paste exact output. No fabricated terminal output.

If you can't verify a claim, cut it. Don't soften it — cut it.

## Step 2 — Outline

Produce an outline with this shape:
- **Hook** (≤ 2 sentences): a concrete, surprising fact. No "In today's
  AI landscape…" openings.
- **The problem** (1 paragraph): what the reader is currently doing that
  hurts.
- **What we actually did** (the bulk): receipts-first. Commands, diffs,
  commit SHAs, screenshots with real timestamps.
- **What broke / what's still 🟡** (honesty section — non-optional for
  postmortems and benchmarks): cite AGENTS.md.
- **What this means for you** (1 paragraph, no CTAs).
- **Try it** (1 code block, both CLI forms on first line):

      declaragent init my-agent   # or: d9t init my-agent
      cd my-agent && declaragent up

- **Links**: GitHub repo, docs page, specific commit SHA for the
  changes described.

## Step 3 — Draft

Write the full post. Rules:
- Title ≤ 65 characters, no clickbait, no colons before buzzwords.
- First paragraph passes the "would an experienced infra engineer
  keep reading" test.
- No forbidden words: "revolutionary," "game-changing," "unlock,"
  "empower," "seamless," "democratize."
- First code block uses both `declaragent` and `d9t` forms on line 1.
- Every factual claim has a linked source (commit SHA, AGENTS.md
  anchor, external article, or public benchmark repo).
- Include frontmatter:

      ---
      slug: <kebab-case>
      title: <final title>
      authors: [declan]
      tags: [<format>, <pillar>]
      date: {{publish_date}}
      ---

## Step 4 — Save + notify

1. Write to `./marketing-drafts/blog/{{publish_date}}-<slug>.md`.
2. Call `SendMessage` to the `marketing-review` channel with:
   - The draft's absolute path.
   - A 3-bullet TL;DR of the post.
   - Which north-star objective it moves (from the input).
   - A list of every claim that needed verification and where it was
     verified (AGENTS.md line, commit SHA, external link).
   - An explicit "Approve to publish" line — do NOT proceed further
     without a human 👍.

## Hard rules

- NEVER push to `docs-site/blog/` directly. Drafts only.
- NEVER promise features that are 🟡 in AGENTS.md. Say "roadmap" or
  "tracked in docs/ENTERPRISE_PRODUCTION_PLAN.md".
- If the post compares Declaragent to another project, name it only
  neutrally, and flag the comparison in the review message so a human
  sanity-checks it.

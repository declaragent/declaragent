---
name: draft-social-thread
description: Draft a short-form thread (X, LinkedIn, Bluesky) to ./marketing-drafts/social/ for human review and scheduled posting.
inputs:
  platform:
    type: string
    description: One of `x`, `linkedin`, `bluesky`, `mastodon`. Drives character limits and format.
    required: true
  topic:
    type: string
    description: What the thread is about in one sentence.
    required: true
  anchor_link:
    type: string
    description: The canonical URL for the thread to point at. Use d9t.dev/<slug> for external posts so we can track UTMs via the redirect.
    required: true
  source_material:
    type: string
    description: Optional — paste of the blog post, commit, or release notes this thread summarizes. If empty, the skill will go read AGENTS.md and the latest release notes.
    required: false
outputs:
  draft_path:
    type: string
    description: Absolute path to the JSON file with the thread posts.
  review_message:
    type: string
    description: The Slack summary sent to #marketing-review.
---

# Skill: draft-social-thread

Short-form content is easy to get wrong. The failure mode is
AI-slop: generic, emoji-laced, all-substance-no-edge. Avoid that.

## Platform limits

- **x**: 280 chars/post, up to 9 posts in a thread, no more than 2
  links total (algorithm deprioritizes link-heavy threads), images OK.
- **linkedin**: single post, 1300 chars for optimal reach, no threads,
  1 link, code blocks render poorly — use screenshots instead.
- **bluesky**: 300 chars/post, threads fine, native markdown, 2 links
  OK, audience is technical (skew the voice more irreverent).
- **mastodon (fosstodon)**: 500 chars/post, threads fine, 2 links OK,
  audience is OSS-native (no corporate-speak).

## Rules (all platforms)

- First post of the thread must stand alone (many readers won't
  expand). No "🧵 1/n" on post 1 — put the hook first; mention thread
  length on post 2 if needed.
- Every thread ends with ONE link. No multi-link dumps.
- No emojis unless they carry information (✅/🟡 status markers are
  fine; sparkles/rocket are not).
- No "today I'm excited to announce" openers.
- First code block in the thread shows both CLI forms on line 1:

      declaragent init my-agent   # or: d9t init my-agent

- For `x` and `bluesky`, use `d9t.dev/<utm-slug>` as the outbound link
  — easier to fit in 280 chars and tracks the channel. LinkedIn can
  take the long form.
- NEVER use `d9t` without mentioning "Declaragent" somewhere in the
  thread. A lone `d9t` post is brand-invisible to someone who hasn't
  heard of us yet.

## Step 1 — Verify

If the thread makes a feature claim, Read AGENTS.md first. If the
thread cites a number (stars, downloads, perf), the number must be
sourced from a live tool call, not from memory.

## Step 2 — Draft

Produce a JSON array — one object per post — with this shape:

```json
[
  {
    "order": 1,
    "text": "<= 280 chars for x / 300 for bluesky / etc.>",
    "media": null
  },
  ...
]
```

For LinkedIn, produce a single object.

## Step 3 — Save + notify

1. Write to `./marketing-drafts/social/{{platform}}/{{YYYY-MM-DD}}-<slug>.json`.
2. Post to `marketing-review` with:
   - The draft path.
   - The first post rendered verbatim (so reviewers see exactly what
     will land in the feed).
   - Which north-star objective this moves.
   - A one-line note flagging any claim that needed verification.
   - "Approve to queue" — do NOT hand off to the scheduler without 👍.

## Hand-off to scheduler

Approved drafts are picked up by a separate scheduled skill (cron) that
calls Buffer or Typefully APIs. That skill is NOT part of this template
yet — file a follow-up issue if you need it. For now, humans copy
approved JSON into the scheduling tool.

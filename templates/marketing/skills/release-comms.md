---
name: release-comms
description: Triggered by GitHub release-published webhook. Drafts a coordinated bundle — blog post, X thread, LinkedIn post, newsletter blurb — for human review.
inputs:
  release:
    type: object
    description: The `release` object from the GitHub webhook payload (tag_name, name, body, html_url, published_at).
    required: true
  repository:
    type: object
    description: The `repository` object from the webhook payload. Scope to `declaragent/declaragent` — ignore downstream package releases.
    required: true
outputs:
  bundle_path:
    type: string
    description: Path to the release-bundle directory containing all drafts.
  review_message:
    type: string
    description: Slack summary linking all drafts.
---

# Skill: release-comms

Fired when a new Declaragent release ships. Goal: produce a complete
launch bundle in ≤ 5 minutes so a human reviewer can edit + publish
the same day.

## Step 0 — Gate

Only proceed if `repository.full_name == "declaragent/declaragent"`
AND the release is NOT a prerelease. Otherwise, post a one-line
"skipping <tag>" to `marketing-review` and stop.

## Step 1 — Understand what shipped

- Read the release body from the webhook payload.
- Use MCP `github` to pull:
  - The commit range since the previous release.
  - Any merged changesets in `.changeset/` since last tag.
  - The diff of `AGENTS.md` since last tag (did we flip any 🟡 → ✅?).
- Identify the ONE headline capability. Everything else is secondary.

## Step 2 — Draft the bundle

Create `./marketing-drafts/releases/{{release.tag_name}}/` and produce:

### `blog.md`
Invoke `draft-blog-post` logic inline. Format: `design` (or
`postmortem` if the release fixes a publicly-known issue). Lead with
the headline capability. Include:
- Before/after code sample (both `declaragent` and `d9t` forms).
- Links to every merged PR that matters.
- Honest ✅/🟡 update — did this release flip any pillar status in
  AGENTS.md?

### `x-thread.json`
Format per `draft-social-thread` rules. 5–7 posts. First post = hook
+ `d9t.dev/<tag>` link. Middle posts = specifics with screenshots.
Last post = "repo: github.com/declaragent/declaragent — stars welcome
if this is useful to you." (Direct star ask is OK on release day
only, NOT in general tweets.)

### `linkedin.md`
Single post, ≤ 1300 chars, aimed at platform-engineering leaders.
Frame in terms of "what this changes for production agent ops,"
not feature list.

### `bluesky-thread.json`
Same content as X thread, 300 chars/post, more technical voice.

### `newsletter-blurb.md`
120 words, ready to forward to the 5 target newsletters. Subject
line ≤ 7 words.

### `hn-submission.md`
ONLY for milestone releases (0.7, 0.8, 1.0, or anything AGENTS.md
flags as major). Format:
- Title: 60 chars max, no version number, no hype. Example:
  "Show HN: Declaragent — declarative runtime for AI agent fleets"
- First comment (we post as author, ≤ 500 words): the honest status
  (single-machine ✅, multi-host 🟡, roadmap link). HN respects
  candor; rewards it with front-page time.
- Flag at the top of the file: "MILESTONE — requires explicit
  approval before submission."

### `checklist.md`
A human-facing publish checklist:

```
[ ] Review blog.md, open PR to docs-site
[ ] Schedule x-thread.json via Typefully/Buffer for <time>
[ ] Schedule linkedin.md for <time + 2h>
[ ] Post bluesky-thread.json manually
[ ] Send newsletter-blurb.md to 5 newsletter authors (BCC)
[ ] Tweet from @declaragent, boost from @d9t
[ ] Update docs-site homepage hero to mention new capability
[ ] Update README.md features table
[ ] If milestone: submit HN on <date> at 08:30 PT (Tue–Thu)
[ ] Monitor mentions 2x that day, reply to every GH issue within 4h
```

## Step 3 — Notify

Post a single message to `marketing-review`:
- Release tag + headline capability.
- Link to the bundle directory.
- The checklist rendered inline.
- An explicit ask: "Ready to publish — approve blog.md first; the
  rest follows that thread."

## Hard rules

- NEVER publish the bundle automatically. Every artifact is a draft.
- NEVER submit to HN without explicit approval (the `hn-submission.md`
  file is a draft, not a trigger).
- NEVER reference a release number that isn't in the webhook payload.
- If AGENTS.md shows the release DIDN'T flip any 🟡 → ✅ and the
  release body is mostly fixes, be honest: frame as "maintenance"
  not "major." Honesty compounds; overclaiming on a small release
  burns credibility for the next big one.

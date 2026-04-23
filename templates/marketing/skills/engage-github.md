---
name: engage-github
description: Draft a reply to a GitHub issue, PR comment, or discussion thread. Never posts directly — draft goes to #marketing-review.
inputs:
  url:
    type: string
    description: Full URL of the GitHub issue/PR/discussion/comment to respond to.
    required: true
  intent:
    type: string
    description: One of `thank-contributor`, `clarify-capability`, `redirect-to-docs`, `convert-to-design-partner`, `defuse-negative`.
    required: true
  context:
    type: string
    description: Optional extra context the reviewer should know.
    required: false
outputs:
  draft_reply:
    type: string
    description: The drafted reply text.
  review_message:
    type: string
    description: Slack summary for #marketing-review.
---

# Skill: engage-github

GitHub is our highest-leverage channel. A bad reply damages trust for
every future reader of the thread. No drive-by replies.

## Step 1 — Read the full thread

Use the MCP `github` server (or `Fetch` as fallback) to pull:
- The issue/PR title and body
- ALL comments, in order
- The reporter's recent activity: are they a first-time contributor?
  A returning user? A known competitor?

If this is a PR, also read the diff.

## Step 2 — Verify any capability question

If the thread asks "does Declaragent do X?":
1. Read `AGENTS.md` and find the row.
2. If ✅: answer yes, link to the file:line where it's implemented.
3. If 🟡: say "partial — <specifics>" and link
   `docs/ENTERPRISE_PRODUCTION_PLAN.md` or the tracked issue.
4. If not listed: say "not today" and ask what the use case is. Do
   NOT promise a roadmap slot you haven't been authorized to promise.

## Step 3 — Draft by intent

- **thank-contributor**: ≤ 3 sentences. Specific thanks (name what
  they improved), plus one concrete next-step if they want to go
  deeper ("the `docs/CONTROL_PLANE_PLAN.md` tracker is where Slice 3
  is scoped if you want to see what's next").
- **clarify-capability**: answer the question verbatim first, then
  cite file:line. Append ✅ / 🟡 honestly.
- **redirect-to-docs**: answer in one sentence, THEN link the docs
  page. Don't just link-dump.
- **convert-to-design-partner**: only if the reporter works at a
  company 50–2000 engineers and has described a real use case. Reply
  with the technical answer first, then add a single sentence:
  "If this is for production use at <company>, we'd love to compare
  notes — reply here or email design-partners@declaragent.dev."
- **defuse-negative**: acknowledge the specific issue (don't
  paraphrase it into something softer), concede what's true, name
  what we're fixing, give an ETA only if you have one. Never
  defensive. Never "sorry you feel that way."

## Step 4 — Route for approval

1. Write the draft to `./marketing-drafts/github/<issue-number>-<yyyy-mm-dd>.md`.
2. Post to `marketing-review` with:
   - The original thread URL.
   - The drafted reply, verbatim.
   - Intent, plus a one-line note on what tone you picked and why.
   - "Approve to post" — a human copy-pastes. Do NOT post via the
     MCP github server without explicit approval.

## Hard rules

- NEVER post a reply that hasn't been approved in #marketing-review.
- NEVER lock / close / resolve a thread on your own initiative.
- NEVER mention a competitor by name in a reply.
- If the thread is a security report, STOP. Post to
  `marketing-review` with "SECURITY — needs triage, not a marketing
  reply" and take no other action.

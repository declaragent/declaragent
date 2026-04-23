---
name: outbound-pitch
description: Draft personalized outbound to newsletter authors, podcast hosts, or design-partner candidates. Never sends — drafts land for human review.
inputs:
  recipient_type:
    type: string
    description: One of `newsletter`, `podcast`, `design-partner`, `journalist`.
    required: true
  recipient_name:
    type: string
    description: The person you're writing to.
    required: true
  recipient_handle_or_url:
    type: string
    description: Their newsletter URL, podcast URL, LinkedIn, or email if known.
    required: true
  hook:
    type: string
    description: The specific thing we're pitching (a release, a benchmark, a postmortem, a design doc).
    required: true
outputs:
  draft_path:
    type: string
    description: Path to the drafted pitch.
  review_message:
    type: string
    description: Slack summary for #marketing-review.
---

# Skill: outbound-pitch

Outbound that works is personalized, short, and anchored to a specific
artifact. Outbound that fails is generic, long, and anchored to "we'd
love to chat."

## Step 1 — Research the recipient

Use MCP `brave-search` + `fetch` to pull:
- The recipient's last 3 pieces of published content (newsletter
  issues, pod episodes, articles). Note recurring themes.
- Their stated interests on X/LinkedIn/their site's about page.
- Any prior mention of "agents," "MCP," "declarative infra," or
  adjacent topics. If they've written about competitors, note it —
  our pitch has to engage with that thinking, not ignore it.

Summarize findings in ≤ 5 bullets. If you can't find recent content,
STOP and flag in the review message — don't send a cold pitch to
someone whose interests you couldn't verify.

## Step 2 — Draft by type

### newsletter
- Subject line: ≤ 7 words, specific. Example: "Postmortem: 50M agent
  events on SQLite." Never "Check out Declaragent."
- Body: ≤ 120 words. Structure:
  1. One sentence showing you read their recent work (cite the
     specific issue).
  2. One sentence of substance: what we shipped + why it matters for
     their audience.
  3. One link (the artifact, usually a d9t.dev/... URL).
  4. One ask: "Worth a mention in an upcoming issue?" — no calendar
     link, no "happy to chat."
- Sign off: "Declan (for the Declaragent team)" + one line bio.

### podcast
- Subject line: ≤ 8 words.
- Body: ≤ 150 words.
  1. Specific reference to a recent episode (name the guest).
  2. The one concrete angle we could bring: e.g., "we ran a 50M-event
     soak on one machine to find where agent systems actually break
     — happy to walk through the failure modes on air."
  3. Who would come on (the actual human — this is a hand-off field
     the reviewer fills in).
  4. Link to a 3-minute demo video.

### design-partner
- Subject line: reference their public work. "About your <company>
  agent platform post."
- Body: ≤ 180 words.
  1. One sentence showing you read their specific problem.
  2. One sentence on how Declaragent's CURRENT state fits (cite
     AGENTS.md ✅ rows; be honest about 🟡).
  3. "We're talking to ~10 teams this quarter to shape v1.1. Worth
     30 minutes?"
  4. One link — usually the homepage or a relevant plan doc.

### journalist
- Usually the wrong motion in the first 12 months. If the intent is
  "get a TechCrunch article," flag in review and suggest earning the
  mention organically via a newsletter or HN front page first.

## Step 3 — Save + notify

1. Write to
   `./marketing-drafts/outbound/{{recipient_type}}/{{YYYY-MM-DD}}-<recipient-slug>.md`.
2. Post to `marketing-review`:
   - The full drafted email.
   - The 5-bullet recipient research summary.
   - Which north-star objective this moves.
   - "Approve to send" — a human sends it from their own mailbox. Do
     NOT wire this to an automated mailer without explicit project
     approval.

## Hard rules

- NEVER send outbound without approval.
- NEVER use a template. Every pitch references specific recent work.
- If you can't find recent work, SKIP the recipient — don't send a
  generic pitch. Low volume + high specificity > high volume.
- NEVER promise a capability not in AGENTS.md.
- NEVER promise exclusivity, embargo, or free tier extensions you
  don't have written authority to promise.

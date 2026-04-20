---
name: delegate
description: Delegate a PR-review request to `agent://pr-reviewer` and summarize the response for the user.
inputs:
  prUrl:
    type: string
    description: GitHub pull request URL (e.g. `https://github.com/acme/app/pull/42`).
    required: true
outputs:
  summary:
    type: string
    description: Markdown summary returned to the user.
---

# Delegate skill

The user asked you to review PR `{{prUrl}}`.

## Step 1 — Call the specialist

Use `RequestAgent`:

```yaml
to: agent://pr-reviewer
capability: review-pr
payload:
  prUrl: "{{prUrl}}"
timeoutMs: 60000
# mode omitted → defaults to "sync"
```

## Step 2 — Handle each possible status

| status | What to do |
| ------ | ---------- |
| `ok` | Render `response` as a Markdown summary. |
| `timeout` | Apologize; tell the user the reviewer did not respond within 60s and ask if they want to retry. |
| `error` | Apologize; include `error.message` if it's safe (no internal trace ids). |
| `busy` | Apologize; the bus is overloaded. Offer to retry in a minute. |
| `abandoned` | Apologize; the daemon is shutting down. |

## Step 3 — Keep it short

The concierge is a proxy, not the reviewer. Summaries should be ≤ 400
words. If the reviewer's response is longer, extract:

1. Verdict (approve / request-changes / comment).
2. Top 3 findings with file + line.
3. Suggested next step for the user.

Never echo the `correlationId` — it's internal.

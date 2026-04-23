---
name: delegate
description: Delegate a PR-review request to `agent://pr-reviewer` and summarize the response for the user.
inputs:
  prUrl:
    type: string
    description: GitHub pull request URL (e.g. `https://github.com/acme/app/pull/42`).
    required: true
  severity:
    type: string
    description: Severity floor — one of `low`, `med`, `high`. Defaults to `med`.
outputs:
  summary:
    type: string
    description: Markdown summary returned to the user.
---

# Delegate skill

The user asked you to review PR `{{prUrl}}` at severity floor `{{severity}}`.

## Step 1 — Call the specialist

Use `RequestAgent`. The `review-pr` capability is typed
(`capabilities.yaml` declares JSON Schema on both sides) — the runtime
validates the payload **before** it goes on the wire, so a bad value
short-circuits with a `schema-violation` result.

```yaml
to: agent://pr-reviewer
capability: review-pr
payload:
  prUrl: "{{prUrl}}"
  severity: "{{severity}}"   # must be one of low | med | high
timeoutMs: 60000
# mode omitted → defaults to "sync"
```

## Step 2 — Handle each possible status

| status | What to do |
| ------ | ---------- |
| `ok` | Render `response` as a Markdown summary. |
| `schema-violation` | Explain which field was bad — inspect `violations[]` and `schemaSide`. Ask the user to rephrase. Never retry blindly. |
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

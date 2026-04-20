---
name: triage
description: Classify an Alertmanager firing, compose a human summary, and DM the on-call.
inputs:
  alerts:
    type: array
    description: The `alerts` array from the Alertmanager v4 webhook payload.
    required: true
  groupKey:
    type: string
    description: Alertmanager group key. Used for idempotency display only.
    required: false
outputs:
  summary:
    type: string
    description: Human-readable summary, ≤ 80 words, ready to DM.
  severity:
    type: string
    description: One of `P1`, `P2`, `P3`.
---

# Triage skill

You received an Alertmanager firing:

```
{{alerts}}
```

Produce a single Slack message summarizing the firing. Follow this
ladder:

1. **Severity**
   - `P1` if any alert has `labels.severity=critical` or
     `labels.severity=page`.
   - `P2` if the highest severity is `warning`.
   - `P3` otherwise.
2. **Summary** (≤ 80 words):
   - Alert name + count (`CrashLoopBackOff × 3`).
   - Cluster / namespace from the labels.
   - The first alert's `annotations.description` verbatim if present.
   - The `annotations.runbook_url` if present — linkified.
3. **Action**: call `SendMessage` with `conversationId` =
   `SLACK_ONCALL_USER_ID`, `text` = your summary. Prefix `:rotating_light:`
   for P1, `:warning:` for P2, `:information_source:` for P3.

If the payload has `status=resolved`, send a one-line "RESOLVED: <alert>"
instead. Do NOT tag anyone on resolved events.

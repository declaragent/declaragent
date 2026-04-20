# Pen-test sign-off — Declaragent v1.0

**Status:** Template. Populated at the close of Phase 6 slice 8 by the
engaged third-party firm.

## Engagement scope

Agreed with the reviewer at engagement kickoff. Scope document is
linked from the vendor portal + archived under
`docs/security/pen-test-sow.pdf` (not in the public repo).

Scoped components:
- Core runtime (engine, permission gate, event bus, dispatcher).
- Every webhook endpoint: built-in webhook source, Slack / WhatsApp /
  Telegram / Discord channel adapters.
- Prometheus `/metrics` exporter.
- Audit sink (tamper-evidence + right-to-erasure semantics).
- Secret resolver paths (Vault / AWS SM / GCP SM / K8s).

Explicitly out of scope:
- Third-party platform auth flows (Slack OAuth, Meta Business, etc.).
- Operator deployment topology outside the container boundary.
- LLM provider safety (that's Anthropic's review scope).

## Findings

| Severity | Finding | Status | Remediation PR |
| -------- | ------- | ------ | -------------- |
| _none_ yet | | | |

_Populated by the reviewer's report; verbatim quotes from the report
are preferred. Critical findings block Phase-6 signoff; High findings
are remediated before Phase 7 kickoff._

## Reviewer attribution

- Firm: **TBD** (engagement booked during Phase 5 slice 15).
- Lead reviewer: **TBD**.
- Engagement window: **TBD**.
- Contact for follow-up questions: **TBD**.

## Residual-risk sign-off

| Component | Residual risk | Accepted by | Date |
| --------- | ------------- | ----------- | ---- |
| _TBD_ |  |  |  |

## Post-engagement

Every remediation PR links back to this document + the reviewer's
finding id. The platform-team retrospective at Phase-7 kickoff reviews
every residual-risk line item for policy changes.

# Pen-test sign-off — Declaragent

> **Status: NOT YET ENGAGED.** No third-party penetration test has been
> commissioned or completed for Declaragent. Everything below is a **template**
> awaiting a real engagement — do not cite this document as evidence of an
> external audit. The Findings, Reviewer-attribution, and Residual-risk sections
> are intentionally empty / TBD until a firm delivers a report.

**Status:** Template. To be populated once a third-party firm is engaged and
delivers its report.

## How to get this signed off

A fabrication-free checklist for turning this template into a real sign-off:

1. **Scope the engagement** against the trust boundaries in
   [THREAT_MODEL.md](./THREAT_MODEL.md) (TB-1 … TB-6) and the §1–§8 components.
   The "Engagement scope" section below is a starting point.
2. **Budget.** The production-readiness review estimates roughly **$20k–$60k**
   for the documented scope; size the engagement accordingly.
3. **Select a credentialed firm** — look for CREST-accredited and/or
   OSCP-credentialed testers with experience in runtime / multi-tenant security.
4. **Require findings delivered against the §1–§8 components** in
   [THREAT_MODEL.md](./THREAT_MODEL.md) so each result maps to a known surface.
5. **Fill the tables verbatim** from the report: copy the Findings, Reviewer
   attribution, and Residual-risk rows directly from the firm's deliverable —
   prefer verbatim quotes over paraphrase.
6. **Link every remediation PR back here**, referencing the firm's finding id.

Until steps 1–6 are done, leave every TBD / empty cell below exactly as-is.

## Engagement scope

Agreed with the reviewer at engagement kickoff. Scope document is
to be linked from the vendor portal + archived under
`docs/security/pen-test-sow.pdf` once an engagement exists (not in the
public repo; no engagement yet — see the banner above).

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

- Firm: **TBD** (no firm engaged yet).
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

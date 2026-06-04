# Security Policy

Declaragent is a pre-1.0 declarative agent runtime that ships security-relevant
primitives (hash-chained audit, multi-tenant isolation, OAuth2/OIDC RPC auth,
secret resolvers, and a webhook ingress surface). We take vulnerability reports
seriously and prefer coordinated disclosure.

## Reporting a vulnerability

Email **security@declaragent.dev** with a description of the issue, the affected
version(s), and reproduction steps. Please do **not** open a public GitHub issue
or pull request for a suspected vulnerability — email first so we can fix it
before it is disclosed.

- Encryption: a PGP key is available on request — ask in your first email and we
  will share one before you send sensitive details.
- This mailbox is currently the single point of contact, triaged by one human
  maintainer. See [GOVERNANCE.md](./GOVERNANCE.md) for the honest bus-factor-one
  caveat and the plan to add redundancy.

## Supported versions

This project is pre-1.0; the version surface is still being unified (see the
honesty note in [GOVERNANCE.md](./GOVERNANCE.md)). Security fixes target the
latest published `@declaragent/cli` minor line only.

| Component | Supported for security fixes |
| --------- | ---------------------------- |
| `@declaragent/cli` (latest `0.7.x` minor) | Yes |
| `@declaragent/cli` older `0.x` lines | No — upgrade to the latest `0.7.x` |
| `@declaragent/core` | Tracks the latest CLI release |
| `@declaragent/channel-*`, `@declaragent/source-*`, `@declaragent/plugin-*` | Track the latest CLI release |

Because every package is still in `0.x`, we make **no SemVer back-compat
guarantee** — breaking changes are allowed between minors (for example, the
`0.8.0` zero-trust default flip documented in
[docs/ZERO_TRUST_DEFAULT_MIGRATION.md](./docs/ZERO_TRUST_DEFAULT_MIGRATION.md)).
Always run a supported version before reporting.

## Response-time SLA

These are best-effort targets for a solo maintainer, not an enterprise contract:

- **Acknowledgement:** within 3 business days of your email.
- **Initial assessment** (severity + whether it reproduces): within 7 business
  days.
- **Fix + coordinated disclosure timeline:** negotiated per severity once the
  assessment is done.

If you have not heard back within the acknowledgement window, please re-send —
mail can be lost, and there is currently no backup triager.

## Coordinated disclosure policy

- Default embargo is **90 days** from acknowledgement, or until a fix ships,
  whichever is sooner. We will negotiate extensions for hard-to-fix issues.
- Please give us reasonable time to remediate before any public disclosure.
- We are happy to credit reporters in the release notes and the fix's commit /
  PR. Tell us how you would like to be credited (or if you prefer to stay
  anonymous).
- We will not pursue legal action against good-faith security research that
  respects this policy, avoids privacy violations and service degradation, and
  does not access or modify data that is not yours. This is a safe harbor for
  researchers acting in good faith.

## Scope

The security-relevant surface is documented in
[docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md) — trust boundaries, assets, the
attacker model, and per-component mitigations (hash-chained audit, multi-tenant
isolation, RPC OAuth2/OIDC auth, secret resolvers, and the webhook surface).

No third-party penetration test has been completed yet. The current
external-review status is tracked in
[docs/PEN_TEST_SIGNOFF.md](./docs/PEN_TEST_SIGNOFF.md); do not treat that
document as evidence of a completed audit.

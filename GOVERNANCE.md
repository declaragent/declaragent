# Governance

This document describes how Declaragent is maintained today and the honest risks
that come with that model. It is intentionally candid: the project's positioning
is receipts-first, and governance is part of the receipts.

## Maintainer model

Declaragent is currently a single-maintainer project, run in a BDFL-style model.
The maintainer reviews and merges every change; decisions are made through pull
request review. Contribution mechanics (branching, lint/test loop, commit
conventions) live in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Bus factor: one (the honest risk)

The bus factor of this project is **one**. Concretely:

- Roughly 206 of 207 commits are authored by a single human
  (`gatolgaj@gmail.com`).
- There is a single npm publish identity across all `@declaragent/*` packages.
- There is a single GitHub-org owner.

An AI co-author (see below) writes a large share of the code, but that does
**not** diversify ownership — it is still one human who reviews, holds the keys,
and is accountable. The failure modes this creates:

- **Security-disclosure SPOF.** One mailbox, one triager. If the maintainer is
  unavailable, a report in [SECURITY.md](./SECURITY.md) may sit unanswered.
- **Publish-key SPOF.** A single npm identity can publish (or be compromised to
  publish) every package.
- **Org-owner SPOF.** A single GitHub-org owner controls repository access,
  branch protection, and releases.

We state this plainly rather than hide it; prospective adopters should weigh it.

## Path to multi-owner

The active plan to reduce bus-factor risk, in priority order:

1. Recruit at least one co-maintainer with publish rights and a real review
   track record.
2. Move the `@declaragent/*` packages to multi-owner under the npm org
   (`npm owner add <user> @declaragent/<pkg>` for each package).
3. Add a second GitHub-org owner so repository and release control is not held by
   one account.
4. Document a key-rotation / handoff runbook (npm tokens, GitHub org access, the
   `security@declaragent.dev` mailbox) so ownership can transfer cleanly.

This is the plan, not a promise of named people — no co-maintainer has been
recruited yet. This document will be revised when one is.

## AI-authorship transparency

A substantial share of this codebase is co-authored by Claude (Anthropic) under
a single human reviewer. This is visible in the commit trailers
(`Co-Authored-By: Claude …`) and is documented in
[CLAUDE.md](./CLAUDE.md) and the capability ledger in [AGENTS.md](./AGENTS.md).

- The human reviewer is the **accountable owner** and the final quality gate for
  every change that lands.
- This is **disclosed, not hidden.** For an agent runtime, "built substantially
  by an AI agent under one human reviewer" is a fact worth stating up front so
  evaluators can judge it for themselves.
- The honest implication for production-readiness: review throughput is bounded
  by one human, which is part of the bus-factor-one risk above.

## Changing this document

Governance changes go through pull request review by the maintainer. This
document will be revised when a co-maintainer is added, when ownership is moved
to a multi-owner model, or when the maintainer model otherwise changes.

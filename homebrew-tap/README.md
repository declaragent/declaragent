# declaragent/homebrew-tap

This directory is the seed for the `declaragent/homebrew-tap` repository
that serves `brew install declaragent/tap/declaragent`.

It lives alongside the main monorepo during bootstrap so the formula
template + its update pipeline are developed in lockstep with the
release binaries workflow (`.github/workflows/release-binaries.yml`).

Once `declaragent/homebrew-tap` exists as its own GitHub repo, the
`Formula/` directory here gets copied over and the tap repo becomes
the source of truth. The monorepo's release workflow will open a PR
against the tap repo after every binary-producing release.

## Install

```sh
brew tap declaragent/tap
brew install declaragent
```

## Formula anatomy

`Formula/declaragent.rb` uses Homebrew's standard `binary` formula
shape. Placeholder tokens (`{{VERSION}}`, `{{SHA256_DARWIN_ARM64}}`,
etc.) are replaced at release time by the workflow that promotes a
new version. A future slice will automate the promotion PR via
`homebrew/actions/setup-homebrew` + `gh pr create`; until then the
tokens are stamped by hand when cutting a release.

## Roadmap (from `docs/PHASE_7_PLAN.md` §4.3)

- **Primary** — submit a canonical formula to homebrew-core. Review
  typically takes 1–2 weeks.
- **Fallback** — keep the `declaragent/tap` formula live from day 1 of
  Phase 7. The two paths coexist: users who prefer core can switch when
  homebrew-core accepts the PR, but nothing blocks the GA launch.

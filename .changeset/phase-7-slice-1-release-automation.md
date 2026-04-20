---
---

Phase 7 slice 1: release automation skeleton.

Infrastructure-only. No package source changes — so no version bump
on any workspace. Ships the scaffolding every binary-producing path
depends on.

- **`scripts/build-binary.sh`**. Portable helper — `build-binary.sh
  <target>` runs `bun build --compile --minify --target=bun-<target>
  --external react-devtools-core` over `packages/cli/src/index.tsx`,
  emits a tarball + SHA-256 checksum in `dist/bin/`, and fails fast if
  the binary blows the size budget. Default budget: 120 MiB, overridable
  via `DECLARAGENT_SIZE_BUDGET_MB`. Locally smoke-tested on
  `darwin-arm64` — binary lands at ~59 MiB.
  - `react-devtools-core` is marked `--external` because Ink imports
    it statically but only invokes it when `DEV=true`. The compiled
    single-file binary doesn't exercise that path; keeping the import
    as a bundle resolution failure is worse than an external stub.

- **`.github/workflows/release-binaries.yml`**. New workflow, two
  triggers:
  - **Tag push (`v*`)**: matrix-builds linux / darwin × x64 / arm64,
    uploads `declaragent-<target>.tar.gz` + `.sha256` artifacts,
    publishes them to the matching GitHub release (creating the
    release with auto-generated notes if the changesets workflow
    hasn't already). Every release also gains an aggregated
    `SHA256SUMS` file for `sha256sum -c`.
  - **`workflow_dispatch`**: dry-run. Builds every target + writes
    checksums to the workflow run summary. Never touches a release.
    Lets us rehearse the release before cutting a real tag.

- **`homebrew-tap/`**. Seed directory for the `declaragent/homebrew-tap`
  repo. `Formula/declaragent.rb` is the template the release pipeline
  stamps with the real version + per-target SHA-256s; `README.md`
  captures the bootstrap plan (live from day 1 as a tap; submit to
  homebrew-core in parallel per the plan's §4.3).

**Known gap (tracked for slice 1.5).** macOS binaries are not yet
signed / notarized. Locally-built `.tar.gz` binaries pick up the
`com.apple.provenance` xattr on macOS 14+ and Gatekeeper SIGKILLs them
until the Apple Developer / `codesign` / `notarytool` pipeline lands.
CI binaries still satisfy the Linux quickstart path; the install
script in slice 2 will document the macOS workaround until 1.5 lands.

**Unblocks.** Slices 3 (npm + Homebrew packaging), 4 (init wizard —
needs the binary to verify the install), 5 (template packs), and 6
(Cloud Run deploy path — uses the Linux binary).

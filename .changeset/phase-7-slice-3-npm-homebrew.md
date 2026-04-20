---
'@declaragent/cli': patch
---

Phase 7 slice 3: npm + Homebrew packaging.

`@declaragent/cli` now ships via both canonical paths. Users on
ubuntu / macos-13 / macos-14 can `npm install -g @declaragent/cli`
(or `brew install declaragent/tap/declaragent`, once the tap repo is
live) and land the same single-file binary the curl-installer writes.

- **npm postinstall shim** (`packages/cli/bin/postinstall.js`). Pure
  Node (no deps). Detects `(process.platform, process.arch)` and maps
  to `linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64`,
  mirroring `scripts/install.sh`. Downloads the tarball + `.sha256`
  from the matching GitHub release, verifies the hash, and extracts
  the binary into `bin/declaragent-binary/declaragent` inside the
  installed npm package. Strips the `com.apple.provenance` xattr on
  macOS so Gatekeeper doesn't SIGKILL the binary on first run.

- **Node launcher** (`packages/cli/bin/declaragent.js`). Registered
  as the `bin` entry. Exec's the downloaded binary, forwarding argv,
  stdio, and env. Prints a one-line recovery hint if the postinstall
  was skipped (e.g. `DECLARAGENT_NO_POSTINSTALL=1` or a sandboxed
  install blocked the network).

- **Opt-outs** (documented in `packages/cli/bin/README.md`):
  - `DECLARAGENT_NO_POSTINSTALL=1` — skip the download; `npm install`
    still succeeds so air-gapped installs can bring their own binary.
  - `DECLARAGENT_BASE_URL=<url>` — override the release origin.
    Accepts `file://<dir>` for mirrors + the CI smoke test.
  - `DECLARAGENT_VERSION=vX.Y.Z` — pin a specific tag.
  - Windows: prints a "run under WSL2" hint and exits 0 (never fails
    `npm install`).

- **Homebrew formula stamper** (`scripts/stamp-homebrew-formula.sh`).
  POSIX `/bin/sh`, `shellcheck -s sh` clean, idempotent. Takes
  `--version` + the four per-target SHA-256 flags, validates each
  hash is a 64-char hex digest, and writes a stamped copy of
  `homebrew-tap/Formula/declaragent.rb`. Uses `awk` (not `sed`) for
  the literal `{{TOKEN}}` swap to dodge BSD/GNU delimiter quirks.

- **`release-binaries.yml` stamp-homebrew job**. New tail job on the
  tag-triggered pipeline: downloads the SHA-256 artifacts, extracts
  the first-column hash from each, calls the stamper, validates the
  output with `ruby -c`, and uploads the stamped formula as a
  `homebrew-formula` artifact. The PR-open step against
  `declaragent/homebrew-tap` is stubbed until that repo + its deploy
  token exist.

- **`.github/workflows/npm-install-smoke.yml`**. Two jobs:
  - `npm-install` — matrix on ubuntu-latest / macos-13 / macos-14.
    Each runner compiles its own target via `build-binary.sh`,
    stages a release-layout tree, `npm pack`s the CLI, sets
    `DECLARAGENT_BASE_URL=file://<stage>`, `npm install -g`s the
    tarball, and asserts `declaragent --version` prints
    `declaragent X.Y.Z`. Uses a user-writable `npm config set prefix`
    to avoid `sudo`.
  - `stamp-formula` — runs shellcheck + the stamper against fixture
    hashes, asserts no `{{...}}` placeholders remain, `ruby -c`s the
    output, and re-runs the stamper to verify byte-for-byte idempotency.

**Notes.**
- `packages/cli/package.json` now pinpoints `"bin": { "declaragent":
  "./bin/declaragent.js" }` instead of `./dist/index.js`. The old
  entry point is still valid for the `bun run dev` path; `dist/` is
  still published in `files` for programmatic importers.
- Locally validated `bun run typecheck`, `bun test`, `bun run lint`,
  `bun run build`, `/bin/sh -n scripts/stamp-homebrew-formula.sh`,
  and `npm pack --dry-run` (confirmed `bin/postinstall.js` +
  `bin/declaragent.js` are included, 1520 existing tests still pass).

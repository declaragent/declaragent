---
'@declaragent/cli': patch
---

Phase 7 slice 2: `curl`-bash installer.

`declaragent` now ships a one-command install path. Ops teams can run
`curl -sSL https://get.declaragent.dev | sh` on a clean laptop and
land a working binary in under two minutes.

- **`scripts/install.sh`**. Portable `/bin/sh` installer. Detects OS
  + arch (`linux-{x64,arm64}` / `darwin-{x64,arm64}`), fetches the
  tarball + `.sha256` from GitHub releases, verifies the hash, and
  extracts into `$HOME/.local/bin/declaragent` (override via
  `DECLARAGENT_PREFIX`). Environment knobs:
  - `DECLARAGENT_VERSION` — pin to a tag (default `latest`).
  - `DECLARAGENT_PREFIX` — install prefix (default `$HOME/.local`).
  - `DECLARAGENT_BASE_URL` — release base URL (used by the CI smoke
    test; defaults to the GitHub release origin).
  - `DECLARAGENT_NO_CHECKSUM` — explicit escape hatch, never advised.
  - `HTTPS_PROXY` — honored transparently via `curl` / `wget`.
  Exits non-zero on checksum mismatch (`1`), unsupported OS/arch
  (`2`), or any download / extraction failure (`1`).
  macOS 14+'s `com.apple.provenance` xattr (Gatekeeper kill) is
  stripped at install time so the extracted binary runs immediately
  until the slice-1.5 notarization pipeline lands.

- **`declaragent --version` / `-v`**. New CLI flag that prints
  `declaragent <version>` + exits 0. Reuses the existing
  `@declaragent/core` `VERSION` constant — both packages version in
  lockstep via changesets, so the source of truth stays single.

- **`.github/workflows/installer-smoke.yml`**. Three jobs:
  - `shellcheck` — lints `install.sh` (`-s sh`) and `build-binary.sh`
    (`-s bash`). Catches bashisms sneaking into the POSIX script.
  - `install` — hermetic end-to-end: builds a `linux-x64` tarball via
    `scripts/build-binary.sh`, serves it with a local
    `python3 -m http.server`, runs `install.sh` against it, and
    asserts `declaragent --version` prints `declaragent X.Y.Z`.
  - `checksum-mismatch` — corrupts the `.sha256` file and verifies
    `install.sh` refuses to install.

**Locally validated.** Ran the installer end-to-end against a
darwin-arm64 tarball served from `python3 -m http.server`:
  - Happy path: download → sha256 verify → extract → install.
    Prints a PATH-export hint when the prefix isn't on `$PATH`.
  - Checksum mismatch: aborts cleanly with non-zero exit + no
    binary written to the prefix.
  - Unsupported arch: exits 2 with the fix hint
    (`Windows users: install via npm`).

**Still open (slice 1.5 + 3).**
  - macOS binaries are not yet notarized. The `xattr -cr` hack keeps
    slice-2 local installs working on modern macOS; the real fix is
    `codesign` + `notarytool` in the release pipeline.
  - The `declaragent.dev` / `get.declaragent.dev` domain isn't live
    yet. Until then, installers served from the GitHub release origin
    still work via `curl -sSL <raw-install.sh-url> | sh`.

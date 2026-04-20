#!/bin/sh
# scripts/install.sh — curl-pipe installer for `declaragent`.
#
# Phase 7 slice 2. Served from https://get.declaragent.dev/install.sh
# (Cloudflare Workers seat in front of this file, version-pinned).
#
# Usage (one-liner):
#   curl -sSL https://get.declaragent.dev | sh
#
# Usage (pinned version):
#   curl -sSL https://get.declaragent.dev | DECLARAGENT_VERSION=v1.0.2 sh
#
# Usage (custom prefix):
#   curl -sSL https://get.declaragent.dev | DECLARAGENT_PREFIX=/opt/declaragent sh
#
# Environment overrides:
#   DECLARAGENT_VERSION        Tag to install. `latest` (default) asks the
#                              GitHub release redirect for the newest tag.
#   DECLARAGENT_PREFIX         Install prefix. Default `$HOME/.local`.
#                              Binary lands in `$PREFIX/bin/declaragent`.
#   DECLARAGENT_BASE_URL       Release base URL. Default
#                              `https://github.com/declaragent/declaragent/releases`.
#                              Used by the CI smoke test to point at a
#                              local HTTP server.
#   DECLARAGENT_NO_CHECKSUM    Any non-empty value skips the SHA-256
#                              verify step. Strictly for CI reproduction
#                              of a known bug; never use in production.
#
# Portable-POSIX constraints:
#   - `/bin/sh` only — no bashisms, no `[[ ]]`, no `echo -e`.
#   - Every tool used is validated with `command -v` before use.
#   - Respects `HTTPS_PROXY` via the underlying `curl` + `wget`.
#
# Exit codes:
#   0   success
#   1   generic failure (download, extract, checksum, …)
#   2   unsupported OS / arch

set -eu

# ── helpers ───────────────────────────────────────────────────────────

err() {
  printf '%s\n' "$*" >&2
}

die() {
  err "✗ $*"
  exit "${2:-1}"
}

info() {
  printf '%s\n' "$*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# ── config ────────────────────────────────────────────────────────────

VERSION="${DECLARAGENT_VERSION:-latest}"
PREFIX="${DECLARAGENT_PREFIX:-$HOME/.local}"
BASE_URL="${DECLARAGENT_BASE_URL:-https://github.com/declaragent/declaragent/releases}"

# ── detect target triple ──────────────────────────────────────────────

OS="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "$OS-$ARCH" in
  linux-x86_64|linux-amd64)    TARGET=linux-x64 ;;
  linux-aarch64|linux-arm64)   TARGET=linux-arm64 ;;
  darwin-x86_64|darwin-amd64)  TARGET=darwin-x64 ;;
  darwin-arm64)                TARGET=darwin-arm64 ;;
  *)
    die "unsupported OS/arch: $OS $ARCH
  Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64
  Windows users: install via npm — \`npm install -g @declaragent/cli\`" 2
    ;;
esac

# ── resolve download URLs ─────────────────────────────────────────────

# `latest` resolves via GitHub's `releases/latest/download/<asset>`
# redirect. Pinned versions use `releases/download/<tag>/<asset>`.
if [ "$VERSION" = "latest" ]; then
  TARBALL_URL="$BASE_URL/latest/download/declaragent-$TARGET.tar.gz"
  CHECKSUM_URL="$BASE_URL/latest/download/declaragent-$TARGET.sha256"
else
  TARBALL_URL="$BASE_URL/download/$VERSION/declaragent-$TARGET.tar.gz"
  CHECKSUM_URL="$BASE_URL/download/$VERSION/declaragent-$TARGET.sha256"
fi

# ── stage directory ───────────────────────────────────────────────────

TMPDIR_ROOT="${TMPDIR:-/tmp}"
STAGE="$(mktemp -d "$TMPDIR_ROOT/declaragent-install.XXXXXX")"
# Portable cleanup — some /bin/sh's on BSD don't support `trap ... EXIT`
# with multi-signal lists the same way, so keep it terse.
cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT INT HUP TERM

cd "$STAGE"

# ── download ──────────────────────────────────────────────────────────

download() {
  _url="$1"
  _out="$2"
  if have curl; then
    # `-f` makes curl exit non-zero on HTTP errors (default returns the
    # 404 body as content). `-L` follows the GitHub latest redirect.
    curl -fsSL --retry 3 --retry-delay 2 -o "$_out" "$_url" || return 1
  elif have wget; then
    wget -q --tries=3 --waitretry=2 -O "$_out" "$_url" || return 1
  else
    die "neither curl nor wget is installed — cannot fetch $_url"
  fi
}

info "→ downloading declaragent ($VERSION) for $TARGET"
download "$TARBALL_URL" "declaragent-$TARGET.tar.gz" \
  || die "download failed: $TARBALL_URL
  Check your network + DECLARAGENT_BASE_URL."

if [ -z "${DECLARAGENT_NO_CHECKSUM:-}" ]; then
  download "$CHECKSUM_URL" "declaragent-$TARGET.sha256" \
    || die "checksum download failed: $CHECKSUM_URL"
fi

# ── verify checksum ───────────────────────────────────────────────────

if [ -z "${DECLARAGENT_NO_CHECKSUM:-}" ]; then
  info "→ verifying SHA-256"
  expected="$(awk '{print $1}' < "declaragent-$TARGET.sha256")"
  if [ -z "$expected" ]; then
    die "checksum file is empty — refusing to proceed"
  fi
  if have sha256sum; then
    actual="$(sha256sum "declaragent-$TARGET.tar.gz" | awk '{print $1}')"
  elif have shasum; then
    actual="$(shasum -a 256 "declaragent-$TARGET.tar.gz" | awk '{print $1}')"
  else
    die "neither sha256sum nor shasum found — cannot verify integrity.
  Install one, or re-run with DECLARAGENT_NO_CHECKSUM=1 to skip (not recommended)."
  fi
  if [ "$expected" != "$actual" ]; then
    die "checksum mismatch!
  expected: $expected
  actual:   $actual
  Re-download or report at https://github.com/declaragent/declaragent/issues."
  fi
  info "  sha256: $actual"
fi

# ── extract + install ─────────────────────────────────────────────────

info "→ extracting"
tar -xzf "declaragent-$TARGET.tar.gz"
# Tarball layout matches scripts/build-binary.sh: a single directory
# `declaragent-<target>/` containing the executable plus LICENSE.
if [ ! -x "declaragent-$TARGET/declaragent" ]; then
  die "extracted tarball has no declaragent-$TARGET/declaragent binary.
  The tarball may be corrupt — re-download or open an issue."
fi

BIN_DIR="$PREFIX/bin"
mkdir -p "$BIN_DIR"

TARGET_PATH="$BIN_DIR/declaragent"
info "→ installing to $TARGET_PATH"
# `cp` then `chmod` is safer than `install` which isn't in every BSD
# base system. Preserve executable bit explicitly.
cp "declaragent-$TARGET/declaragent" "$TARGET_PATH"
chmod +x "$TARGET_PATH"

# macOS 14+ slaps a `com.apple.provenance` extended attribute on freshly
# written binaries and Gatekeeper SIGKILLs them on first run. Until the
# release pipeline ships notarized bundles (slice 1.5), strip the attr
# at install time. The operation is safe everywhere — `xattr` is a no-op
# on Linux.
if [ "$OS" = "darwin" ] && have xattr; then
  xattr -cr "$TARGET_PATH" 2>/dev/null || true
fi

# ── PATH hint ─────────────────────────────────────────────────────────

# Many users install from a shell where `$BIN_DIR` isn't on PATH yet.
# Detect that + print the exact export line they need. Never modify
# rc files on their behalf — too risky.
case ":$PATH:" in
  *":$BIN_DIR:"*)
    PATH_NEEDED=0 ;;
  *)
    PATH_NEEDED=1 ;;
esac

info ""
info "✓ declaragent installed."
if [ "$PATH_NEEDED" = "1" ]; then
  info ""
  info "  ⚠  $BIN_DIR is not on your PATH."
  info "     Add it with:"
  info ""
  info "         export PATH=\"$BIN_DIR:\$PATH\""
  info ""
  info "     Then re-open your shell, or run the binary directly:"
  info ""
  info "         $TARGET_PATH --version"
else
  info ""
  info "  Next: run \`declaragent --version\` to confirm, then"
  info "  \`declaragent init\` to scaffold your first agent."
fi

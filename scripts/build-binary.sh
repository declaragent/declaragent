#!/usr/bin/env bash
# scripts/build-binary.sh — produce one Bun-compiled `declaragent` binary.
#
# Phase 7 slice 1. Called from `.github/workflows/release-binaries.yml`
# for each target triple in the release matrix; also usable locally when
# a developer wants to validate the compile path without waiting for CI.
#
# Usage:
#   scripts/build-binary.sh <target>
#
# Targets (Bun --target values):
#   linux-x64     linux-arm64     darwin-x64     darwin-arm64
#
# Output (relative to repo root):
#   dist/bin/declaragent-<target>            single executable
#   dist/bin/declaragent-<target>.tar.gz     tarball (binary + LICENSE)
#   dist/bin/declaragent-<target>.sha256     SHA-256 of the tarball
#
# Environment overrides:
#   DECLARAGENT_SIZE_BUDGET_MB  (default 120) — fail if binary exceeds.
#   DECLARAGENT_VERSION         (default: CLI package version) stamped
#                               into the filename / tarball layout.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: scripts/build-binary.sh <target>" >&2
  echo "  supported: linux-x64 linux-arm64 darwin-x64 darwin-arm64" >&2
  exit 2
fi

case "$TARGET" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;;
  *)
    echo "unsupported target: $TARGET" >&2
    echo "  supported: linux-x64 linux-arm64 darwin-x64 darwin-arm64" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SIZE_BUDGET_MB="${DECLARAGENT_SIZE_BUDGET_MB:-120}"

VERSION="${DECLARAGENT_VERSION:-}"
if [ -z "$VERSION" ]; then
  # Pull from packages/cli/package.json without a node dep; jq is not
  # available on every runner, so grep-extract instead.
  VERSION=$(grep '"version"' packages/cli/package.json | head -n1 | sed -E 's/.*"version": *"([^"]+)".*/\1/')
fi
# CI passes `github.ref_name` which already starts with `v`; strip any
# leading `v` here so the log + tarball don't show `vv0.1.1`.
VERSION="${VERSION#v}"

OUT_DIR="dist/bin"
BIN_NAME="declaragent-${TARGET}"
BIN_PATH="${OUT_DIR}/${BIN_NAME}"
TARBALL_PATH="${OUT_DIR}/${BIN_NAME}.tar.gz"
CHECKSUM_PATH="${OUT_DIR}/${BIN_NAME}.sha256"

mkdir -p "$OUT_DIR"
rm -f "$BIN_PATH" "$TARBALL_PATH" "$CHECKSUM_PATH"

echo "→ compiling declaragent for bun-${TARGET} (v${VERSION})"
# Ink statically imports `react-devtools-core`; marking it `--external`
# produces a binary that crashes at startup with `Cannot find package
# 'react-devtools-core' from /$bunfs/root/...` because the compiled
# single-file binary has no node_modules to fall back to. Bundling it
# adds ~1 MiB — well under the size budget — and the binary starts
# cleanly. The react-devtools websocket never connects unless DEV=true.
bun build \
  --compile \
  --minify \
  --target="bun-${TARGET}" \
  --outfile="$BIN_PATH" \
  packages/cli/src/index.tsx

if [ ! -f "$BIN_PATH" ]; then
  echo "✗ build did not produce $BIN_PATH" >&2
  exit 1
fi

# Size budget — guards against Bun runtime bloat sneaking in over time.
SIZE_BYTES=$(wc -c <"$BIN_PATH" | tr -d ' ')
SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
echo "  size: ${SIZE_MB} MiB (budget ${SIZE_BUDGET_MB} MiB)"
if [ "$SIZE_MB" -gt "$SIZE_BUDGET_MB" ]; then
  echo "✗ binary exceeds size budget (${SIZE_MB} MiB > ${SIZE_BUDGET_MB} MiB)" >&2
  echo "  tip: bun build --analyze to find the offending module" >&2
  exit 1
fi

# Tarball layout: a single-directory archive so `tar xzf` expands to
# `declaragent-<target>/{declaragent,LICENSE,README.md}`. The binary
# inside the archive is named `declaragent` (without the target suffix)
# so Homebrew + the curl-installer place it at `$PREFIX/bin/declaragent`
# without renaming.
STAGE_DIR="${OUT_DIR}/stage-${TARGET}"
rm -rf "$STAGE_DIR"
mkdir -p "${STAGE_DIR}/${BIN_NAME}"
cp "$BIN_PATH" "${STAGE_DIR}/${BIN_NAME}/declaragent"
chmod +x "${STAGE_DIR}/${BIN_NAME}/declaragent"
if [ -f LICENSE ]; then cp LICENSE "${STAGE_DIR}/${BIN_NAME}/LICENSE"; fi
if [ -f README.md ]; then cp README.md "${STAGE_DIR}/${BIN_NAME}/README.md"; fi

tar -czf "$TARBALL_PATH" -C "$STAGE_DIR" "$BIN_NAME"
rm -rf "$STAGE_DIR"

# SHA-256 checksum in the canonical `<hash>  <filename>` format used by
# `sha256sum -c` and Homebrew's `sha256` stanza.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "${BIN_NAME}.tar.gz" >"$(basename "$CHECKSUM_PATH")")
else
  # macOS default — no sha256sum, has shasum.
  (cd "$OUT_DIR" && shasum -a 256 "${BIN_NAME}.tar.gz" >"$(basename "$CHECKSUM_PATH")")
fi

echo "✓ ${BIN_NAME}"
echo "  binary:   $BIN_PATH"
echo "  tarball:  $TARBALL_PATH"
echo "  checksum: $(cat "$CHECKSUM_PATH")"

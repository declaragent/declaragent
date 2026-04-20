#!/bin/sh
# scripts/stamp-homebrew-formula.sh — stamp the Homebrew formula template.
#
# Phase 7 slice 3. Called by the release pipeline after the four
# per-target tarballs + `.sha256` files are built. Reads
# `homebrew-tap/Formula/declaragent.rb`, substitutes the four
# placeholder tokens with the release version + SHA-256 hashes, and
# writes a stamped formula to the chosen output path.
#
# Usage:
#   scripts/stamp-homebrew-formula.sh \
#     --version v1.2.3 \
#     --sha256-darwin-arm64 <hash> \
#     --sha256-darwin-x64   <hash> \
#     --sha256-linux-arm64  <hash> \
#     --sha256-linux-x64    <hash> \
#     [--output dist/homebrew/declaragent.rb] \
#     [--template homebrew-tap/Formula/declaragent.rb]
#
# Idempotent: running twice with the same inputs produces the same
# output file. No network access, no git side effects — the PR-open
# step in the release workflow consumes the file this script writes.
#
# Portable-POSIX constraints:
#   - `/bin/sh` only — no bashisms, no `[[ ]]`, no arrays, no `local`.
#   - `shellcheck -s sh` clean.
#
# Exit codes:
#   0  success
#   1  generic failure (missing args, template missing, bad hash, …)
#   2  usage error

set -eu

err() {
  printf '%s\n' "$*" >&2
}

die() {
  err "stamp-homebrew-formula: $*"
  exit "${2:-1}"
}

usage() {
  cat >&2 <<'EOF'
usage: scripts/stamp-homebrew-formula.sh \
         --version <vX.Y.Z> \
         --sha256-darwin-arm64 <hash> \
         --sha256-darwin-x64   <hash> \
         --sha256-linux-arm64  <hash> \
         --sha256-linux-x64    <hash> \
         [--output <path>] \
         [--template <path>]
EOF
}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

VERSION=""
SHA_DARWIN_ARM64=""
SHA_DARWIN_X64=""
SHA_LINUX_ARM64=""
SHA_LINUX_X64=""
OUTPUT=""
TEMPLATE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version)              VERSION="${2:-}"; shift 2 ;;
    --sha256-darwin-arm64)  SHA_DARWIN_ARM64="${2:-}"; shift 2 ;;
    --sha256-darwin-x64)    SHA_DARWIN_X64="${2:-}"; shift 2 ;;
    --sha256-linux-arm64)   SHA_LINUX_ARM64="${2:-}"; shift 2 ;;
    --sha256-linux-x64)     SHA_LINUX_X64="${2:-}"; shift 2 ;;
    --output)               OUTPUT="${2:-}"; shift 2 ;;
    --template)             TEMPLATE="${2:-}"; shift 2 ;;
    -h|--help)              usage; exit 0 ;;
    *)
      err "unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [ -z "$VERSION" ] \
   || [ -z "$SHA_DARWIN_ARM64" ] \
   || [ -z "$SHA_DARWIN_X64" ] \
   || [ -z "$SHA_LINUX_ARM64" ] \
   || [ -z "$SHA_LINUX_X64" ]; then
  err "missing required argument(s)."
  usage
  exit 2
fi

# Strip a single leading `v` so the formula's `version "X.Y.Z"`
# stanza stays clean — Homebrew conventionally omits the `v`.
case "$VERSION" in
  v*) VERSION_BARE="${VERSION#v}" ;;
  *)  VERSION_BARE="$VERSION" ;;
esac

# Validate version is semver-ish (digits + dots, optional pre-release).
case "$VERSION_BARE" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "invalid --version: $VERSION (expected vX.Y.Z)" ;;
esac

# Validate each SHA looks like a sha256 hex digest. The release
# workflow reads `<hash>  <filename>` lines from `.sha256` files, so
# callers should pass the first word. We guard against anyone passing
# the whole line accidentally by stripping whitespace then checking.
validate_sha() {
  _name="$1"
  _val="$2"
  # Strip leading/trailing whitespace without bashisms.
  _val="$(printf '%s' "$_val" | tr -d '\r\n\t ')"
  _len="$(printf '%s' "$_val" | wc -c | tr -d ' ')"
  if [ "$_len" -ne 64 ]; then
    die "$_name: expected 64-char sha256, got $_len chars"
  fi
  case "$_val" in
    *[!0-9a-fA-F]*) die "$_name: contains non-hex characters" ;;
  esac
  # Normalize to lowercase for deterministic output.
  printf '%s' "$_val" | tr '[:upper:]' '[:lower:]'
}

SHA_DARWIN_ARM64="$(validate_sha --sha256-darwin-arm64 "$SHA_DARWIN_ARM64")"
SHA_DARWIN_X64="$(validate_sha --sha256-darwin-x64 "$SHA_DARWIN_X64")"
SHA_LINUX_ARM64="$(validate_sha --sha256-linux-arm64 "$SHA_LINUX_ARM64")"
SHA_LINUX_X64="$(validate_sha --sha256-linux-x64 "$SHA_LINUX_X64")"

if [ -z "$TEMPLATE" ]; then
  TEMPLATE="$REPO_ROOT/homebrew-tap/Formula/declaragent.rb"
fi
if [ -z "$OUTPUT" ]; then
  OUTPUT="$REPO_ROOT/dist/homebrew/declaragent.rb"
fi

if [ ! -f "$TEMPLATE" ]; then
  die "template not found: $TEMPLATE"
fi

OUTPUT_DIR="$(dirname "$OUTPUT")"
mkdir -p "$OUTPUT_DIR"

# Use a tempfile + atomic rename so a concurrent CI job can't observe
# a half-written file. The substitution is a literal `{{TOKEN}}` swap
# (no regex metacharacters appear in version strings or hex digests).
TMP_OUT="${OUTPUT}.tmp.$$"
cleanup() { rm -f "$TMP_OUT"; }
trap cleanup EXIT INT HUP TERM

# `awk` chosen over `sed` because sed's substitution delimiter handling
# varies across BSD/GNU and Homebrew-audited formulae sometimes contain
# `/` in URLs. `gsub` with a plain string works consistently.
awk \
  -v version="$VERSION_BARE" \
  -v sha_darwin_arm64="$SHA_DARWIN_ARM64" \
  -v sha_darwin_x64="$SHA_DARWIN_X64" \
  -v sha_linux_arm64="$SHA_LINUX_ARM64" \
  -v sha_linux_x64="$SHA_LINUX_X64" \
  '
  {
    gsub(/\{\{VERSION\}\}/, version)
    gsub(/\{\{SHA256_DARWIN_ARM64\}\}/, sha_darwin_arm64)
    gsub(/\{\{SHA256_DARWIN_X64\}\}/, sha_darwin_x64)
    gsub(/\{\{SHA256_LINUX_ARM64\}\}/, sha_linux_arm64)
    gsub(/\{\{SHA256_LINUX_X64\}\}/, sha_linux_x64)
    print
  }
  ' "$TEMPLATE" > "$TMP_OUT"

# Belt-and-braces: the stamped file must not still contain any
# `{{TOKEN}}` placeholders. Catches typos in the template.
if grep -q '{{[A-Z0-9_]*}}' "$TMP_OUT"; then
  err "stamped formula still contains placeholders:"
  grep -n '{{[A-Z0-9_]*}}' "$TMP_OUT" >&2
  exit 1
fi

mv "$TMP_OUT" "$OUTPUT"
trap - EXIT INT HUP TERM

printf 'stamped %s (version=%s)\n' "$OUTPUT" "$VERSION_BARE"

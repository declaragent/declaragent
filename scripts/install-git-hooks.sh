#!/usr/bin/env bash
#
# One-time install: point git at `.githooks/` so the repo's drift-guard
# pre-push hook is active for the current clone. Idempotent — safe to
# re-run.
#
# Invoked via `bun run hooks:install` or directly
# (`./scripts/install-git-hooks.sh`).
#
# See:
#   - .githooks/pre-push
#   - docs/POST_ENTERPRISE_BACKLOG.md #48, #49
#
# @since 0.7.2
set -eu

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

current="$(git config --get core.hooksPath || echo "")"
if [ "$current" = ".githooks" ]; then
  echo "hooks: core.hooksPath already set to .githooks — nothing to do."
  exit 0
fi

git config core.hooksPath .githooks
echo "hooks: set core.hooksPath = .githooks"
echo "hooks: .githooks/pre-push is now active on \`git push\`."

# Contributing

Early-stage project. Expect churn.

## Dev loop

```bash
bun install
bun run typecheck    # tsc across all packages
bun test             # bun test across all packages
bun run build        # build all packages
bun run lint         # biome check
bun run lint:fix     # biome auto-fix
```

## Commit & release

We use [changesets](https://github.com/changesets/changesets) for versioning.

1. Make your change.
2. Run `bun run changeset` and describe the change.
3. Commit the generated `.changeset/*.md` file alongside your code.
4. On merge to `main`, the release workflow opens a "Version Packages" PR. Merging that PR publishes to npm.

## Code style

Biome handles formatting and linting. Run `bun run lint:fix` before pushing.

## TypeScript

Strict mode is enforced at the repo level (`tsconfig.base.json`). No `any` escape hatches without discussion.

## CI status & green-before-merge

The scheduled integration workflows are the project's load-bearing signal:

- **`nightly-integration`** — daily Kafka + NATS fleet-RPC round-trip.
- **`weekly-soak`** — Sunday 24h Kafka soak.

Each run writes a machine-readable `STATUS.json` artifact (`status`, per-job `conclusion`,
ISO `timestamp`, `commit`, `run_url`) named `status-json-<run_id>`, on green and red alike.
That artifact — not hardcoded site copy — is the live signal. The human-readable summary
lives in [`docs/STATUS.md`](./docs/STATUS.md).

**Green-before-merge policy.** `nightly-integration` must be green before new feature work
merges. A red nightly is treated as a release blocker until it is either **fixed** or
**quarantined with a deadline** (an owner triages within one working day). Do not stack
feature PRs on a red nightly.

**Single rolling tracker per workflow.** Failures are consolidated into one rolling tracker
issue per workflow (find-or-create by a fixed label), one comment per failure — not one
issue per night/week:

- `ci-tracker:nightly-integration` → issue `[nightly-integration] rolling failure tracker`
- `ci-tracker:weekly-soak` → issue `[weekly-soak] rolling failure tracker`

**Quarantine label convention.** When triaging a failure (on the tracker comment and, if
applicable, the failing test), apply exactly one:

- `quarantine:flake` — transient/infra flake. Allowed to merge around, **but the comment
  must carry a deadline** by which it is fixed or escalated.
- `quarantine:signal` — a real regression. **Blocks merges** until resolved; do not quarantine
  to unblock.

**Where to look.** Current signal: the `STATUS.json` artifact + [`docs/STATUS.md`](./docs/STATUS.md).
Failure history: the rolling tracker issue for the relevant workflow.

This is mechanism + policy only. We do **not** auto-invent fixes for failing tests; a red
run is triaged by a human into flake-vs-signal as above.

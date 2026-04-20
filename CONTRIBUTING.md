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

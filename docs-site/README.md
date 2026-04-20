# Declaragent docs site

Docusaurus 3.x site served at `https://declaragent.dev/docs/`.

This project lives outside the bun workspace on purpose — React / Docusaurus tooling must not pollute the core/cli TypeScript build. Maintainers install and run it independently via npm.

## Local dev

```sh
cd docs-site
npm install        # note: NOT `bun install`
npm run start      # http://localhost:3000/docs/
```

## Build

```sh
cd docs-site
npm run build
# output → docs-site/build/
```

The `.github/workflows/docs-site.yml` workflow runs the same `npm ci && npm run build` on every PR (PR check) and deploys to Cloudflare Pages on push to `main`.

## Regenerating the CLI reference

The page `docs/reference/cli.mdx` is generated from `packages/cli/src/index.tsx` by `scripts/docs-cli-extract.ts` (a Bun script at the repo root). Regenerate before editing:

```sh
# from the repo root
bun run scripts/docs-cli-extract.ts
```

Running it twice is idempotent.

## Versioning

Docusaurus supports per-version docs. v1.0 is the first tagged version; subsequent minors get their own sidebar. See `versions.json` (created when `npm run docusaurus docs:version 1.0` runs at release time).

## Search

Local, offline search is provided by [`@easyops-cn/docusaurus-search-local`](https://github.com/easyops-cn/docusaurus-search-local). A hosted Algolia DocSearch integration is a post-slice follow-up.

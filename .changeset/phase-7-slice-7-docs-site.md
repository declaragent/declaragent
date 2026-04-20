---
'@declaragent/core': patch
---

Phase 7 slice 7: Docusaurus docs site + auto-extraction pipeline.

A new `docs-site/` directory at the repo root (sibling to `packages/`)
hosts a Docusaurus 3.x site served from `https://declaragent.dev/docs/`.
The project is intentionally **outside** the bun workspace — React +
Docusaurus tooling must not pollute the core/cli TypeScript build.
Maintainers install it with `cd docs-site && npm install`; `bun install`
at the root is untouched.

Four top-level sections, mirroring `PHASE_7_PLAN.md §8`:

- **Quickstart** — the 10-minute path: curl / npm / brew install
  walkthrough with `<Tabs>` per path, first-agent wizard walkthrough.
- **Reference** — `agent.yaml` schema (hand-curated subset pending the
  slice-8 Zod generator), CLI reference (auto-extracted), env vars table,
  provider matrix, extension registry.
- **Cookbook** — one page per template (concierge, oncall-escalator,
  pr-review, kafka-pipeline, multi-tenant-starter) + four recipes
  (deploy-cloud-run, rotate-vault-secret, two-tenants-one-daemon,
  grafana-tracing).
- **Troubleshooting** — error-code table (EEXTCONFLICT, TENANT_BOUNDARY,
  EQUOTA, EPERM, ENOTOOL, ENOSESSION, EINVAL, EABORT), deploy-403
  flowchart (mermaid), install-failed flowchart (mermaid), and one
  stub MDX page per `runbook_url` shipped under
  `packages/testkit/alerts/` — 23 runbooks surfaced.

**Auto-extraction pipeline.** `scripts/docs-cli-extract.ts` reads the
`printHelp()` + `printInitHelp()` template literals from
`packages/cli/src/index.tsx` and writes them between BEGIN/END markers in
`docs-site/docs/reference/cli.mdx`. Idempotent — running twice produces
identical output. The CI workflow diffs the committed file against a
fresh extraction and fails the PR if they differ, so help-string drifts
get caught before merge.

**Docusaurus config.** Pinned to `3.10.0` exact (per the §16
risk-mitigation note on Docusaurus churn). `webpack` is pinned to
`5.97.1` via `overrides` + `resolutions` — later webpack 5.x minors
ship a stricter `ProgressPlugin` schema that `webpackbar` 6.x passes
options against and fails. The docs site will re-pin once `webpackbar`
publishes a compatible release. Local search via
`@easyops-cn/docusaurus-search-local` (Algolia DocSearch application is
a post-slice follow-up). `@docusaurus/theme-mermaid` plugin is wired in
for the two flowcharts in Troubleshooting. `organizationName`,
`projectName`, `url`, and `baseUrl` all match the spec
(`declaragent`/`declaragent`/`https://declaragent.dev`/`/docs/`).

**Versioning.** Docusaurus' per-version docs support is enabled via
`includeCurrentVersion: true`. `versions.json` is unwritten until
`npm run docusaurus docs:version 1.0` runs at release time.

**Workflow.** `.github/workflows/docs-site.yml` runs two jobs:
- `docs-build` on every PR — verifies the CLI reference is in sync,
  runs `npm ci && npm run build`, uploads the build as an artifact.
- `deploy` on push to `main` — downloads the artifact and uses the
  official `cloudflare/pages-action` with
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (stubbed until the
  repo owner wires the secrets).

**Touch points.** Disjoint from every other slice:
- New files under `docs-site/` (entire project tree).
- New script `scripts/docs-cli-extract.ts`.
- New workflow `.github/workflows/docs-site.yml`.
- This changeset.

Nothing under `packages/`, `templates/`, other `scripts/`, or existing
workflows was touched. Root `package.json` still lists
`"workspaces": ["packages/*", "examples/*"]`; docs-site stays out of the
bun workspace by design.

**Locally validated.**
- `bun run scripts/docs-cli-extract.ts` — writes + runs idempotent
  (second invocation prints `no changes`).
- `bun run typecheck` — unchanged baseline, 0 errors.
- `bun test` — 1594 pass / 19 skip / 0 fail across 152 files.
- `bun run lint` — 489 files checked, 0 errors. Root `.gitignore`
  gains a `.docusaurus` entry so biome doesn't trip on the Docusaurus
  build-time cache directory (parallel to the existing `build/` entry).
- `cd docs-site && bun run build` — generated static files in
  `docs-site/build`. The `npm ci && npm run build` equivalent runs in
  `.github/workflows/docs-site.yml` on every PR.

**Deferred / placeholder content.** Every stub page carries a
`[placeholder — landing 2026-Q2]` sentinel so grep can find them:
- 23 runbook pages are stubs; slice 7.5 inlines the canonical markdown
  under `docs/runbooks/`.
- Real screenshots land with slice 9 (Launch).
- `agent.yaml` reference is a hand-curated subset; slice 8's Zod →
  MDX generator replaces it.
- Nightly provider-matrix tests are aspirational; plumbing lands
  alongside the slice-8 generator.
- `@declaragent/plugin-github` is referenced by the `pr-review`
  cookbook page but not yet published.

**Post-slice follow-ups.**
- Wire `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets + the
  Cloudflare Pages project.
- Algolia DocSearch application.
- Link-checker step in the workflow (Docusaurus' `onBrokenLinks` is
  set to `warn` for now so slice 6 + 8 merges don't fail the docs
  build in-flight).
- `favicon.ico` + `declaragent-social-card.png` (placeholder SVG
  logo ships in this slice).

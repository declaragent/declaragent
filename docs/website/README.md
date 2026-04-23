# declaragent.dev — landing page (internal ops)

Internal playbook for the `declaragent.dev` landing page. The public
assets live in `website/` at the repo root; the non-public ops docs
(this file, brand system, OG spec, PostHog setup) live here in
`docs/website/` so they don't get served by the static deploy.

Static site. No build step. Deploy as-is to Cloudflare Pages.

## Deployed files — `website/` at repo root

| File | Purpose |
| --- | --- |
| `index.html` | Single-page landing. Hero → install → builder → honest status + just-shipped rail → capabilities → lifecycle → meta → enterprise → validator → star CTA. |
| `styles.css` | All styles. Dark-default, teal accent, JetBrains Mono + Inter, CSS variables, ✓/◐/○ status chips, receipt pills — the receipts-first visual system. |
| `app.js` | Typing terminal (with skip button) + install tab switcher + browser-port fleet validator + `track()` analytics helper routing `data-track="..."` clicks through `posthog.capture` + IntersectionObserver fade-in. |
| `favicon.svg` | Monochrome `d` glyph on accent background. |
| `og.svg` | 1200×630 social share card (terminal-styled, receipts-first). Replace with `og.png` once a designer lands one — see [`docs/website/OG_IMAGE_SPEC.md`](./OG_IMAGE_SPEC.md). |
| `install.sh` | The `curl \| sh` installer. Served as `text/plain` via `_headers`. |
| `_headers` | Cloudflare Pages HTTP header config (cache + security). |
| `.gitignore` | Local-only `.env` etc. |

Zero dependencies. Zero build step. Weighs ~22 KB gzipped.

## Internal ops docs — `docs/website/` (this folder)

| File | Purpose |
| --- | --- |
| `README.md` | This playbook. |
| `BRAND.md` | Brand system source-of-truth: voice, palette, typography, status chips, forbidden words, copy templates. |
| `OG_IMAGE_SPEC.md` | Detailed design brief for the PNG export. |
| `POSTHOG_SETUP.md` | Wizard report — PostHog dashboard + insight URLs. |

These are **not** deployed. `docs/` is internal.

## Analytics

PostHog is live (EU region, `eu.i.posthog.com`, cookieless, `person_profiles=identified_only`). The loader sits inline in `index.html` with the project API key. `track()` helper in `app.js` routes every `data-track="..."` click through `posthog.capture`. Event-name convention is `<section>:<action>` — see [`docs/website/BRAND.md §8`](./BRAND.md) for the full list.

## Local preview

```sh
npx serve website
# or: python3 -m http.server 8080 --directory website
```

Open http://localhost:3000 (or :8080).

## Deploy to Cloudflare Pages

### First time (via dashboard)

1. https://dash.cloudflare.com → Workers & Pages → Create application → Pages → Connect to Git
2. Pick the `declaragent/declaragent` repo (grant access to the `website/` subfolder at the repo root if prompted)
3. Build settings:
   - **Framework preset**: `None`
   - **Build command**: *(empty)*
   - **Build output directory**: `website`
   - **Root directory (optional)**: *(leave blank)*
4. Save and deploy.
5. Custom domain: Pages project → Custom domains → Set up → `declaragent.dev`. Cloudflare handles the cert automatically.

### Subsequent deploys (via CLI)

```sh
npx wrangler pages deploy website --project-name declaragent
```

Requires `wrangler login` once.

## What's novel

The "Try it — no install" section runs the actual slice-1 `fleet
validate` logic in the visitor's browser. The validator in `app.js`
mirrors the checks in `packages/cli/src/fleet-cli.ts`
(`peer.dangling`, `peer.client-only`, `capability.duplicate`,
`deploy.target.missing`) plus the schema-level invariants from
`packages/core/src/fleet/manifest-schema.ts`. Edit the YAML, click
**Validate**, and the same findings a user would see in their terminal
appear on the page — without any server round-trip.

The hero SVG is a real animation along a cubic bezier via
`getPointAtLength`, not a static image. Click either node (or press
<kbd>space</kbd>) to replay the request/response round-trip.

## Updating the validator

If slice-1 validation rules change in `packages/cli/src/fleet-cli.ts`,
mirror the same checks in `app.js → validateFleet()`. There's no
sharing (the validator is a browser-safe subset — no fs, no Zod
runtime) but the findings codes + messages should stay consistent.

Consider adding a one-line test in `packages/cli/src/fleet-cli.test.ts`
that snapshots the current set of finding codes, so drift between the
two surfaces is caught at CI time.

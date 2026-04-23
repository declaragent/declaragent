# declaragent.dev — landing page

Static site. No build step. Deploy as-is to Cloudflare Pages.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Single-page landing. Hero → install → builder → honest status + "not-yet" rail → capabilities → lifecycle → meta → enterprise → validator → star CTA. |
| `styles.css` | All styles. Dark-default, teal accent, JetBrains Mono + Inter, CSS variables, ✓/◐/○ status chips, receipt pills — the receipts-first visual system. |
| `app.js` | Typing terminal (with skip button) + install tab switcher + browser-port fleet validator + analytics stub (`track()` routes `data-track="..."` through Plausible once enabled) + IntersectionObserver fade-in. |
| `favicon.svg` | Monochrome `d` glyph on accent background. |
| `og.svg` | 1200×630 social share card (terminal-styled, receipts-first). Replace with `og.png` once a designer lands one — see `OG_IMAGE_SPEC.md`. |
| `OG_IMAGE_SPEC.md` | Detailed design brief for the PNG export. |
| `BRAND.md` | Brand system source-of-truth: voice, palette, typography, status chips, forbidden words, copy templates. |
| `install.sh` | The `curl \| sh` installer. Served as `text/plain` via `_headers`. |
| `_headers` | Cloudflare Pages HTTP header config (cache + security). |

Zero dependencies. Zero build step. Weighs ~22 KB gzipped.

Analytics is **opt-in**: the PostHog loader snippet is commented out
in `index.html`. To enable:

1. Create a PostHog project (cloud or self-hosted).
2. Copy the project API key (starts with `phc_…`).
3. In `index.html`, uncomment the `<script>` block and replace
   `<YOUR_POSTHOG_PROJECT_API_KEY>` with your key.
4. For EU hosting, swap `us.i.posthog.com` → `eu.i.posthog.com`.

Until enabled, the `track()` helper in `app.js` is a no-op and
`data-track="..."` clicks do nothing. Event-name convention is
`<section>:<action>` — see `BRAND.md §8` for the full list.

## Local preview

```sh
npx serve website
# or: python3 -m http.server 8080 --directory website
```

Open http://localhost:3000 (or :8080).

## Deploy to Cloudflare Pages

### First time (via dashboard)

1. https://dash.cloudflare.com → Workers & Pages → Create application → Pages → Connect to Git
2. Pick the `declaragent/declaragent` repo (grant access to the `website/` subfolder if prompted)
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

# declaragent.dev — landing page

Static site. No build step. Deploy as-is to Cloudflare Pages.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Single-page landing. Hero, live validator, install, links. |
| `styles.css` | All styles. Dark-default, monospace accents, CSS variables for theming. |
| `app.js` | SVG round-trip animation + browser-side `fleet.yaml` validator (~15KB port of `@declaragent/cli`'s slice-1 validation). |
| `favicon.svg` | Monochrome `d` glyph on accent background. |
| `_headers` | Cloudflare Pages HTTP header config (cache + security). |

Zero dependencies. No tracking scripts. Weighs ~18KB gzipped.

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

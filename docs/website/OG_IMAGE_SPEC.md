# OG image spec — declaragent.dev social share card

A fallback `og.svg` ships in this folder and is referenced from
`index.html` `og:image` / `twitter:image`. It renders correctly on
GitHub, Discord, and any unfurler that honors SVG. For Twitter,
Slack, and LinkedIn — which rasterize server-side and sometimes
skip SVG — a designer should replace it with a PNG at
`website/og.png` (same path, same dimensions). This doc is the brief.

## Canvas

- **Dimensions:** 1200 × 630 px (Open Graph standard).
- **Safe zone:** keep all critical text inside a 56 px margin on all
  sides. Twitter clips in some layouts.
- **Weight:** ≤ 180 KB PNG (target: < 90 KB with 8-bit palette since
  the design is flat + solid blocks).

## Design thesis — receipts-first

Every competitor in the agent-platform space uses stock AI gradients,
abstract neural-net illustration, or generic terminal screenshots. We
do the opposite:

> **The card is a receipt.** It shows the product's defining move —
> public, honest capability grading — and nothing else.

If Stripe is "payments look simple," Declaragent is "infra looks
honest." The card carries that forward: strong type, monospace chips,
✓ / ◐ status markers, file:line evidence reference.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  [d] declaragent · d9t              [  v0.6.0 · SHIPPED  ]  │
│                                                             │
│                                                             │
│   Stop shipping agent                                       │
│   prototypes.                                               │
│                                                             │
│   The declarative runtime for AI agent fleets.              │
│   One agent.yaml. git log. Production.                      │
│                                                             │
│                                                             │
│  [ ✓ single-machine production ]  [ ◐ enterprise — tracked ]│
│  [ receipts: AGENTS.md · file:line ]                        │
│                                                             │
│  declaragent.dev · npm i -g @declaragent/cli · Apache-2.0   │
└─────────────────────────────────────────────────────────────┘
```

### Brand lockup (top-left, 72px from edges)

- `[d]` mark: 44×44 rounded square (10px radius) in `#5eead4`, glyph
  `d` in `#0b0e14`, JetBrains Mono 700, 28px, centered.
- Wordmark `declaragent`: Inter 700, 22px, `#e6eaf3`, letter-spacing
  `-0.3`.
- Separator: 1px vertical line in `#323a4d`.
- Alias `d9t`: JetBrains Mono 500, 15px, `#6b7486`, letter-spacing
  `0.3`.

### Version pill (top-right, 72px from edges)

- Pill 148×38, 6px radius, fill `#5eead4` @ 10% alpha, 1px stroke
  `#5eead4` @ 30%.
- Text `v0.6.0 · SHIPPED`, JetBrains Mono 600, 14px, `#5eead4`,
  letter-spacing `0.8`. Update the version string on each release.

### Headline (left-aligned, y = 220)

- Two-line Inter 800, 76px, letter-spacing `-2`, line-height 88.
- Line 1: `Stop shipping agent` in `#e6eaf3`.
- Line 2: `prototypes.` with the teal→blue gradient (see below).

**Gradient:** linear, left-to-right, 0% `#5eead4` → 60% `#2dd4bf`
→ 100% `#93c5fd`. This is the site's accent gradient and must match
exactly.

### Subhead (left-aligned, y = 408)

- Inter 500, 26px, `#9aa3b5`, letter-spacing `-0.2`, line-height 36.
- Line 1: `The declarative runtime for AI agent fleets.`
- Line 2: `One agent.yaml. git log. Production.` — render
  `agent.yaml` and `git log` in JetBrains Mono, `#5eead4`.

### Receipt row (left-aligned, y = 510)

Three chips, 40px tall, 6px radius, 16px horizontal padding,
JetBrains Mono 500, 13px:

1. `✓ single-machine production`
   - Fill `#4ade80` @ 10%, stroke `#4ade80` @ 30%, text `#4ade80`.
2. `◐ enterprise — tracked`
   - Fill `#fbbf24` @ 8%, stroke `#fbbf24` @ 28%, text `#fbbf24`.
3. `receipts: AGENTS.md · file:line`
   - Fill `#12161f`, stroke `#242b3a`, text `#9aa3b5`.

### Footer strip (left-aligned, y = 580)

- JetBrains Mono 500, 14px, `#6b7486`, letter-spacing `0.3`.
- Contents: `declaragent.dev · npm i -g @declaragent/cli · Apache-2.0`
- The `·` separators render in `#323a4d` (dimmer).

## Colors (hex + the semantic role)

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#0b0e14` | page background (bottom of gradient) |
| `--bg-elev` | `#12161f` | neutral chip fill |
| `--border` | `#242b3a` | chip outline (neutral) |
| `--border-strong` | `#323a4d` | separators, dim dots |
| `--fg` | `#e6eaf3` | primary text |
| `--fg-muted` | `#9aa3b5` | secondary text |
| `--fg-dim` | `#6b7486` | tertiary text / footer |
| `--accent` | `#5eead4` | teal mark + brand |
| `--accent-strong` | `#2dd4bf` | gradient mid |
| `--accent-light` | `#93c5fd` | gradient end (slate-blue) |
| `--ok` | `#4ade80` | ✓ green |
| `--warn` | `#fbbf24` | ◐ amber |

## Typography

- **Display + body:** Inter (800, 700, 500).
- **Mono + chips + CLI:** JetBrains Mono (700, 500).
- Embed both as SVG fonts or flatten to paths in the PNG export.
  Never fall back to a default system font in the rasterization step
  — the card's rhythm is carried by the typeface choice.

## Decoration

- Subtle grid (48px × 48px, 1px lines at `#5eead4` @ 5%) across the
  full canvas.
- Radial glow at ~50% × 20%, teal @ 14% → transparent.

No illustrations. No 3D. No gradients beyond the accent gradient on
`prototypes.` and the background linear gradient `#0e1320` → `#0b0e14`.
Restraint is the point.

## Export checklist

- [ ] PNG at `website/og.png`, 1200 × 630, sRGB.
- [ ] Also export 600 × 315 (some unfurlers prefer small) as
      `website/og@600.png`.
- [ ] Check preview on:
      - https://cards-dev.twitter.com/validator
      - https://developers.facebook.com/tools/debug/
      - LinkedIn Post Inspector
      - Discord (drag a link into a DM)
      - Slack (paste a link in #marketing-review)
- [ ] Update `<meta property="og:image">` in `index.html` from
      `/og.svg` to `/og.png` when the PNG lands.
- [ ] Keep the SVG in the repo as the editable source-of-truth.

## Variants (optional, later)

- **Release cards** — regenerate per release with the new version in
  the pill and one headline change (e.g., "NATS transport shipped").
  Automate via a script in `scripts/og-gen.ts` that takes a version
  + headline and stamps them into the SVG template.
- **Post cards** — reuse the layout with a blog-specific headline +
  author pill (future, once the docs-site blog is enabled).

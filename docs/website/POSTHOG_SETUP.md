<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of the Declaragent landing page with PostHog analytics.

## What was done

The landing page (`index.html`) already contained a fully-wired PostHog snippet (commented out) and a `track()` helper in `app.js` that routes all `data-track="…"` click attributes through `posthog.capture()`. The integration was completed by:

1. **Activating the PostHog snippet** in `index.html` — removed the HTML comment wrapper, replaced the placeholder token with the real project API key, switched the host to the EU region (`eu.i.posthog.com`), and updated `defaults` to `2026-01-30`.
2. **No changes to `app.js`** were needed — the `track()` stub and the `data-track` click listener were already correct and production-ready.
3. **Environment variables** written to `.env` (`POSTHOG_PUBLIC_KEY`, `POSTHOG_HOST`) for reference.

Because the site is plain static HTML with no build step, the public token is written directly into the script tag (this is expected and safe for client-side PostHog keys).

## Events tracked

All events fire automatically via the existing `data-track` attribute → `track()` → `posthog.capture()` pipeline. No new `posthog.capture()` calls were needed.

| Event name | Description | File |
|---|---|---|
| `hero:copy-install` | User copies the npm install command from the hero section | `index.html` |
| `hero:star` | User clicks the GitHub star button in the hero section | `index.html` |
| `hero:release-notes` | User clicks the release notes link in the hero eyebrow | `index.html` |
| `hero:skip-terminal` | User skips the typing terminal animation | `index.html` |
| `cta:star` | User clicks the GitHub star button in the bottom CTA | `index.html` |
| `cta:discuss` | User clicks GitHub Discussions in the bottom CTA | `index.html` |
| `nav:docs` | User clicks Docs in the top navigation | `index.html` |
| `nav:star` | User clicks the GitHub star pill in the top navigation | `index.html` |
| `nav:capabilities` | User clicks Capabilities in the top navigation | `index.html` |
| `nav:status` | User clicks Status in the top navigation | `index.html` |
| `nav:npm` | User clicks npm in the top navigation | `index.html` |
| `install:tab:npm` | User switches to the npm install method tab | `index.html` |
| `install:tab:brew` | User switches to the Homebrew install method tab | `index.html` |
| `install:tab:curl` | User switches to the curl install method tab | `index.html` |
| `install:tour` | User clicks the interactive tour link from the install section | `index.html` |
| `install:docs` | User clicks the docs link from the install section | `index.html` |
| `install:source` | User clicks the source link from the install section | `index.html` |
| `validator:run` | User clicks the Validate button in the fleet YAML validator | `index.html` |
| `honest:p1`–`honest:p5` | User clicks a pillar in the honest status section | `index.html` |
| `honest:audit` | User clicks the audit link in the honest status section | `index.html` |
| `notyet:plan` | User clicks the enterprise plan link | `index.html` |
| `build:tour`, `build:ref` | User clicks links in the "built with itself" section | `index.html` |
| `footer:github`, `footer:npm`, `footer:docs`, `footer:rss`, `footer:d9t` | Footer link clicks | `index.html` |

## Next steps

We've built a dashboard and five insights to monitor landing page behaviour:

### Dashboard
- **Analytics basics** — https://eu.posthog.com/project/165067/dashboard/639406

### Insights
- **Install intent funnel** — https://eu.posthog.com/project/165067/insights/Xzxe5xlJ
  Conversion: copy install → switch install tab → click GitHub star CTA
- **GitHub star clicks over time** — https://eu.posthog.com/project/165067/insights/zc9h2yq2
  Daily hero + CTA star clicks — proxy for viral/word-of-mouth intent
- **Top CTA and nav clicks** — https://eu.posthog.com/project/165067/insights/oBNFdk6V
  Weekly bar chart of the highest-value CTA and nav events
- **Fleet validator engagement** — https://eu.posthog.com/project/165067/insights/kIVZYdbZ
  Daily validator runs + unique users — indicator of deep developer engagement
- **Install method preference** — https://eu.posthog.com/project/165067/insights/KRYf2gdG
  npm vs Homebrew vs curl tab selection — informs packaging priorities

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-javascript_web/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>

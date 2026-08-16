# pr-review

GitHub `pull_request` webhook → Claude reviews the diff → inline review
comments. Demonstrates plugin-contributed tools via
`@declaragent/plugin-github`.

## What this agent does

Receives GitHub webhooks when a PR is opened or updated, fetches the
unified diff, and posts a single review with inline comments pinned to
specific file + line locations. Never approves — always COMMENT or
REQUEST_CHANGES — so a human still has to merge.

Skipped automatically:

- Draft PRs.
- PRs opened by a bot account (`user.type === "Bot"`).
- Non-`opened`/`synchronize` actions.

## Required secrets

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Claude API key (Sonnet 4.5 recommended for diff
  comprehension).
- `GITHUB_TOKEN` — fine-grained PAT with repo contents `read` + pull
  requests `read & write`. Create at
  <https://github.com/settings/tokens?type=beta>.
- `GITHUB_WEBHOOK_SECRET` — shared HMAC secret. Set the same value in
  the repo's Settings → Webhooks page.

You also need a GitHub App or webhook configured on the target repo.
See the [GitHub webhook setup runbook](../../docs/runbooks/github-webhook-setup.md)
(TODO).

## Run locally

```sh
cp .env.example .env
declaragent up
```

The agent listens on `http://localhost:7777/webhook/github`. For
local testing, tunnel via `ngrok http 7777` and point your GitHub
webhook at the public URL.

## Deploy to Cloud Run

```sh
declaragent deploy gcp-cloud-run
```

The generated `service.yaml` exposes port 8787 for the webhook, while
the webhook source defaults to 7777 — set `port: 8787` in
`event-sources.yaml` for the deployed container so they match. Update
the GitHub webhook's Payload URL to the Cloud Run service URL.

## Estimated cost (lower bound)

- Cloud Run (`cpu=1`, `mem=512Mi`, `minInstances=1`): ~$42/mo
- Claude Sonnet 4.5 tokens at ~20 PRs/day, 8k in / 1.5k out each:
  ~$25/mo

Total lower bound: **~$67/month**. Large monorepos (big diffs, many
PRs/day) push token cost into the $150–$300 band.

## Template deferrals

- `@declaragent/plugin-github` is referenced here but is not yet
  published. Until it ships, `declaragent up` will fail plugin
  load with "unknown plugin id". Track in the Phase 2 ecosystem
  roadmap.

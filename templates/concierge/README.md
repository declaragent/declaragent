# concierge

Minimal Slack bot that answers Q&A about the local repo. One channel,
one skill, no webhook — connects via Slack's Socket Mode so it works
on any laptop behind NAT.

## What this agent does

Listens for `@mention` and direct-message events in Slack, searches the
current working directory with the built-in `Read` / `Glob` / `Grep`
tools, and replies in-thread. No memory across sessions; every question
is answered from the files on disk.

## Required secrets

The following env vars must be set. Copy `.env.example` to `.env` and
fill each one in.

- `ANTHROPIC_API_KEY` — Claude API key. Get one at
  <https://console.anthropic.com/settings/keys>.
- `SLACK_BOT_TOKEN` — Slack bot user OAuth token (`xoxb-...`). Create a
  Slack app at <https://api.slack.com/apps> and install to your workspace.
- `SLACK_APP_TOKEN` — Slack app-level token (`xapp-...`) with the
  `connections:write` scope. Required for Socket Mode.

You will need a real Slack app with Socket Mode enabled and the
`app_mentions:read`, `chat:write`, `im:history`, `im:read`,
`reactions:write` bot scopes. See the
[Slack setup runbook](../../docs/runbooks/slack-setup.md) (TODO) for a
click-through guide.

## Run locally

```sh
cp .env.example .env
# edit .env, then:
declaragent up
```

The agent opens a WebSocket to Slack within 5s. Send `@concierge What
does this repo do?` in any channel the bot is invited to; you should
get a reply in-thread within a few seconds.

## Deploy to Cloud Run

```sh
declaragent deploy gcp-cloud-run
# then follow the printed `gcloud run deploy ...` command.
```

Socket Mode works on Cloud Run but requires `minInstances=1` so the
WebSocket never disconnects. The generated `service.yaml` sets that.

## Estimated cost (lower bound)

- Cloud Run (`cpu=1`, `mem=512Mi`, `minInstances=1`): ~$42/mo
- Claude Sonnet 4.5 tokens at ~50 questions/day, 2k in / 1k out each:
  ~$18/mo

Total lower bound: **~$60/month**. Heavy teams (> 200 questions/day)
push token cost to the $50–$100 band.

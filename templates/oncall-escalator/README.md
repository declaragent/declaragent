# oncall-escalator

Alertmanager webhook → Claude triage → Slack DM to the human on-call.
Demonstrates the webhook source, idempotency via
`X-Alertmanager-Fingerprint`, and outbound `SendMessage` on a channel
that never listens for inbound traffic.

## What this agent does

Accepts Alertmanager v4 JSON webhooks at `/webhook/alertmanager`,
classifies each firing as P1 / P2 / P3, and DMs the on-call's Slack
with a one-paragraph summary. Retries from Alertmanager carrying the
same fingerprint are deduplicated at the ingress, so the pager rings
exactly once per incident.

## Required secrets

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Claude API key.
- `ALERTMANAGER_WEBHOOK_SECRET` — shared HMAC secret. Match the value
  in your `alertmanager.yml` → `receivers[].webhook_configs[].http_config.authorization.credentials`.
- `SLACK_BOT_TOKEN` — `xoxb-...` with `chat:write` + `im:write`.
- `SLACK_APP_TOKEN` — `xapp-...` for Socket Mode.
- `SLACK_ONCALL_USER_ID` — `U01234567` style Slack user id. This is who
  gets paged.

You need a real Slack app with Socket Mode and `im:write`. See the
[Slack setup runbook](../../docs/runbooks/slack-setup.md) (TODO).

## Run locally

```sh
cp .env.example .env
declaragent run
```

The agent listens on `http://localhost:8787/webhook/alertmanager` by
default. To smoke-test with the bundled mock payload:

```sh
SIG=$(printf %s "$(cat mock-alert.json)" | openssl dgst -sha256 -hmac "$ALERTMANAGER_WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://localhost:8787/webhook/alertmanager \
  -H "Content-Type: application/json" \
  -H "X-Alertmanager-Signature: sha256=$SIG" \
  -H "X-Alertmanager-Timestamp: $(date -u +%s)" \
  -H "X-Alertmanager-Fingerprint: d41d8cd98f00b204" \
  --data-binary @mock-alert.json
```

You should see the Slack DM arrive within a few seconds. Repeat the
same `curl` — the second call is idempotency-suppressed and does NOT
re-page.

## Deploy to Cloud Run

```sh
declaragent deploy gcp-cloud-run
```

The generated `service.yaml` exposes port 8787 on Cloud Run. Point
Alertmanager's `webhook_configs[].url` at the resulting URL.

## Estimated cost (lower bound)

- Cloud Run (`cpu=1`, `mem=512Mi`, `minInstances=1`): ~$42/mo
- Claude Haiku 4.5 tokens at ~100 alerts/day, 1.5k in / 200 out each:
  ~$3/mo

Total lower bound: **~$45/month**. Scales nearly linearly with alert
volume; a noisy alertmanager can push this to $80+.

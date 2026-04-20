# Phase 5 Acceptance Demo

This example is the programmatic tier of the Phase-5 acceptance bar from the
spec:

> Bidirectional conversation on each of the four channels with threads,
> reactions, typing indicators, and file upload demonstrated in a single
> demo session.

What you get:

- `agent.yaml` — a minimal `AgentSpec` with a single `concierge` skill.
- `channels.yaml` — one channel per platform (telegram/discord/slack/whatsapp),
  all transport secrets pulled from env vars via `${env:…}` refs.
- `skills/concierge.md` — the concierge skill template.
- `scripted-demo.test.ts` — a programmatic demo that wires four mock channels
  and proves the spec bar without touching the real platforms.

The real-platform demo (against live sandbox workspaces) is the final
checkpoint; it is not run in CI and lives behind the `DECLARAGENT_CHANNEL_IT`
env flag. This example focuses on the CI-runnable bar.

## Run the scripted demo

```bash
# From the repo root:
bun install
bun run demo:phase5
# …or equivalently:
bun test examples/phase5-demo/
```

The test:

1. Boots four `createMockChannelInstance` channels (telegram / discord /
   slack / whatsapp) and registers them in a `ChannelRegistry`.
2. Starts the real `ChannelOutboundBridge` on a private `EventBus`.
3. Publishes one synthetic `chat.message` event per channel.
4. A test echo subscriber stands in for the session/engine loop and emits
   a `channel.send.request` with the inbound content mirrored back.
5. Asserts each mock recorded exactly one outbound `send` with the right
   conversation + text.
6. Exercises `react`, `setTyping`, and `uploadFile` on every mock to cover
   the full spec bar.

## Validate `channels.yaml`

The supplied `channels.yaml` uses `${env:…}` refs for every secret — nothing
in this repo contains a bot token. To validate the file against the installed
adapters:

```bash
# Set placeholder values so the loader's env expansion succeeds.
export DEMO_TELEGRAM_BOT_TOKEN=xxxxx
export DEMO_DISCORD_BOT_TOKEN=xxxxx
export DEMO_DISCORD_APP_ID=xxxxx
export DEMO_SLACK_BOT_TOKEN=xoxb-xxxxx
export DEMO_SLACK_APP_TOKEN=xapp-xxxxx
export DEMO_WHATSAPP_PHONE_NUMBER_ID=xxxxx
export DEMO_WHATSAPP_BUSINESS_ID=xxxxx
export DEMO_WHATSAPP_ACCESS_TOKEN=xxxxx
export DEMO_WHATSAPP_WEBHOOK_VERIFY_TOKEN=xxxxx
export DEMO_WHATSAPP_WEBHOOK_APP_SECRET=xxxxx

# Then:
declaragent channels validate examples/phase5-demo/channels.yaml
```

Real platform credentials go into a local `.env` (never committed); see
`docs/PHASE_5_PLAN.md` §19 for the full platform-by-platform sandbox demo
script.

## Files

| File                    | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `agent.yaml`            | AgentSpec name / model / systemPrompt.                |
| `channels.yaml`         | Four channel entries, one per platform.               |
| `skills/concierge.md`   | Skill frontmatter + narrative body.                   |
| `scripted-demo.test.ts` | Programmatic demo — four-channel round-trip in CI.    |
| `package.json`          | Workspace manifest pulling in `@declaragent/testkit`. |

The real-platform run adds:

- A live bot on every platform (Telegram via `@BotFather`, a Discord test
  guild, a Slack test workspace, a WhatsApp Cloud API sandbox number).
- Manual observation of threads, reactions, typing, and file upload on
  each real client — once per release candidate.

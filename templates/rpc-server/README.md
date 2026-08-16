# rpc-server

Pairs with [`rpc-client`](../rpc-client). Demonstrates the consumer side
of agent-rpc: a PR-reviewer agent that serves the `review-pr` capability
declared in `capabilities.yaml`.

## What this agent does

Subscribes to `agents.pr-reviewer.requests` via the `agent-inbox` source
adapter. Every inbound envelope with `kind: "request"` is dispatched to
the `review-pr` skill. The skill calls `ctx.respond({ ok: true, data:
<findings> })` to reply; the respond hook publishes a `response`
envelope back to the requestor's `replyTo` topic.

## Transport

Default: the in-memory transport, so `rpc-client` + `rpc-server` can
run in a single process for dev / CI. Production deployments swap the
`kind: memory` blocks in `event-sources.yaml` + `capabilities.yaml` for
`kind: kafka` (or nats / sqs / amqp / mqtt) — the envelope and the
`agent-inbox` source stay byte-identical.

## Required secrets

Copy `.env.example` → `.env` and fill in:

- `ANTHROPIC_API_KEY` — Claude API key (Sonnet 4.6 recommended).
- `KAFKA_BROKERS` — optional; required only when running across
  processes over Kafka.

## Run locally

Single process, paired with `rpc-client` — see the fleet.yaml snippet in
`../rpc-client/README.md`, then:

```sh
cd .. && declaragent fleet run
```

Standalone (Kafka):

```sh
declaragent up
```

and in another terminal, start `rpc-client` with `KAFKA_BROKERS` set.

## Verify capabilities

```sh
declaragent fleet capabilities      # aggregate the fleet's capabilities.yaml files
```

## Cost estimate (lower bound)

- Sonnet 4.6, 8k in / 1.5k out per review: ~$0.04/review.
- 20 reviews/day: ~$24/month on Claude tokens.
- Cloud Run (`cpu=1`, `mem=512Mi`, `minInstances=1`): ~$42/mo.

Total lower bound: **~$66/month**. Large monorepos (big diffs, many
PRs/day) push the token cost into the $100–$200 band.

# rpc-client

Pairs with [`rpc-server`](../rpc-server). Demonstrates the producer side
of agent-rpc: a concierge agent that delegates PR-review requests to
`agent://pr-reviewer` using the `RequestAgent` tool.

## What this agent does

Accepts a PR URL from the user, calls `RequestAgent({ to: agent://pr-reviewer,
capability: "review-pr", payload: { prUrl } })` synchronously, and
summarizes the response.

## Flow

```
User → concierge ──(RequestAgent)──► broker ──(request)──► pr-reviewer
                                                             │
                                                             ▼
                                                    review-pr skill
                                                             │
                                                             ▼
User ◄── concierge ◄──(response)── broker ◄──(ctx.respond)───┘
```

Every hop carries the same `correlationId` — `declaragent events list
--correlation <id>` surfaces the whole chain.

## Required secrets

Copy `.env.example` → `.env` and fill in:

- `ANTHROPIC_API_KEY` — Claude API key.
- `KAFKA_BROKERS` — optional; omit to run both client + server in one
  process over the in-memory transport.

## Run locally (single process)

Leave `KAFKA_BROKERS` unset. `fleet run` boots both agents in one daemon
from a `fleet.yaml` — create a minimal one in the parent directory:

```yaml
# ../fleet.yaml
version: 1
name: rpc-demo
agents:
  - { id: rpc-client, path: ./rpc-client }
  - { id: rpc-server, path: ./rpc-server }
```

```sh
cd .. && declaragent fleet run
```

Both share an in-memory broker. Useful for local dev and CI.

## Run across two processes (Kafka)

Set `KAFKA_BROKERS` and swap the `kind: memory` block in `rpc-peers.yaml`
for the commented-out `kind: kafka` block. Start the server daemon first:

```sh
cd ../rpc-server && declaragent up
```

Then in another terminal:

```sh
declaragent up
```

## Verify the peer table

```sh
declaragent fleet peers              # print the effective peer table
declaragent fleet peers --verify     # live-ping every peer's inbox
```

## Cost estimate (lower bound)

- Concierge on Haiku 4.5, 1k in / 400 out per request: ~$0.002/request.
- Add `rpc-server`'s cost for the actual review (Sonnet pricing).

# fleet-starter

Two-agent fleet template. Pre-installs a **concierge** (RPC producer,
Haiku 4.5) and a **pr-reviewer** (RPC consumer, Sonnet 4.6) as workspace
members under `agents/*`. Designed as the first concrete example of the
`declaragent fleet` workflow:

```
# whole-fleet template — copy it from the repo (init --template handles
# single-agent templates only):
npx degit declaragent/declaragent/templates/fleet-starter my-fleet
cd my-fleet
bun install
declaragent fleet validate    # ✓ fleet validates clean
declaragent fleet run         # boot both agents in one process
```

## Layout

```
my-fleet/
├── fleet.yaml            # manifest: agents + environments + deploy targets
├── package.json          # Bun workspaces pin
├── rpc-peers.yaml        # fleet-level peer table
├── .env.example          # shared env for every agent
└── agents/
    ├── concierge/        # RPC producer — uses `RequestAgent`
    │   ├── agent.yaml
    │   ├── event-sources.yaml
    │   └── skills/delegate.md
    └── pr-reviewer/      # RPC consumer — serves `review-pr`
        ├── agent.yaml
        ├── capabilities.yaml
        ├── event-sources.yaml
        └── skills/review-pr.md
```

## Dev loop

One process over the shared in-memory bus (zero broker setup):

```sh
declaragent fleet run
```

A round-trip concierge → pr-reviewer request completes in-process in
under 200ms on a warm cache.

## Cross-process (Kafka)

Swap the `kind: memory` blocks in `rpc-peers.yaml` +
`agents/pr-reviewer/capabilities.yaml` for the commented-out
`kind: kafka` blocks. Set `KAFKA_BROKERS` in `.env`.

```sh
declaragent fleet run --agent pr-reviewer     # terminal 1
declaragent fleet run --agent concierge       # terminal 2
```

## Inspect the fleet

```sh
declaragent fleet list             # agents + capability counts
declaragent fleet capabilities     # aggregated capability table
declaragent fleet graph            # mermaid of RPC edges
declaragent fleet peers --verify   # peer-reachability probe
declaragent fleet status           # health + last deploys
```

## Deploy

```sh
declaragent fleet deploy --target cloud-run-reviewer --dry-run   # prints the plan
```

Today `fleet deploy` executes only against in-memory/test adapters — the
`gcp-cloud-run` target adapter hasn't shipped, so a non-dry-run deploy
exits with `no adapter registered for target`. Use the per-agent path
(`declaragent deploy gcp-cloud-run` inside each agent dir + the printed
`gcloud` commands) to actually ship; `--dry-run` remains useful for
reviewing the rolling plan (each agent gated on a health probe, failures
rolled back in reverse order).

## Required secrets

Copy `.env.example` → `.env` and fill in:

- `ANTHROPIC_API_KEY` — Claude API key (Sonnet 4.6 for the reviewer,
  Haiku 4.5 for the concierge).
- `KAFKA_BROKERS` — optional; set only when running across processes.

## Cost estimate

| component | model | cost/request |
| --- | --- | --- |
| concierge | Haiku 4.5 (1k in / 400 out) | ~$0.002 |
| pr-reviewer | Sonnet 4.6 (8k in / 1.5k out) | ~$0.04 |
| **per review** | | **~$0.042** |

20 reviews/day on Cloud Run (`minInstances=1`): **~$66/month**.

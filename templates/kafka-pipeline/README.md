# kafka-pipeline

Kafka source → Claude enriches each record. Demonstrates the Kafka
adapter (JSON-path routing + DLQ) and daily token budget enforcement.

## What this agent does

Consumes `orders.created` (expected JSON) and runs the enrichment skill
on each record. **The enriched result is logged (visible via
`declaragent logs` / `events list`) — there is no Kafka outbound path
yet**, so nothing is re-published to `orders.enriched` today; producing
the enriched record back to a topic is on the roadmap (the Kafka
producer is currently used for DLQ routing only). Malformed or
repeatedly-failing records land in `orders.dlq` so ops can inspect them
without blocking the pipeline.

Cost enforcement: the agent declares `dailyTokenUSD: 5` in its quota
block, so a runaway enrichment loop is cut off before it burns the
weekend's budget.

## Required secrets

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Claude API key (Haiku 4.5).
- `KAFKA_BROKER_URL` — broker host:port. `localhost:19092` for the
  bundled Redpanda; your cloud vendor's URL in prod.
- `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` — SASL/SCRAM creds. Leave
  blank for local Redpanda (and drop the `security.sasl` block from
  `event-sources.yaml`).

## Run locally

Bring up Redpanda + a console via the bundled compose file:

```sh
docker compose up -d
docker compose exec redpanda rpk topic create orders.created
docker compose exec redpanda rpk topic create orders.enriched
docker compose exec redpanda rpk topic create orders.dlq

cp .env.example .env
# For local dev, also remove the `security.sasl` block from
# event-sources.yaml — Redpanda's default compose config runs
# unauthenticated.
declaragent up
```

Publish a test record:

```sh
echo '{"id":"ord_1","total":75,"items":[{"sku":"BW","name":"Blue Widget","quantity":3}],"shipTo":{"country":"US","city":"Austin","region":"TX"}}' \
  | docker compose exec -T redpanda rpk topic produce orders.created
```

Open the Redpanda console at <http://localhost:8080> to watch
`orders.created` consumption (and `orders.dlq` for failures), and
`declaragent logs -f` to see the enrichment output.

## Deploy to Cloud Run

```sh
declaragent deploy gcp-cloud-run
```

Cloud Run keeps the consumer group alive as long as `minInstances=1`.
For high-throughput pipelines, bump memory to 1Gi + concurrency in
`service.yaml`.

## Estimated cost (lower bound)

- Cloud Run (`cpu=1`, `mem=512Mi`, `minInstances=1`): ~$42/mo
- Claude Haiku 4.5 tokens at 10k messages/day, 400 in / 200 out each:
  ~$18/mo
- Kafka (Confluent Cloud basic / Redpanda Cloud developer):
  ~$0–$50/mo depending on vendor.

Total lower bound: **~$60–$110/month**. A 100k msg/day pipeline
crosses $200 easily; adjust the `dailyTokenUSD` quota accordingly.

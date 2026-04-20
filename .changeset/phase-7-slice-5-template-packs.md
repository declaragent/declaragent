---
'@declaragent/core': patch
---

Phase 7 slice 5: five template packs under `templates/`.

`declaragent init` (slice 4) will unpack one of these directories into
the user's project root. Each template is a fully-specified starter
that a new user can `declaragent run` in under 5 minutes.

- **`concierge`** — minimal Slack Q&A bot via Socket Mode. One skill
  (`concierge.md`) uses the provider-default `Read` / `Glob` / `Grep`
  tools to answer questions about the local repo. No webhook — works
  on any laptop behind NAT.
- **`oncall-escalator`** — Alertmanager webhook → Claude triage →
  Slack DM. Demonstrates the `webhook` source with HMAC verification,
  `X-Alertmanager-Fingerprint` as an idempotency key, and the
  `SendMessage` tool on an outbound-only channel. Ships with a
  `mock-alert.json` payload and the matching `curl` command in the
  README.
- **`pr-review`** — GitHub `pull_request` webhook → Claude reviews the
  diff → inline review comments. References
  `@declaragent/plugin-github` via a `plugin-manifest.json`.
- **`kafka-pipeline`** — Kafka source consuming `orders.created`,
  enrichment via Haiku, re-emit to `orders.enriched`, DLQ on
  `orders.dlq`. Declares `dailyTokenUSD: 5` to exercise Phase-6 cost
  enforcement. Bundles a Redpanda `docker-compose.yaml` for the local
  dev loop.
- **`multi-tenant-starter`** — `tenants.yaml` with `acme-prod` (US
  residency, enterprise quotas) + `beta-tenant` (EU residency, trial
  quotas). Demonstrates `per-tenant` bus strategy, per-tenant
  `extensions.allow`/`deny`, scoped Vault secrets, and a smoke-test
  block in the README that walks the user through
  `declaragent tenants list / show` + `declaragent audit verify`.

**Verifier.** `scripts/verify-templates.ts` walks every template and
asserts that every YAML / JSON file parses, every declared skill file
exists, and `.env.example` covers every `${env:FOO}` ref in the YAML.
A matching CI job (`.github/workflows/templates-verify.yml`) runs the
same script on `push` / `pull_request` / `workflow_dispatch` scoped to
`templates/**`. The verifier doubles as a local check: `bun run
scripts/verify-templates.ts` is green in a clean checkout.

**Top-level index.** `templates/README.md` catalogues the five
templates + their demonstrated features, and links out to the parallel
`declaragent init` unpacker in slice 4.

**Locally validated.**
- `bun run scripts/verify-templates.ts` — green on all five templates.
- `bun run typecheck` — unchanged baseline.
- `bun test` — unchanged baseline (templates aren't exercised in the
  test suite).
- `bun run lint` — unchanged baseline; template markdown + YAML are
  already excluded via the root `biome.json` `files.ignore` block.

**Template deferrals.**
- `@declaragent/plugin-github` is referenced in `pr-review` but is not
  yet published. `declaragent run` on that template will fail plugin
  load until the Phase 2 ecosystem publishes the package. Called out
  in that template's README.
- Slack / GitHub setup runbooks are linked as TODO-anchored paths
  under `docs/runbooks/`. The real pages land alongside slice 7 (docs
  site).
- The `quotas` block on `kafka-pipeline/agent.yaml` and the `tenants`
  / `plugins` / `event-sources` references elsewhere use
  forward-compatible field names that `AgentSpec` in
  `packages/core/src/types/session.ts` will need to honor when the
  full `agent.yaml` schema is frozen in slice 8.

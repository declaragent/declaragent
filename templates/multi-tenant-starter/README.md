# multi-tenant-starter

Two tenants (`acme-prod` + `beta-tenant`) running on a single daemon,
with per-tenant quotas, scoped secrets, and isolated audit retention.
Demonstrates the Phase-6 multi-tenant primitives end-to-end.

## What this agent does

One daemon, two tenants. Each tenant has its own Slack workspace,
its own quotas, its own residency zone, its own extension allowlist,
and its own audit retention window. Events are bucketed by
`meta.tenantId` at ingress and never cross tenant boundaries in the
engine.

Default bus strategy is `per-tenant` — a separate bus per tenant so
the two tenants' events never share an in-flight queue. Switch to
`shared-with-filter` in `tenants.yaml` if event volume is low.

## Required secrets

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — shared across both tenants; usage is accounted
  per-tenant against the `dailyTokenUSD` quota in `tenants.yaml`.
- `VAULT_ADDRESS`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID` — Vault AppRole
  creds. See `secrets.yaml` for the provider wiring.
- `ACME_SLACK_BOT_TOKEN` / `ACME_SLACK_APP_TOKEN` — per-tenant Slack
  tokens. In prod these live in Vault; the env fallback is for local dev.
- `BETA_SLACK_BOT_TOKEN` / `BETA_SLACK_APP_TOKEN` — same, for the beta
  tenant.

## Run locally

```sh
cp .env.example .env
declaragent run
```

The daemon loads `tenants.yaml`, builds one `TenantRuntime` per tenant,
wires each tenant to its matching Slack channel, and starts listening.

## Smoke test

After `declaragent run`, from another terminal:

```sh
# 1. Confirm both tenants loaded.
declaragent tenants list
# expected output: two rows — acme-prod (us, enterprise) + beta-tenant
# (eu, trial). Quotas displayed inline.

# 2. Inspect a tenant's full config.
declaragent tenants show acme-prod

# 3. Verify the audit chain is intact.
declaragent audit verify --tenant acme-prod
declaragent audit verify --tenant beta-tenant
# both should exit 0 with `ok: true`.

# 4. Query the last 10 audit records for the beta tenant.
declaragent audit query --tenant beta-tenant --limit 10
```

## Deploy to Cloud Run

```sh
declaragent deploy gcp-cloud-run
```

The generated `service.yaml` mounts one volume per tenant's data dir
and stamps `tenant_id` as a Prometheus metric label via
`createPrometheusRegistry`'s `constLabels` wiring.

## Estimated cost (lower bound)

- Cloud Run (`cpu=1`, `mem=1Gi`, `minInstances=1`): ~$55/mo
- Vault (HashiCorp Cloud Platform dev tier): ~$18/mo
- Claude Sonnet 4.5 tokens across both tenants at ~100 events/day
  each, 2k in / 500 out: ~$32/mo

Total lower bound: **~$105/month** for two tenants on a single
daemon. Adding a tenant costs only the marginal token spend plus a
tiny bus overhead; per-tenant Cloud Run deploys would cost 2× base.

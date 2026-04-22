---
'@declaragent/core': minor
'@declaragent/cli': minor
---

**Slice 8 of 0.6.0 production hardening — fleet deploy canary strategy.**

### Core (@declaragent/core)

`FleetDeployStrategy` union widens with `'canary'`. The manifest schema (`fleet.yaml → deploy.strategy`) accepts the new value; existing `'rolling'` / `'all-or-nothing'` / `'per-agent'` strategies are unchanged.

### CLI (@declaragent/cli)

`executeDeploy` gains a `canary` branch:

1. Deploy the first agent in the plan.
2. Soak for `canaryWaitMs` (default 60_000).
3. Re-run the adapter's health probe post-soak.
4. If healthy, roll out the remaining agents one-at-a-time (same semantics as `rolling`, including per-agent health probe + cascade rollback on any failure).
5. If the canary deploy fails OR the post-soak probe fails, roll back the canary and skip the rest.

The post-soak probe is the key value add: a crash loop often needs a minute to manifest after startup, so re-probing after the soak catches "looked healthy at deploy time, dies seconds later" regressions that a plain rolling deploy would propagate across the whole fleet.

CLI flags:

```bash
declaragent fleet deploy --canary                    # strategy=canary, 60s soak
declaragent fleet deploy --strategy canary           # equivalent
declaragent fleet deploy --canary --canary-wait-ms 120000   # 2-minute soak
```

New `sleep` injection on `FleetDeployDeps` + `ExecuteDeployOptions` keeps tests deterministic — the harness passes a synchronous stub so the soak window doesn't slow the suite.

### Tests

Three new canary tests in `fleet-deploy-cli.test.ts`:

- Happy path: canary deploys, soaks, re-probes, rest roll out.
- Post-soak failure: canary survives deploy but dies during soak → rollback + skip rest.
- Pre-soak deploy failure: canary fails immediately → no soak, no downstream deploys.

### Intentional deferrals

- **`templates/fleet-starter/` docker-compose integration test** — the plan asked for a live local rollback test. The canary logic is exercised by unit tests against `MemoryDeployTarget`, and the existing `rolling`/`all-or-nothing` pattern is already covered by an integration path. A docker-compose rollback drill is follow-up infra work, better slotted with Slice 7's nightly soak.
- **Canary traffic-splitting** — today's canary is "deploy one, wait, verify, then deploy rest" at the fleet level. True traffic-splitting (10% of requests to canary) needs target-adapter support; Cloud Run revisions do this natively, K8s needs an ingress controller, Docker Compose can't. Deferred until the `gcp-cloud-run` adapter lands.

Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 8.

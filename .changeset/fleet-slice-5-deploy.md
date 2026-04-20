---
'@declaragent/cli': minor
---

Fleet slice 5 — `declaragent fleet deploy` (rolling + per-agent,
with rollback history).

Coordinated multi-agent deploys driven by the manifest's
`deploy.strategy`. Rolling (default) walks agents sequentially and
rolls back every agent deployed so far on failure; all-or-nothing
deploys in parallel and rolls back all on any failure; per-agent
fires without coordination. Every deploy stamps a fleet version
(`v${pkg.version}-${gitSha.slice(0,7)}`, or `v0.0.0-nosha` fallback)
and appends a record to `<root>/.declaragent/fleet-deploys.jsonl`.
`--rollback` reads the history and re-invokes the previous
successful deploy's target set.

```bash
declaragent fleet deploy                       # rolling, every agent
declaragent fleet deploy --target cloud-run    # override per-agent target
declaragent fleet deploy --agent concierge     # subset
declaragent fleet deploy --dry-run             # print plan, write nothing
declaragent fleet deploy --rollback            # re-run previous version
declaragent fleet deploy --json                # machine-readable output
```

**`packages/cli/src/fleet-deploy-cli.ts`** — pure helpers + CLI wrapper:

- `FleetDeployTarget` — adapter interface: `kind`, `deploy`, optional
  `healthCheck`, optional `rollback`. `DeployContext` carries the
  loaded fleet, fleet version, resolved target config, and an IO
  logger. `DeployOutcome` is a tagged `{ok: true, artifact} | {ok:
  false, error}`.
- `createMemoryDeployTarget({failFor?})` — hermetic in-memory target
  used by every test. Records deploy + rollback order, exposes a
  per-agent health flag tests can flip to simulate probe failure.
- `planDeploy(fleet, opts)` — pure ordering pass. Walks manifest
  agents in order, applies `agents` subset + `targetOverride` +
  `extraTargets`, validates target keys resolve.
- `executeDeploy(plan, targets, opts)` — runs the plan per strategy
  and returns `{ok, deployed, failed?, rolledBack, outcomes}`.
- `readDeployHistory` / `appendDeployRecord` — newline-delimited
  JSON at `.declaragent/fleet-deploys.jsonl`.
- `computeFleetVersion(root, fs)` — derives the version from
  `package.json` + `.git/HEAD` (follows `ref:`), with `v0.0.0-nosha`
  fallback.
- `fleetDeploy(args, deps)` — top-level CLI verb. Loads fleet,
  builds plan, executes (unless `--dry-run`), appends history.
  `--rollback` reverses the most recent `deployed` record.

**Scope cut.** A real `createGcpCloudRunTarget()` adapter (Docker
build + `gcloud run deploy` shell-outs) lands in a follow-up PR once
that surface solidifies. Slice 5 ships the `memory` adapter only;
production deploys wire their own adapters via
`FleetDeployDeps.targets` / `targetFactory`.

**Tests.** 20+ new tests in `fleet-deploy-cli.test.ts`: plan
ordering + subset filter, rolling rollback, all-or-nothing rollback,
per-agent no-coordination, history jsonl round-trip,
`computeFleetVersion` resolution paths, CLI verb error + `--dry-run`
+ `--target` override + `--json` + `--rollback`.

**Next.** Slice 6 — `fleet graph` + `fleet peers [--verify]`.

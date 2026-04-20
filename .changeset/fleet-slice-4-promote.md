---
'@declaragent/cli': minor
---

Fleet slice 4 — `declaragent fleet promote` + `declaragent fleet demote`.

Turns an existing single-agent directory into a fleet-of-one (and
back). Dry-run is the default; `--apply` mutates. Demote is strictly
the inverse and refuses for fleets with N > 1 agent (per FLEET_PLAN.md
§14.10).

```bash
declaragent fleet promote ./my-agent              # preview the plan
declaragent fleet promote ./my-agent --apply      # mutate
declaragent fleet promote ./my-agent --apply --id reviewer
declaragent fleet demote                          # fleet-of-one → single agent
```

**`packages/cli/src/fleet-promote-cli.ts`** — new verb helpers:

- `fleetPromote({path, dryRun, apply, force, id?}, deps)` — detects the
  target (refuses when `<path>` already has `fleet.yaml` or is missing
  `agent.yaml`), builds a step-by-step mv/rewrite plan, and either
  prints it (`dryRun`, default) or executes it (`apply`). Apply moves
  per-agent files under `agents/<id>/`, rewrites the moved
  `agent.yaml` + `capabilities.yaml` to reflect the id, writes a
  fleet-of-one `fleet.yaml`, updates root `package.json` to add
  `"workspaces": ["agents/*"]` (preserves `name`, `dependencies`,
  `scripts`), and drops a `PROMOTED.md` note at the fleet root.
- `fleetDemote({id, force}, deps)` — inverse of promote. Walks up from
  `cwd` via `findFleetRoot` (or accepts an explicit `fleetRoot`), moves
  every child of `agents/<id>/` back to the fleet root, deletes
  `fleet.yaml` + `PROMOTED.md`, strips the `workspaces` field from the
  root `package.json`. Refuses when the fleet has more than one agent.
- Re-exports `FleetPromoteIO`, `FleetPromoteArgs`, `FleetPromoteDeps`,
  `FleetDemoteArgs`, `FleetDemoteDeps` for the CLI router + tests.

**Moved into `agents/<id>/`:** `agent.yaml`, `capabilities.yaml`,
`event-sources.yaml`, `rpc-peers.yaml`, `channels.yaml`, `tenants.yaml`,
`secrets.yaml`, `skills/`, every root-level `*.md` (except
`PROMOTED.md` itself).

**Stay at the fleet root:** `.env`, `.env.example`, `.gitignore`,
`bun.lock`, `package.json` (rewritten).

**Warned about but never rewritten:** `Dockerfile`, `deploy*.yaml`,
`cloud-run*.yaml`, and every `.github/workflows/*.yml` file — per
FLEET_PLAN.md §7.1 these often reference paths we're moving and the
user has to decide whether to rewrite them.

**Tests.** 18 new tests in `fleet-promote-cli.test.ts`, all against
tmpdir fixtures, covering:

- dry-run prints a plan without touching disk (+ mentions per-agent
  files + shared-root exceptions).
- `--dry-run` + `--apply` together errors.
- apply produces the expected tree (agents/<id>/ + fleet.yaml +
  PROMOTED.md + package.json workspaces).
- apply prints a success banner with `fleet validate` + `fleet run`
  hints.
- refuses when source already has `fleet.yaml`.
- refuses when source has no `agent.yaml`.
- refuses when source path does not exist.
- refuses a malformed agent id.
- custom `--id` rewrites `agent.yaml → name` and (when present)
  `capabilities.yaml → agent: agent://<id>`.
- existing `package.json` is rewritten (adds workspaces, preserves
  name + deps + scripts).
- creates a minimal `package.json` when none exists.
- warns on Dockerfile + deploy YAML + `.github/workflows/*.yml`
  without rewriting them.
- demote reverses promote cleanly — post-demote tree is equivalent to
  pre-promote (byte-for-byte agent-file contents, minus PROMOTED.md).
- demote refuses when fleet has >1 agent.
- demote refuses when `--id` does not match the sole fleet member.
- demote errors when no `fleet.yaml` is found.

**Not in scope for slice 4 (tracked for a follow-up):**

- Git-dirty refusal + `--force` wiring. `force` is accepted on the
  args shape so the CLI router can pass it through, but slice 4 leans
  on the dry-run-first flow as the primary safety net.
- Cross-repo promote (moving an external dir in + promoting in one
  step). Users do this today via `fleet add --path` then `fleet promote`
  on the resulting layout if needed.
- Revert-on-validation-failure (§7 step 5). Today's apply is
  straight-line; users run `fleet validate` explicitly post-promote.

**Next.** Slices 5 + 6 parallelize — `fleet deploy` + `fleet graph` /
`fleet peers`.

---
'@declaragent/core': minor
---

Fleet slice 0 — `fleet.yaml` v1 manifest schema + loader.

First concrete PR from `docs/FLEET_PLAN.md`. Adds the v1.2 multi-agent
monorepo primitive: one git-versioned manifest declaring N agents, their
environments, shared config references (tenants / peers / secrets /
channels), and deploy targets.

**New under `packages/core/src/fleet/`**

- `manifest-schema.ts` — Zod schema frozen at v1.2, `@since 1.2.0`.
  Strict-mode on every object; unknown keys fail load. Deploy target
  configs are `passthrough` so per-target adapters (slice 5) can validate
  their own fields without modifying this schema.
- `manifest-loader.ts` — `loadFleet({root})` + `findFleetRoot(cwd)`.
  Flattens `environments[].inherit:` chains (cycles rejected), resolves
  every agent path to absolute, and enforces the §14.4 invariant
  (`fleet.yaml → agents[].id == agents/<id>/agent.yaml.name`). Loads
  per-agent `capabilities.yaml` plus the first env's `peersRef`; tenants /
  secrets / channels land in later slices when consumers need them.
- `aggregator.ts` — `aggregateCapabilities(fleet)` builds the fleet-wide
  capability table that drives `fleet capabilities` + `fleet graph`.
  `aggregatePeers(fleet)` classifies every `rpc-peers.yaml` entry as
  in-fleet, dangling, or external — the slice-1 `fleet validate` verb
  promotes danglings to errors.
- `types.ts` + `index.ts` — `LoadedFleet`, `LoadedAgentEntry`,
  `LoadedEnvironment`, `FleetConfigError`.

**Back-compat.** Single-agent layouts are untouched. `findFleetRoot`
returns `undefined` when no `fleet.yaml` is found walking up — callers
fall back to today's single-agent mode.

**Tests.** 33 new tests across schema, loader, and aggregator. Fixture
fleets live in per-test temp directories.

**Next.** Slice 1 — read-only CLI verbs (`fleet list`, `fleet validate`,
`fleet capabilities`).

---
'@declaragent/cli': patch
---

feat(rpc): fleet-side per-agent auth registry (#18)

`declaragent fleet run` now threads a distinct `AuthVerifyRegistry` per
agent when an agent directory contains its own `rpc-peers.yaml`,
replacing the single fleet-wide registry that collapsed when two agents
needed to trust disjoint peer sets.

- `StartFleetDaemonOptions.authRegistryByAgent?: ReadonlyMap<string, AuthVerifyRegistry>` —
  per-agent override map keyed by `agent.id`; agents without an entry
  fall back to the existing `authRegistry` (fleet-root), which in turn
  falls back to the legacy `internal`/`hmac` pass-through.
- `FleetDaemon.authRegistryFor(agentId)` accessor — returns the
  effective registry the worker bound to, exposed for control-plane
  Slice 3 cross-host fan-out consumers.
- `FleetAgentRpcContext.authRegistry` — the effective registry is also
  threaded into the handler factory so handlers (and future RPC tools)
  can evaluate auth with the same verifier the worker does.
- CLI behaviour: `fleetRun` walks every agent at boot and loads
  `<agentPath>/rpc-peers.yaml` when present. Failures on one agent
  never poison the others — that agent falls back to the fleet-root
  registry with a warning.

Back-compat: fleets with only a fleet-root `rpc-peers.yaml` continue
to work unchanged.

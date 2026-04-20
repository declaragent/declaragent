---
'@declaragent/cli': minor
---

Fleet slice 1 — `declaragent fleet list / validate / capabilities`.

First set of fleet-aware CLI verbs. Every verb is read-only; mutations
(`init --fleet`, `add`, `promote`, `run`, `deploy`) land in later slices.

- **`fleet list [--json]`** — prints the fleet name, root, and one line
  per agent (id, env, capability count or "client-only"). `--json` emits
  a structured shape suitable for scripted workflows.
- **`fleet capabilities [--json]`** — aggregated capability table
  grouped by agent. The JSON form is keyed on `agent://<id>` and
  includes `clientOnly` so downstream tooling can differentiate agents
  that offer RPC from pure consumers.
- **`fleet validate [--json]`** — schema + peer-graph dry-run. Surfaces:
  - `peer.dangling` (error) — a `rpc-peers.yaml` entry points at an
    agent id the fleet doesn't declare.
  - `peer.client-only` (warning) — an in-fleet peer has no
    `capabilities.yaml`; callers will fault at request time.
  - `capability.duplicate` (warning) — the same capability name is
    declared by >1 agent.
  - `deploy.target.missing` (error) — an agent deploys to a target
    that isn't in `deploy.targets{}`.
  Non-zero exit on any `error` severity finding.

Each verb walks up from cwd via `findFleetRoot`, so it works from
anywhere inside a fleet tree. Outside a fleet it errors with a hint at
`declaragent init --fleet <name>`.

**Tests.** 13 new tests in `packages/cli/src/fleet-cli.test.ts`, each
driven off a real tmpdir-backed fixture fleet.

**Next.** Slice 2 — `init --fleet` scaffolder + `fleet add --template`.

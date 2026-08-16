# Fleet — Multi-Agent Monorepo Plan

> ⚠️ **Historical design doc — not maintained.** This document predates the shipped
> implementation and is kept for design context only; command names, config shapes,
> versions, and file paths in it may no longer match the code. `docs/SPEC_AND_PLAN.md`
> supersedes it for requirements; for live capability status see `AGENTS.md`, and for
> user-facing behavior see the docs site (`docs-site/`).


**Status:** Design-frozen for v1.2. §14 decisions are binding for the v1.2 freeze; revisit only via changeset. Positioned to land after the v1.1 Agent RPC work and before any centralized registry / cross-tenant federation story.
**Last updated:** 2026-04-19.

The current runtime ships a single agent per directory. The v1.1 `rpc-client` + `rpc-server` template pair is the first shape where users want to manage two agents together: shared peer table, aligned deploys, one dev loop. Today that's manual — two separate `bun install`s, two separate `agent.yaml`s, two separate deploy pipelines, and an `rpc-peers.yaml` the user has to keep in sync by hand.

This plan specifies **fleets**: a monorepo shape where one manifest declares N agents, root-level dependency management via Bun workspaces, shared tenant / peer / secret / channel config, and a coordinated deploy + dev loop. Single-agent workflows stay untouched — fleets are opt-in.

The forcing function is the scenario from `docs/AGENT_RPC_PLAN.md` §13 — a concierge calling a pr-reviewer over Kafka — plus the real-world case where a team runs 3-10 specialist agents that share Slack channel IDs, tenant configs, and a single deploy pipeline.

---

## 1. Goals and non-goals

**Goals.**
- **Fleet manifest.** `fleet.yaml` v1 Zod schema frozen at v1.2. Declares the agents in the fleet, their environments, and deploy targets. Every fleet-aware CLI verb reads this.
- **Root-level dependency management.** One `package.json`, one lockfile, one `node_modules` at the fleet root. Bun workspaces (`"workspaces": ["agents/*"]`) do the heavy lifting — this plan just formalizes the convention.
- **Shared config artifacts.** `tenants.yaml`, `rpc-peers.yaml`, `secrets.yaml`, `channels.yaml` live at fleet root and are inherited by every agent. Per-agent override via `fleet.yaml` stanzas.
- **Fleet-aware CLI.** A `declaragent fleet <verb>` family covering `new`, `add`, `promote`, `list`, `run`, `deploy`, `status`, `validate`, `graph`.
- **Single-process dev loop.** `declaragent fleet run` starts every agent (or a `--agent` subset) in one daemon over the in-memory RPC transport. Hot-reload per agent; shared channels bound once.
- **Coordinated deploy.** `declaragent fleet deploy` rolls every agent atomically or as a rolling update, with per-agent health gates and fleet-level rollback.
- **Promote single → fleet.** `declaragent fleet promote ./my-agent` converts an existing single-agent directory into a fleet member (move files, write manifest, update paths). `--dry-run` previews.
- **Aggregated validation.** `declaragent fleet validate` checks every agent's schemas + the cross-agent RPC graph (no dangling `rpc-peers.yaml` entries, no circular loops, no duplicate capability names across peers).
- **Back-compat.** Single-agent layouts in `templates/` keep working unchanged. A fleet is detected by a `fleet.yaml` at pwd or any ancestor; absent → single-agent mode.

**Non-goals.**
- **No cross-agent code gen.** `capabilities.yaml` is the contract; TypeScript client generation from capability schemas is v1.3.
- **No service mesh.** Inter-agent auth + routing is the RPC layer's problem. Fleet just aggregates peer tables.
- **No replacement for changesets.** The existing `.changeset/` flow is unchanged; agents version alongside `@declaragent/core` at the root.
- **No centralized registry.** `rpc-peers.yaml` + `capabilities/` aggregation are git-tracked. A v1.3 `declaragent registry` verb can layer on top.
- **No Windows-specific pathways.** Same constraint as Phase 7.
- **No auto-discovery.** `fleet.yaml` explicitly lists every agent path. A directory-scan "discover everything under agents/" mode is an open question (§14 Q1), not in v1.2.
- **No per-agent Node/Bun version pinning.** One runtime per fleet.
- **No replacement for `tenants.yaml`.** That file keeps its v1.0 shape; the fleet just points every agent at the same instance.

---

## 2. Conceptual architecture

```
  my-fleet/
  ├── fleet.yaml                    # the manifest — what agents + how they relate
  ├── package.json                  # root deps; "workspaces": ["agents/*"]
  ├── bun.lock                      # single lockfile for the whole fleet
  ├── tenants.yaml                  # shared tenant registry (optional)
  ├── rpc-peers.yaml                # cross-agent peer table (aggregated)
  ├── secrets.yaml                  # shared secret providers + scopes
  ├── channels.yaml                 # shared channel registry (optional)
  ├── .env                          # shared env
  ├── .env.example
  ├── agents/
  │   ├── concierge/
  │   │   ├── agent.yaml
  │   │   ├── package.json          # optional; inherits root
  │   │   ├── event-sources.yaml
  │   │   └── skills/
  │   │       └── delegate.md
  │   └── pr-reviewer/
  │       ├── agent.yaml
  │       ├── capabilities.yaml     # when the agent serves RPC
  │       ├── event-sources.yaml
  │       └── skills/
  │           └── review-pr.md
  └── deploy/
      ├── gcp-cloud-run.yaml        # fleet-level deploy target
      └── k8s.yaml                  # alternate target
```

**Invariant.** A fleet is just a directory containing `fleet.yaml` + one or more `agents/<name>/`. Every agent is still a first-class standalone unit — remove `fleet.yaml` + the shared configs, and each `agents/<name>/` runs as a single-agent repo.

**Single-agent fallback.** When no `fleet.yaml` is found walking up from pwd, the CLI operates in single-agent mode (today's behavior). `declaragent run` stays unchanged. `declaragent fleet <verb>` errors with a helpful message pointing at `declaragent init --fleet`.

**Where config resolves.** Precedence (highest first):
1. Per-agent inline (`agent.yaml` fields).
2. Fleet-environment override (`fleet.yaml` → `environments.<env>.overrides`).
3. Fleet-root shared config (`tenants.yaml`, `rpc-peers.yaml`, etc.).
4. Built-in defaults.

---

## 3. The fleet manifest

### 3.1 `fleet.yaml` v1

```yaml
version: 1
name: acme-fleet
description: "Concierge + specialist agents for the Acme engineering org."

# Optional — pins the declaragent runtime the whole fleet expects.
runtime:
  declaragent: "^1.2.0"
  bun: ">=1.1"

agents:
  - id: concierge
    path: ./agents/concierge
    env: shared
    deploy:
      target: cloud-run-concierge
      minInstances: 1
      maxInstances: 10
  - id: pr-reviewer
    path: ./agents/pr-reviewer
    env: shared
    deploy:
      target: cloud-run-reviewer
      minInstances: 0
      maxInstances: 4

environments:
  shared:
    tenantsRef: ./tenants.yaml
    peersRef: ./rpc-peers.yaml
    secretsRef: ./secrets.yaml
    channelsRef: ./channels.yaml
    # Inject env into every agent in this environment:
    envFiles:
      - ./.env
    # Per-agent overrides keyed on agent id:
    overrides:
      pr-reviewer:
        secretScopes: ["vault:kv/acme/github-tokens"]
  staging:
    inherit: shared
    tenantsRef: ./tenants.staging.yaml

deploy:
  strategy: rolling        # rolling | all-or-nothing | per-agent
  rollbackOnFailure: true
  healthGate:
    timeoutMs: 120000
    probe: /healthz
  targets:
    cloud-run-concierge:
      kind: gcp-cloud-run
      region: us-central1
      serviceAccount: concierge@acme.iam.gserviceaccount.com
    cloud-run-reviewer:
      kind: gcp-cloud-run
      region: us-central1
      serviceAccount: reviewer@acme.iam.gserviceaccount.com
```

Lives in `packages/core/src/fleet/manifest-schema.ts`. Tagged `@since 1.2.0`. Zod schema + TS types + loader in one place.

### 3.2 Address resolution

- **Agent id** — unique within a fleet. Must match `agents/<id>/agent.yaml.name`; a mismatch is a validation error (§8 Q3).
- **Path** — relative to the fleet root. Must be a directory containing `agent.yaml`.
- **Environment** — every agent belongs to exactly one. Environments can `inherit:` another.

### 3.3 Capability aggregation

Every `agents/<id>/capabilities.yaml` is aggregated into a fleet-level view accessed via `declaragent fleet capabilities`:

```
agent://concierge        (no capabilities — client-only)
agent://pr-reviewer
  review-pr              timeoutMs=60000, idempotent=true
```

The aggregated view drives:
- `declaragent fleet graph` — mermaid diagram of inter-agent RPC edges.
- `declaragent fleet validate` — every `rpc-peers.yaml` entry resolves to an agent declaring the capability.

---

## 4. Root-level dependency management

### 4.1 Package.json

Fleet root:

```json
{
  "name": "acme-fleet",
  "private": true,
  "type": "module",
  "workspaces": ["agents/*"],
  "scripts": {
    "fleet:run": "declaragent fleet run",
    "fleet:validate": "declaragent fleet validate",
    "fleet:deploy": "declaragent fleet deploy"
  },
  "dependencies": {
    "@declaragent/core": "^1.2.0",
    "@declaragent/channel-slack": "^1.0.0",
    "@declaragent/source-kafka": "^1.0.0",
    "@declaragent/plugin-agent-rpc": "^1.1.0"
  }
}
```

Per-agent `package.json` (optional):

```json
{
  "name": "concierge",
  "private": true,
  "type": "module",
  "dependencies": {
    "@declaragent/plugin-github": "^1.0.0"
  }
}
```

Bun workspaces resolves dep hoisting automatically. Agents inherit root deps; per-agent deps land in the agent's own `node_modules` if version-pinned differently.

### 4.2 Lockfile

One `bun.lock` at fleet root. Per-agent lockfiles are rejected by `fleet validate`. Reason: dependency drift between agents in the same deploy unit is a common foot-gun.

### 4.3 `declaragent fleet install`

Thin wrapper over `bun install`. Exists so the CLI has one invocation point for dep setup — future slices can hook validation (supply-chain scanning, license check) here.

---

## 5. Runtime primitives

### 5.1 Manifest loader

Lives in `@declaragent/core/src/fleet/`.

```ts
export interface LoadedFleet {
  manifest: FleetManifest;
  root: string;                      // absolute path to fleet root
  agents: readonly LoadedAgentEntry[];
  environments: ReadonlyMap<string, LoadedEnvironment>;
  // Resolved + validated shared configs, already loaded.
  tenants?: LoadedTenantsConfig;
  peers?: LoadedPeers;
  secrets?: LoadedSecretsConfig;
  channels?: LoadedChannelsConfig;
}

export interface LoadedAgentEntry {
  id: string;
  path: string;                      // absolute
  spec: AgentSpec;                   // parsed agent.yaml
  capabilities?: LoadedCapabilities; // when the agent has capabilities.yaml
  env: string;                       // environment id
}

export function loadFleet(root: string): Promise<LoadedFleet>;
export function findFleetRoot(cwd: string): Promise<string | undefined>;
```

`findFleetRoot` walks up from `cwd` looking for `fleet.yaml`. Single-agent mode when nothing is found.

### 5.2 Aggregator

`aggregateCapabilities(fleet)` produces the fleet-level capability table. `aggregatePeers(fleet)` validates every `rpc-peers.yaml` entry against the aggregated capabilities — dangling entries throw.

### 5.3 Fleet daemon

`declaragent fleet run` starts one daemon that hosts every agent in-process:

```ts
const fleet = await loadFleet(root);
const bus = createEventBus();        // shared bus, tenant-scoped per agent
const sharedRpcBus = createMemoryBus(); // shared in-memory RPC broker
const sharedRpcTransport = createMemoryTransport({ bus: sharedRpcBus });

for (const agent of fleet.agents) {
  await startAgentWorker({
    spec: agent.spec,
    tenant: fleet.tenants?.byId.get(agent.env) ?? DEFAULT_TENANT_CONTEXT,
    rpcTransports: new Map([['memory', sharedRpcTransport]]),
    peers: fleet.peers,
    channels: fleet.channels,
    bus,
  });
}
```

- **Channel binding.** If two agents both reference `channels: [slack-prod]`, the channel binds once at the daemon level and is shared. A per-channel `owner` field (§14 Q3) resolves inbound-event ownership.
- **Session DB.** Default: one fleet-level SQLite at `./.declaragent/session.db`. Per-agent override via `fleet.yaml → agents[].sessionDb: "./agents/<id>/session.db"` (§14 Q2).
- **Audit sink.** One fleet-level audit DB. GDPR erase by `correlationId` tombstones across every agent in one pass.
- **Hot reload.** File-watch per agent; a change restarts only that worker. Shared channel + bus stays.

### 5.4 Fleet deploy

`declaragent fleet deploy [--target <name>] [--agent <id>...]`:

1. `fleet validate` — every schema clean; every peer resolves; every secret scope covered.
2. Build artifact per agent (Docker image / bundle, depending on target).
3. Stamp fleet version: `v${pkg.version}-${gitSha.slice(0,7)}`.
4. Apply deploy strategy:
   - **rolling** (default): agent by agent, run `deploy.healthGate.probe` after each; abort + rollback on failure.
   - **all-or-nothing**: parallel deploy; rollback all on any failure.
   - **per-agent**: fire and return; no cross-agent coordination.
5. Record fleet version in `.declaragent/fleet-deploys.jsonl` for `fleet status --history`.

Rollback: re-runs deploy with the previous fleet version's bundle. Audit records the rollback.

---

## 6. CLI surface

### 6.1 `init`

- `declaragent init` — today's single-agent wizard. Unchanged.
- `declaragent init --fleet <name>` — scaffold a new fleet:
  1. Create `<name>/fleet.yaml` + `package.json` + `bun.lock` + `.env.example` + empty `agents/` dir + `tenants.yaml` / `rpc-peers.yaml` / `secrets.yaml` / `channels.yaml` stubs.
  2. `cd <name> && bun install`.
  3. Print next-steps: "Add your first agent with `declaragent fleet add --template concierge`".
- `declaragent init --template <t>` — in a fleet directory, auto-routes to `fleet add --template <t>`. Outside a fleet, today's behavior.

### 6.2 `fleet` verbs

| Verb | Shape | Purpose |
| --- | --- | --- |
| `fleet new <name>` | `fleet new acme-fleet` | Alias for `init --fleet`. |
| `fleet add --template <t> [--id <id>]` | `fleet add --template rpc-server --id pr-reviewer` | Add an agent from a starter template. Writes `agents/<id>/`, updates `fleet.yaml`. |
| `fleet add --path <p> [--id <id>]` | `fleet add --path ../existing-agent` | Move an external single-agent directory into `agents/<id>/`. |
| `fleet promote <path>` | `fleet promote .` | Convert a single-agent repo into a fleet-of-one. `--dry-run` previews the mv/rewrite plan. |
| `fleet list` | | Print agent id, path, environment, capabilities. `--json` for scripts. |
| `fleet run [--agent <id>...]` | `fleet run --agent concierge --agent pr-reviewer` | Start a single daemon hosting the selected agents (default: all). |
| `fleet deploy [--target <name>] [--agent <id>...]` | `fleet deploy --target cloud-run-concierge` | Coordinated deploy. `--dry-run` prints the plan. |
| `fleet status` | | Live health across all agents + RPC reachability. `--history` shows recent deploys. |
| `fleet validate` | | Dry-run every schema + aggregated RPC graph. Non-zero exit on any finding. |
| `fleet graph` | | Emit mermaid of inter-agent RPC edges. `--format=dot` for graphviz. |
| `fleet capabilities` | | Aggregated capability view across every agent. |
| `fleet install` | | Thin wrapper over `bun install` at fleet root. |
| `fleet peers [--verify]` | | Print + optionally live-ping every peer in `rpc-peers.yaml`. |

### 6.3 Help surfacing

`declaragent --help` detects fleet context and adjusts:

- In a fleet dir: lists fleet verbs prominently, single-agent verbs demoted under "Per-agent".
- Outside: single-agent verbs primary, fleet verbs under "Monorepo".

---

## 7. Promote — single agent → fleet

`declaragent fleet promote <path>` converts an existing single-agent directory into a fleet-of-one. The flow:

1. **Detect target.** If `<path>` is already a fleet (has `fleet.yaml`), error. If it's not a single agent (no `agent.yaml`), error.
2. **Git-dirty check.** Refuse unless `--force` or working tree is clean. Promotes rewrite file paths.
3. **Dry-run preview.** Print the full mv/rewrite plan:
   ```
   <path>/agent.yaml               → <path>/agents/<id>/agent.yaml
   <path>/event-sources.yaml       → <path>/agents/<id>/event-sources.yaml
   <path>/skills/                  → <path>/agents/<id>/skills/
   <path>/package.json             (rewrite: name → <fleet-name>, add workspaces)
   <path>/fleet.yaml               (new)
   <path>/.env                     (unchanged; shared across fleet)
   ```
4. **Apply.** With `--apply`:
   - Move per-agent files under `agents/<id>/`.
   - Rewrite any relative paths inside `agent.yaml` that break post-move (skills, event-sources).
   - Create `fleet.yaml` with one agent entry.
   - Update root `package.json` with `"workspaces": ["agents/*"]`.
   - Drop a `PROMOTED.md` at the fleet root with a one-paragraph summary + the inverse command (`fleet demote <id>`).
5. **Post-checks.** `fleet validate` + `fleet list` run automatically; any failure reverts the mv (git-reset-assisted).

**Inverse.** `fleet demote <id>` moves one agent back out of the fleet. Errors if the fleet has >1 agent.

### 7.1 Risks during promote

- **CI workflow paths.** `.github/workflows/*.yml` that hardcode paths like `packages/core/` break. Promote warns on any workflow that greps to a path it's about to move, but doesn't rewrite — the user has to.
- **Secret paths.** `${secret:...}` values are relative references that survive the move. `.env.example` stays at the fleet root.
- **Deploy configs.** Dockerfiles / Cloud Run YAML often reference `agent.yaml` at the repo root. Promote lists each match and asks for confirmation.
- **Published artifacts.** If the agent was ever published to npm under its own name, the new `agents/<id>/` layout may not match the `files:` array in `package.json`. Promote flags.

### 7.2 When NOT to promote

- Agents that share code via relative imports — turn into a proper monorepo with a shared `packages/` dir first.
- Agents already published as separate npm packages with dependents — fleet membership changes the import path.

---

## 8. Deploy coordination

### 8.1 Strategies

```yaml
deploy:
  strategy: rolling | all-or-nothing | per-agent
```

**Rolling (default).** Sequential per-agent deploy. `healthGate.probe` GETs each agent after push; failure aborts + rolls back everything deployed so far in the batch. Default timeout 120s.

**All-or-nothing.** Parallel build + push. Failure of any agent rolls back all. Lower latency; higher blast radius on transient target failures.

**Per-agent.** No coordination — back-compat mode for teams that want the manifest + dev loop but not atomic deploys.

### 8.2 Fleet versioning

Every deploy stamps a fleet version:

```
v1.2.0-a1b2c3d
```

Format: `v${pkg.version}-${gitSha.slice(0,7)}`. Injected as:

- `DECLARAGENT_FLEET_VERSION` env var on every deployed agent.
- Envelope header `x-fleet-version` on every outbound RPC request (opt-in via `fleet.yaml → rpc.stampFleetVersion: true`).

### 8.3 Version skew

When `stampFleetVersion` is on, receivers check inbound envelopes against their own `DECLARAGENT_FLEET_VERSION`:

- Same version: OK.
- Older caller: accept (rolling deploy's transient state).
- Newer caller: accept but log a warning + emit a `fleet.version.skew` metric. Operators gate on sustained skew.
- A `minFleetVersion` in `fleet.yaml` lets a receiver reject callers older than a pinned cutoff (`EVERSION_SKEW` tool result).

### 8.4 Rollback

```bash
declaragent fleet deploy --rollback
```

Re-runs the previous deploy from `.declaragent/fleet-deploys.jsonl`. Records a rollback audit record.

### 8.5 Secrets during deploy

Fleet-root `secrets.yaml` is resolved at deploy time. Each target's secret-management contract dictates the mechanism:

- Cloud Run: Secret Manager references injected as env.
- K8s: `SealedSecret` YAML emitted alongside the manifest.
- Docker Compose: `.env` file rendered from `${secret:...}` values.

Per-agent `secretScopes` filter which secrets each agent sees — fail-closed default.

---

## 9. Slice breakdown

Same shape as the RPC and Phase plans: thin vertical slices, each independently mergeable, critical path serialized with parallel legs.

### Slice 0 — Manifest schema + loader (~1.5 days)
- `packages/core/src/fleet/manifest-schema.ts` — Zod schema + TS types + `@since 1.2.0`.
- `packages/core/src/fleet/manifest-loader.ts` — `loadFleet` + `findFleetRoot`.
- `packages/core/src/fleet/types.ts`, `index.ts`, re-exports from `packages/core/src/index.ts`.
- Tests: schema round-trip, strict-mode rejects unknown keys, environment inheritance, per-agent override merge, path resolution.

### Slice 1 — `fleet list` + `fleet validate` + `fleet capabilities` (~1 day)
- `packages/cli/src/fleet-cli.ts` — verb router.
- Reads-only verbs first; no mutations.
- Tests: fixture fleets under `__fixtures__/fleets/{simple,multi-env,bad-peer}/`.

### Slice 2 — `fleet init` + `fleet add --template` (~1.5 days)
- Writes. Scaffolds new fleets + adds agents from the existing template catalog.
- Tests: idempotent re-runs (rejects if target exists); agent id collisions; `--id` override when template name clashes.

### Slice 3 — `fleet run` single-daemon multi-agent (~2 days)
- `packages/cli/src/fleet-run.ts` — spawns one daemon with N agent workers.
- Reuses the Phase-3 daemon with a tweaked `startDaemon` that accepts `agents: AgentSpec[]`.
- Shared in-memory RPC transport + channel registry.
- Tests: two-agent fleet with inter-agent RPC; one shared Slack channel; file-watch hot reload.

### Slice 4 — `fleet promote` + `fleet demote` (~2 days)
- `packages/cli/src/fleet-promote.ts` — dry-run + apply + revert.
- Git-dirty check; `--force` override.
- Tests: snapshot the before/after tree for each starter template; promote-then-demote is a no-op.

### Slice 5 — `fleet deploy` (rolling + per-agent first) (~2.5 days)
- `packages/cli/src/fleet-deploy.ts`.
- Rolling strategy; per-target adapter interface (`FleetDeployTarget`).
- First target: `gcp-cloud-run` (since the existing `concierge` template deploys there).
- Deploy history jsonl + rollback verb.
- Tests: contract test every target accepts a valid bundle; rollback restores previous version.

### Slice 6 — `fleet graph` + `fleet peers [--verify]` (~1 day)
- Mermaid + graphviz emitters for the aggregated capability graph.
- Peer live-verify pings every peer's inbox and reports unreachable.
- Tests: known-good fixtures; unreachable-peer output contains the peer id + transport.

### Slice 7 — All-or-nothing + version-skew wiring (~1.5 days)
- Parallel deploy path.
- `DECLARAGENT_FLEET_VERSION` env + optional envelope header stamping.
- `minFleetVersion` gate on the receiver.
- Tests: skew detection, rejection path, audit record shape.

### Slice 8 — `fleet status` + live health (~1.5 days)
- Per-agent health (reuses source + channel `health()` methods).
- RPC reachability (per peer, per transport).
- `--history` shows last N deploys.
- `--json` for dashboards.

### Slice 9 — Template: `fleet-starter` (~1 day)
- `templates/fleet-starter/` — `rpc-client` + `rpc-server` pre-installed as members.
- `templates-verify.ts` extended to handle fleet templates (walk each `agents/*` subdir as if it were a single-agent template).

### Slice 10 — Docs + cookbook + CLI help (~1.5 days)
- `docs-site/docs/reference/fleet.mdx` — manifest schema, precedence rules, promote flow.
- `docs-site/docs/cookbook/fleet.mdx` — walkthrough of the `fleet-starter` template.
- CLI help adjusts per-fleet context.

### Slice 11 — Soak + release candidate (~1 day)
- Nightly: three-agent fleet running over in-memory RPC for 24h; assert zero drops.
- Deploy soak against a throwaway GCP project; rolling + rollback each work.
- `v1.2.0-rc.1` → `v1.2.0` promotion.

**Critical path:** 0 → 1 → 2 → 3 → {4 ∥ 5 ∥ 6} → 7 → 8 → 9 → 10 → 11. Slices 4 + 5 + 6 parallelize. Slice 9 gates on 2 (add) + 3 (run).

**Total estimate:** ~17 days of focused work.

---

## 10. File layout

```
packages/core/src/fleet/                # slice 0
├── manifest-schema.ts
├── manifest-loader.ts
├── aggregator.ts                       # capability + peer aggregation
├── types.ts
└── index.ts

packages/cli/src/                       # slices 1-8
├── fleet-cli.ts                        # declaragent fleet <verb> router
├── fleet-init.ts                       # declaragent init --fleet
├── fleet-add.ts
├── fleet-list.ts
├── fleet-validate.ts
├── fleet-capabilities.ts
├── fleet-run.ts
├── fleet-promote.ts
├── fleet-deploy.ts
├── fleet-graph.ts
├── fleet-peers.ts
├── fleet-status.ts
└── fleet-install.ts

templates/fleet-starter/                # slice 9
├── fleet.yaml
├── package.json
├── README.md
├── tenants.yaml
├── rpc-peers.yaml
├── secrets.yaml
├── channels.yaml
├── .env.example
└── agents/
    ├── concierge/                      # copy of templates/rpc-client/
    └── pr-reviewer/                    # copy of templates/rpc-server/

docs-site/docs/reference/fleet.mdx      # slice 10
docs-site/docs/cookbook/fleet.mdx       # slice 10

.github/workflows/fleet-soak.yml        # slice 11 (nightly)
```

---

## 11. Touch points into existing code

Fleet is deliberately a thin layer on top of single-agent v1.0. Core touches:

- `packages/core/src/fleet/**` — net-new.
- `packages/core/src/index.ts` — re-export fleet types.
- `packages/core/src/events/daemon.ts` — accept `agents: AgentSpec[]` (optional; existing single-agent callers unaffected).
- `packages/core/src/channels/registry.ts` — share a registry across N agents when run via `fleet run`. Already supported in theory; slice 3 exercises the path.
- `packages/cli/src/index.tsx` — add `fleet` subcommand router.
- `scripts/verify-templates.ts` — detect `fleet.yaml` and recurse into `agents/*`.

The engine loop, dispatcher, event bus, session store, permission gate, quota tracker, audit sink, channel adapters, source adapter SDK — **unchanged**.

---

## 12. Testing strategy

Six tiers.

1. **Unit.** Every new file's `*.test.ts`. Manifest schema round-trip, loader error paths, aggregator dangling-peer detection, promote dry-run snapshot.
2. **Integration.** Fixture fleets under `packages/cli/src/__fixtures__/fleets/`. Every CLI verb runs against each fixture with snapshot comparison.
3. **Fleet run.** Two-agent fleet (`concierge` + `pr-reviewer`) exchanging a review-pr request in one daemon. End-to-end over in-memory RPC.
4. **Promote.** For every starter template (`concierge`, `pr-review`, `rpc-client`, `rpc-server`, etc.), snapshot the promote-apply output; assert `fleet validate` + `fleet run` succeed.
5. **Deploy contract.** Each `FleetDeployTarget` implementor imports a shared contract test (`conformsToFleetDeployTarget`). Rolling + all-or-nothing paths both covered.
6. **Soak.** Nightly three-agent fleet, 24h loop, zero drops + zero loop-rejections.

Baseline test count: **1671 pass** at the start of the fleet work (post-RPC slice 2). Every slice must add tests, not regress existing ones.

---

## 13. Security

- **Secret scoping.** Every agent declares the secret scopes it needs. Fleet-root resolver filters by scope before handing env to each agent worker. A missing scope = resolve-time error, not a runtime surprise.
- **Audit continuity.** One fleet audit sink; hash chain spans every agent. GDPR erase by `correlationId` + `userId` tombstones across all agents in one pass.
- **Deploy auth.** Each `deploy.targets[]` entry references a service-account secret via `${secret:...}`. No target credentials live in `fleet.yaml` cleartext.
- **RPC auth.** Unchanged — `envelope.auth` + transport hooks. Fleet just aggregates the peer table; it doesn't bypass the security layer.
- **Supply chain.** `fleet install` surface is a natural hook for lockfile lint, `bun audit`, SBOM export. Slice 0 doesn't wire these, but the command exists so slice 11 can add them.

---

## 14. Design decisions

Every prior "lean" is promoted to a concrete decision with reasoning captured below. A future v1.3 slice can revisit any of these behind a changeset — these are the v1.2-freeze answers.

### 14.1 Agent enumeration — **explicit via `fleet.yaml → agents[]`**

No directory auto-discovery in v1.2. Every agent is an explicit entry with `id`, `path`, `env`.

- **Why.** Auto-discovery is a foot-gun: half-committed agents, test fixtures under `agents/`, and WIP branches all become accidental fleet members. An explicit manifest means `git diff fleet.yaml` is the single source of truth for "what ships".
- **Tradeoff.** Adding an agent is two steps (`fleet add` writes both the files and the manifest). Acceptable — `fleet add` is the automation.
- **Escape hatch.** v1.3 can ship `--auto-discover` as an opt-in `fleet.yaml` flag.

### 14.2 Session + audit storage — **shared at fleet root; per-agent opt-out**

Default: one SQLite at `./.declaragent/session.db` + one audit sink at `./.declaragent/audit.db`. Per-agent override via `fleet.yaml → agents[].sessionDb` / `auditDb`.

- **Why.**
  - **GDPR coherence.** `declaragent audit erase --user U123 --fleet .` tombstones in one pass across every agent. Per-agent DBs would require N separate erase operations with a risk of partial erasure.
  - **Correlation threading.** An RPC call from concierge → pr-reviewer lives in one chain. A single audit DB lets `declaragent events list --correlation <id>` surface every hop without cross-DB joins.
  - **Dev UX.** One DB to inspect beats N.
- **Escape hatch.** Noisy-neighbor tenants with high write volume opt into per-agent session DBs; the audit sink stays shared for compliance.

### 14.3 Channel ownership — **explicit `owner` per channel, per environment**

`channels.yaml` gains an `owner:` field. `fleet validate` enforces exactly one owner per channel per env.

```yaml
# channels.yaml
- id: slack-prod
  type: slack
  owner: agent://concierge       # inbound events route here
  config: { ... }
- id: slack-oncall
  type: slack
  owner: agent://oncall-escalator
  config: { ... }
```

- **Why.** Slack events need exactly one handler — broadcasting causes duplicate work and duplicate replies; first-match is order-dependent and therefore non-deterministic across restarts. An explicit `owner` field makes routing intent mergeable in PRs and reviewable in `fleet graph`.
- **Outbound vs inbound.** `owner` controls **inbound** routing only. Every agent can **send** to any channel it has permission for (`SendMessage:channel:<id>/*`).
- **Multi-env.** Same channel id can be owned by different agents across environments (e.g. `slack-prod` owned by `concierge` in `shared`, by `oncall-escalator` in `staging`).

### 14.4 Agent id == `agent.yaml.name` — **required equality**

`fleet.yaml → agents[].id` must equal `agents/<id>/agent.yaml.name`. Mismatch = validation error at load time.

- **Why.** The id appears in `agent://<id>` envelope addresses, tenant audit records, log lines, metrics labels, and `fleet graph` nodes. Two surfaces (`name` + `id`) diverging creates operational confusion. One source of truth beats two aliases.
- **Blue-green.** Belongs at the deploy-target layer (same id, different traffic weights between target versions), not at fleet-level. See §8.1 for the target-config shape.

### 14.5 Workspace manager — **Bun workspaces only in v1.2**

`fleet install` is a thin wrapper over `bun install`. Per-agent lockfiles are rejected by `fleet validate`.

- **Why.** Project already pins Bun (`"bun": ">=1.1"` in CLAUDE.md). Adding pnpm / yarn / npm-workspaces multiplies the test matrix and each hoists differently. Teams on those tools keep their existing flows — they lose `fleet install` but everything else works.
- **Escape hatch.** `fleet install --skip` lets users hand off to their own package manager; the CLI only needs `node_modules` resolvable, it doesn't care who populated them.

### 14.6 Versioning — **changesets at fleet root**

Existing `.changeset/` flow unchanged. Per-agent versions live in each `agents/<id>/package.json`. Changesets' workspace resolution handles the rest.

- **Why.** Changesets already set up at the repo root; reusing that flow means zero new tooling. Every agent in the fleet bumps together on a fleet-wide release, or selectively via `ignore:` for agents that didn't change.
- **Per-agent publish.** If a fleet publishes its agents as separate npm packages, changesets' `mode: independent` handles per-agent semver — orthogonal to fleet membership.

### 14.7 Deploy targets — **fleet-level only; ad-hoc via `--target-config`**

`fleet.yaml → deploy.targets{}` is the single source of truth. Agents reference targets by key. Ad-hoc deploys use `declaragent fleet deploy --target-config <path>` to supply a one-off target file.

- **Why.** Prevents shadow deploys. An agent that references a target not in `fleet.yaml` would need its own credentials + service-account wiring; allowing that bypasses the fleet's audit + rollback story. Ad-hoc via explicit flag keeps the pattern visible.
- **CI pattern.** Staging vs prod = two `fleet.yaml` environments with different target keys, not two target registries.

### 14.8 `fleetVersion` envelope stamping — **opt-in via `fleet.yaml`**

Envelope `x-fleet-version` header + `minFleetVersion` receiver gate is gated behind `fleet.yaml → rpc.stampFleetVersion: true`. Default off.

- **Why.** Coupling RPC v1.1 envelopes to fleet v1.2 concepts would bleed the fleet abstraction into the RPC protocol. Keeping it opt-in means non-fleet RPC deployments (multiple single-agent repos in one cluster) are unaffected, and fleet users who want skew detection get a one-line toggle.
- **When to turn on.** Rolling deploys of a fleet where `minFleetVersion` protects against callers pinned to a retracted release. Dev and small fleets leave it off.

### 14.9 Graph output format — **mermaid default, `--format=dot|json`**

```bash
declaragent fleet graph                # mermaid (default; renders in Docusaurus + GitHub MD)
declaragent fleet graph --format=dot   # graphviz dot
declaragent fleet graph --format=json  # structured edges for CI scripts
```

- **Why mermaid default.** Docusaurus ships native mermaid rendering (already wired in `docusaurus.config.ts`). GitHub markdown renders it too. The cookbook page embeds the output directly.
- **Why dot.** Teams with established graphviz pipelines (dependency visualizers, layout control) get a first-class path.
- **Why json.** CI pipelines that gate on "did the fleet's RPC topology change?" can `jq` over the structured shape.

### 14.10 `fleet demote` scope — **fleet-of-one only; refuse for N>1**

`declaragent fleet demote <id>` converts a single-member fleet back into a standalone agent. Fleets with N>1 members refuse with a clear message pointing at `fleet remove <id>` + manual extraction.

- **Why.** Demoting one of many leaves ambiguous state: does the remaining fleet still have a manifest pointing at a missing agent? Do shared configs (tenants, peers, channels) still apply to the extracted agent? Fleet-of-one keeps the semantics clean — `promote` and `demote` are exact inverses.
- **N>1 extraction runbook.** Users who want to split a fleet do it manually: `fleet remove <id>` removes the manifest entry, then `mv agents/<id> ../extracted-agent`, then wire up a fresh single-agent layout. `fleet demote`'s help text links this runbook.

---

## 15. Risks

- **Promote data loss.** The mv flow is one-way enough that a botched `--apply` could mangle a working repo. Mitigation: git-dirty refusal by default; `--dry-run` prints the exact plan; apply is git-stage-then-mv so `git reset` + `git checkout` reverts.
- **Dev UX regression.** Single-agent users who stumble into `init --fleet` get a confusing scaffold. Mitigation: strong help-surfacing; `init` defaults stay single-agent.
- **Deploy half-state.** Rolling deploy that aborts mid-way leaves a mixed-version fleet. Mitigation: rollback-on-failure default; fleet version skew audit; alert on sustained skew.
- **Shared secret leakage.** Fleet-wide resolver seeing all secrets means one compromised agent exposes all of them. Mitigation: explicit `secretScopes` per agent; fail-closed; audit every secret resolve.
- **Manifest drift.** `fleet.yaml` says N agents, filesystem shows N+1. `fleet validate` catches, but in CI only. Mitigation: `fleet run` + `fleet deploy` always re-validate at startup.
- **Channel double-binding.** Two agents both claim `slack-prod` — inbound event duplicates or races. Mitigation: §14 Q3's explicit owner field; validate exactly one per env.
- **Changeset churn.** Every fleet-wide bump now touches every agent's `package.json`. Mitigation: changesets' `ignore:` field keeps unaffected agents pinned; operators opt into fleet-wide bump by touching the fleet-root `.changeset`.
- **Monorepo discovery edge-cases.** `findFleetRoot` walks up; in nested layouts (git submodules, symlinked agents) it may find a surprise. Mitigation: `--fleet-root <path>` override; `fleet list` always prints the resolved root.

---

## 16. Acceptance check

Practical bar for v1.2:

1. **`declaragent init --fleet my-fleet`** produces a valid scaffold. `fleet validate` green; `fleet list` shows zero agents; `fleet add --template rpc-client --id concierge` + `fleet add --template rpc-server --id pr-reviewer` succeed.
2. **`declaragent fleet run`** starts both agents in one daemon. A review-pr request issued through the concierge round-trips the response end-to-end in under 200ms on a warm cache.
3. **`declaragent fleet promote ./single-agent`** converts an existing single-agent template (any of the Phase-1-through-7 templates) into a fleet-of-one. The agent still runs cleanly via `fleet run`. `fleet demote <id>` reverses the promote; the repo is bit-identical to pre-promote (git-diff-clean).
4. **`declaragent fleet deploy --target cloud-run`** ships both agents atomically via rolling strategy. `fleet deploy --rollback` reverts to the previous fleet version.
5. **`declaragent fleet validate`** surfaces a dangling `rpc-peers.yaml` entry (pointing to an agent not in the fleet) with a line-precise error. Same for circular peer references + duplicate capability names across peers.
6. **`declaragent fleet graph`** emits mermaid rendering every RPC edge between agents, color-coded by transport. Docusaurus cookbook page renders it.
7. **`declaragent fleet status`** prints per-agent health (from `source.health()`), RPC reachability (per peer, per transport), and the last 5 deploy versions.
8. **GDPR erase:** `declaragent audit erase --user U123 --fleet .` tombstones chat + tool-call records on every agent in the fleet in one pass.
9. **Every slice ships a changeset.** `release-gate.yml` stays green on every merge.

---

## 17. Next step

**First concrete PR:** `packages/core/src/fleet/manifest-schema.ts` + `manifest-loader.ts` + `findFleetRoot` + `@since 1.2.0` tags. Small, reviewable, unblocks every subsequent slice.

Expect ~1.5 days to land; 25-30 new tests; every Phase-1-through-7 + v1.1 RPC test stays green (the core changes are additive and gated behind `fleet.yaml` detection).

Once slice 0 lands:
- Slice 1 (`fleet list` / `validate` / `capabilities`) is 100% test-driven against fixture fleets.
- Slice 2 (`fleet init` / `add`) gates on slice 1.
- Slice 3 (`fleet run`) gates on slice 2 + reuses the existing daemon.
- Slices 4 (`promote`), 5 (`deploy`), 6 (`graph` / `peers`) parallelize after slice 3.

The launch moment is slice 11's three-agent soak. v1.2 ships when the green chain holds for 7 days.

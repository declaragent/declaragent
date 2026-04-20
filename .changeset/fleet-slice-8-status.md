---
'@declaragent/cli': minor
---

Fleet slice 8 — `declaragent fleet status`.

Composes slice 0 / 5 / 6 primitives into a single read-only snapshot of
a fleet's health: per-agent config files, capability summary, peer
reachability, and an optional deploy-history tail. Satisfies
FLEET_PLAN.md §16 acceptance check #7.

```bash
declaragent fleet status                # static snapshot
declaragent fleet status --history      # + last 5 deploys
declaragent fleet status --history --limit 20 --json
```

**`packages/cli/src/fleet-status-cli.ts`**

- `buildFleetStatus(fleet, options)` — pure, fs-injectable builder.
  Returns:
  - `fleet: { name, root, selfVersion? }` — name + absolute root +
    resolved `DECLARAGENT_FLEET_VERSION` (from env override by default).
  - `agents[]` — `{id, env, capabilities[], files: {agentYaml, capabilitiesYaml, eventSourcesYaml, skills}, deployTarget?, lastDeploy?}`.
    `lastDeploy` is the newest record in `.declaragent/fleet-deploys.jsonl`
    that touched that agent (preserving ok / error / artifact).
  - `peers` — slice-6 `FleetPeersReport` verbatim.
  - `history?` — present when `options.history` is set; newest-first,
    capped at `historyLimit` (default 5 per §16 check #7).
- `fleetStatus(args, deps)` — CLI verb. Accepts `--history`, `--limit N`,
  `--json`. Human renderer groups agents + peers + history with
  coloured-neutral tags (`✓ ✗ ℹ ?`).

**CLI wiring.** `declaragent fleet status [--history] [--limit <n>] [--json]`
routed through `runFleetSubcommand`; help text updated.

**Tests.** 13 new in `fleet-status-cli.test.ts`:
- builder: file discovery, capability summary, peer mirror, history
  flag + limit ordering, last-deploy-per-agent merging across records,
  `selfVersion` override.
- CLI verb: human output shape, `--json` parses, `--history` includes
  tail, error paths (no fleet / broken manifest), env var + explicit
  `selfVersion` precedence.

**Deliberately out of scope for slice 8 (noted in the file header):**
Live daemon introspection (attach to a running `fleet run`, pull
`source.health()` + channel health) is slice 8.1. Today's output is a
static config + history snapshot; the `--json` shape is stable so
dashboards can consume now and pick up live fields later.

**Next.** Slice 9 — `fleet-starter` template.

---
'@declaragent/core': minor
'@declaragent/cli': minor
---

Fleet slice 2 — `declaragent init --fleet` + `declaragent fleet add`.

First mutating verbs in the fleet family. Turns the slice-0 manifest
schema + slice-1 read-only verbs into a usable bootstrap loop:

```
declaragent init --fleet my-fleet          # or: declaragent fleet new my-fleet
cd my-fleet
declaragent fleet add --template rpc-client --id concierge
declaragent fleet add --template rpc-server --id pr-reviewer
declaragent fleet validate                 # ✓ fleet validates clean
```

**Schema.** `fleet.yaml.agents` is now `z.array(...)` (was `.min(1)`) so
a freshly-scaffolded empty fleet loads cleanly. `fleet validate` will
flag empty fleets as informational in a later slice; slice 2 leaves
them as-is since an empty scaffold is the expected zero-step state.

**`packages/cli/src/fleet-scaffold.ts`** — pure scaffolding helpers,
fully tested against tmpdir fixtures:

- `scaffoldFleet({root, name, force?})` writes `fleet.yaml`,
  `package.json` (with `"workspaces": ["agents/*"]`), `.gitignore`,
  `.env.example`, `rpc-peers.yaml` stub, `README.md`, and
  `agents/.gitkeep`. Refuses to overwrite `fleet.yaml` or
  `package.json` unless `force: true`.
- `addAgentFromTemplate({fleetRoot, template, templatesDir, id?, force?})`
  walks the template tree into `agents/<id>/`, rewrites `agent.yaml`'s
  `name:` + `capabilities.yaml`'s `agent: agent://<id>` so the §14.4
  invariant holds, then surgically appends the new entry to
  `fleet.yaml` (preserves surrounding comments + formatting).
- `addAgentFromPath({fleetRoot, sourceDir, id?})` — same as above for
  an external single-agent directory. Copy semantics; the move/promote
  flow is slice 4.

**`packages/cli/src/fleet-init-cli.ts` + `fleet-add-cli.ts`** — thin
wrappers that handle arg parsing, error reporting, and (for `add`)
walking up from cwd via `findFleetRoot`. Both default their templates
directory to the repo's `templates/` but accept an explicit
`templatesDir` so tests + future packaged-template deploys can inject
their own.

**`packages/cli/src/index.tsx`** — new verb router entries:

- `declaragent fleet new <name> [--out <dir>] [--force]`
- `declaragent fleet add --template <name> [--id <id>] [--force]`
- `declaragent fleet add --path <dir> [--id <id>] [--force]`
- `declaragent init --fleet <name>` — shortcut that routes into the
  same `fleetInit` handler.

**Tests.** 25 new tests across `fleet-scaffold.test.ts`,
`fleet-init-cli.test.ts`, `fleet-add-cli.test.ts`, plus a one-shot
`fleet-e2e.test.ts` that runs `fleet new` → `fleet add` ×2 →
`fleet list` → `fleet capabilities` → `fleet validate` end-to-end,
satisfying FLEET_PLAN.md §16 acceptance check #1 for slice 2's scope.

**Next.** Slice 3 — `fleet run` single-daemon multi-agent dev loop.

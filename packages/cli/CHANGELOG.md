# @declaragent/cli

## 0.4.15

### Patch Changes

Republish of 0.4.14 — the npm registry lost the 0.4.14 tarball (metadata landed, blob 404s). No code changes vs 0.4.14; see that entry for actual behavior deltas.

## 0.4.14

### Patch Changes

Fix events stuck at `outcome: null` — dispatcher never received bus events through `dispatcher.attach(bus)`. Replaces the attach path with an explicit `bus.subscribe('*', ...)` wrapper that calls `dispatcher.handle(event)` and logs the full life cycle: `dispatcher.handling` (event arrived), `dispatcher.outcome` (dispatched/rejected/broadcast/duplicate), or `dispatcher.error` (unexpected throw). Every webhook / cron / file-watch event now produces a visible trace in the per-agent log, and outcomes persist via the dispatcher's own `markOutcome` path.

## 0.4.13

### Patch Changes

Surfaced by the fleet test showing events stuck at `outcome: null` despite the dispatcher path being wired in 0.4.11:

- **Await skill registration before dispatcher attach.** The per-agent extension registry's `register` calls were fire-and-forget (`void registry.register(...)`). If the bus published a webhook event before every skill finished registering, the dispatcher's `lookupSkill` returned `undefined` and the event sat forever with no outcome. Now awaited, then `dispatcher.attach()` subscribes — guaranteed ordering.
- **`dispatcher.attached` + `dispatcher.attach-failed` now log.** Previously the attach path was silent on success, so "event never dispatched" was impossible to tell apart from "dispatcher never attached." Per-agent log now records the attach + skill count, and any thrown error during attach lands with `level: error`.
- **`declaragent logs [-f] [<id>]` works post-`down`.** The verb used to refuse with "nothing up" when no state file was present — wrong, since log files persist across lifecycle cycles. Now falls back to listing `~/.declaragent/logs/*.log` when state is absent. Errors cleanly when the requested agent id has no log file on disk.
- **`ps` renders file-watch summaries correctly.** Previously rendered `file-watch ?` because `summariseSource` only read `cfg.dir` / `cfg.path`; the canonical adapter config uses `cfg.paths: string[]`. Now shows the first watched path with a `+N more` hint for multi-path configs.

## 0.4.12

### Patch Changes

Fix `declaragent up -d` under compiled Bun binaries. For a `bun build --compile` output, `process.argv[0]` returns the embedded interpreter name (`bun`), not the binary path — so `detachSelf` was spawning `bun up --__detached`, which Bun interprets as "run a script called `up`" and crashes with `Script not found "up"`. Swap to `process.execPath`, which for compiled binaries is the actual binary path. No other behavior changed; 0.4.11's dispatcher + observability fixes are still in place.

## 0.4.11

### Patch Changes

Event dispatch end-to-end + four bug fixes surfaced by the first 0.4.1 E2E run. The version number jumps from 0.4.1 → 0.4.11 intentionally.

**Dispatcher wired into `declaragent up` (the headline)**

`up` previously bound sources + recorded events to the store with `outcome: pending` — nothing pulled events off the bus and invoked the matching skill. Webhooks fired into the void. This release attaches core's `createEventDispatcher` to each agent's bus, builds a per-agent extension registry from the scaffolded skills, and constructs an engine bound to the user's provider + built-in tools. Events with `target: {type: skill, name: X}` now run as real LLM turns; `ps` / `events list` / the per-agent log all show the dispatched outcome. When no creds are configured the startup banner warns that dispatch is skipped but sources still bind.

**Observability + correctness fixes**

- **`kind: skill` → `type: skill` in templates.** `pr-review` and `oncall-escalator` shipped with the wrong target discriminator — `EventTarget` uses `type:`, not `kind:`. Events silently tripped a SQLite `NOT NULL` constraint on `events.target_type` and the bus subscriber's NOOP logger ate the error. Both templates fixed; `kafka-pipeline` already had it right.
- **Webhook / cron / file-watch adapters reject unknown target types at bind time.** New shared helper `assertEventTarget(target, sourceType)` in core catches the `kind`→`type` typo with a specific rewrite hint ("your config uses `kind` — replace with `type: skill`") so the next `declaragent up` fails fast instead of silently dropping every event.
- **Per-agent logger wired into `startAgentSources`.** The default `NOOP_LOGGER` used to eat `event-store.record-failed` warnings; `up` now passes a bridge that routes core's `Logger` calls into the per-agent log file. `declaragent logs <agent>` surfaces bus-level failures.
- **`up -d` detach is observable + synchronous.** Child stdout/stderr append to `~/.declaragent/up-startup.log` instead of `/dev/null`, and the parent polls the state file for up to 8s before returning. `up -d` now only prints `✓ up` once sources are actually bound; a crash mid-startup surfaces a tail of the log automatically.

**Test footprint**

5 new target-validator tests in core; 2 new `up-lifecycle` waiters. All 2166 tests pass, 0 regressions.

## 0.4.1

### Patch Changes

- 5692b12: Docker-Compose-style lifecycle verbs + `d9t` alias.

  **Four new verbs** replace the per-agent REPL path (`declaragent run <dir>`, removed) with a true multi-agent lifecycle story:

  - `declaragent up [-d|--detach] [-f <path>]` — discovers `fleet.yaml` or `agent.yaml` in the cwd (or takes `-f` explicitly), loads every agent, brings their declared in-process sources (webhook / cron / file-watch) online via the same `startAgentSources` path that `run` used to drive, and persists a state snapshot at `~/.declaragent/up-state.json`. Default is foreground with a banner + Ctrl+C shutdown; `-d` detaches via `child_process.spawn({detached: true})` and returns the child pid. Re-running `up` while something's already up gracefully stops the old process first (reload semantics).
  - `declaragent down` — sends SIGTERM to the pid recorded in `up.pid`, waits up to 5s for a clean exit, escalates to SIGKILL, and clears state. No-op + 0 exit when nothing is up.
  - `declaragent ps` — reads the state snapshot, reaps stale state if the pid is dead, and prints the bound agents + their sources with a relative-time `up since …`.
  - `declaragent logs [-f|--follow] [<agent-id>]` — tails `~/.declaragent/logs/<id>.log` (newline-delimited JSON appended by the `up` process's event subscriber). `-f` watches the files for appends via `fs.watch`.

  **`d9t` alias** both `declaragent` and `d9t` now point at the same launcher. Existing scripts keep working; the shorter name is there when you want it.

  **Removed** `declaragent run <dir>`. The skill-only REPL scope is covered by `declaragent up` for a bound, event-driven agent, and by the plain `declaragent` REPL for interactive builder work. The underlying modules (`run-agent-cli.ts`, `run-agent-sources.ts`) are still exported for downstream reuse.

## 0.4.0

### Minor Changes

- fa676a6: Complete the builder-tool matrix (Phase B of USABILITY_PLAN.md). Four new authoring tools ship in this release — `DeclaraAddSource` (per-agent `event-sources.yaml` with round-trip adapter validation for webhook/cron/file-watch), `DeclaraAddChannel` (user-global `channels.json`), `DeclaraAddMCP` (user-global `mcp-servers.json`), `DeclaraAddPlugin` (user-global `plugins.json` with consent captured via the proposal flow). Every scaffolded capability — skill, source, channel, MCP, plugin, secret, peer — is now reachable through conversational authoring; `DeclaraApplyChange` no longer returns "step kind not supported" for these four kinds.

### Patch Changes

- fa676a6: Wire `declaragent fleet run` to the real LLM engine (Phase A.2 of USABILITY_PLAN.md). Previously the multi-agent dev loop echoed every capability request via a slice-3 stub; now each scaffolded agent loads its `agent.yaml` + `skills/`, builds a per-agent extension registry, and answers RPC calls by running the matching skill against a real engine turn. Tests that want a deterministic no-LLM path keep working via `deps.makeHandler = () => defaultHandler`.
- fa676a6: REPL UX polish (Phase C / P2 of USABILITY_PLAN.md). Four conversational-flow items shipping together:

  - **Bracketed-paste support.** Multi-line pastes no longer submit after the first line. Architecture mirrors Claude Code's tokenizer: `CSI ?2004h` is enabled on mount; a parallel `process.stdin` listener runs a two-state FSM that detects `CSI 200~` / `CSI 201~` markers (spanning chunk boundaries), buffers the content, and flushes it via `setInput(prior + body)` once the end marker arrives. Ink's own pre-parser continues to route keystrokes as usual, but TextInput's `onChange` / `onSubmit` are gated on an `inPaste` flag so the embedded `\n` mid-paste never fires a submit and the first line never leaks into the controlled input. `\x1b[?2004l` is written on unmount.
  - **`/prompt <path>`** reads a file and submits its contents verbatim as the next user message. Stays useful for pastes that exceed terminal buffering, or terminals without bracketed-paste support.
  - **`@<path>` file refs** inline file contents into any user message. Supports absolute + relative + `~/` paths, deduplicates repeated tokens, truncates oversized attachments at 256KB, and surfaces per-ref hit/miss system lines so the user sees what got attached. Emails (`user@host.com`) are left alone.
  - **Y/N keypress shortcuts for pending proposals** — a bare `y` / `yes` / `n` / `no` submission is routed as `/yes` / `/no` while a proposal is outstanding. The typed flow (including `/yes <phrase>` for explicit-yes proposals and `/edit <n> <replacement>`) keeps working unchanged. A new hint line renders above the input when a proposal is pending.

## 0.3.5

### Patch Changes

- 2168cff: Wire `event-sources.yaml` into `declaragent run <dir>`.

  0.3.5 closes the second half of Phase A.1 in USABILITY_PLAN.md.
  Scaffolded agents that declare webhook, cron, or file-watch sources
  in their `event-sources.yaml` now actually bind ports / install
  timers / watch directories in-process when the REPL starts, and
  land inbound events in the session event store so
  `declaragent events list` reflects live activity.

  **New file:** `packages/cli/src/run-agent-sources.ts` exports
  `startAgentSources({ configPath, storePath?, onEvent? })`:

  - Validates the yaml via core's existing
    `validateEventSourcesConfig`.
  - Constructs a bus + event store + adapter instances directly (no
    daemon wrapper).
  - Subscribes `*` on the bus → records every emitted event to the
    SQLite store and forwards to the optional `onEvent` hook.
  - Returns `{ started, unknownTypes, validationErrors, stop() }`.
    Each `started[]` entry carries a human summary ("webhook
    /webhook/contracts", "cron 0 9 \* \* \*", "file-watch /tmp/inbox")
    the CLI prints at startup.

  **Integration in `run-agent-cli.ts`:** after `loadAgent`, the verb
  looks for `event-sources.{yaml,yml,json}` at the agent root. When
  present + `--no-sources` isn't set, it calls `startAgentSources`.
  Lifecycle is tied to `renderRepl` — the `finally` block stops every
  source after the REPL exits, no port leaks on Ctrl+D.

  **External-broker sources** (kafka / nats / sqs / amqp / mqtt) are
  surfaced as `unknownTypes` on the result. The REPL prints a hint
  that they're daemon-only; the in-process path intentionally skips
  them.

  **Tests:** +11 new across two files. Full suite: 2071 pass / 0 fail.

  **Not in scope (tracked for PR #3):**

  - Events don't auto-invoke skills yet. Today the bus records them
    - forwards to the REPL's hook; the model sees inbound events via
      `declaragent events list` but doesn't auto-react. Full
      `EventDispatcher` + skill routing lands next.
  - `declaragent daemon` still reads user-global
    `event-sources.json` — unchanged.

## 0.3.4

### Patch Changes

- 826a0bd: Fix `declaragent run` rejecting agents scaffolded by `declaragent init`.

  **The bug:** 0.3.3's agent.yaml zod schema required `model` and
  `systemPrompt`, but `declaragent init --template <name>` emits a
  slim yaml that omits both — they're expected to come from runtime
  defaults (provider-configured model; synthesised system prompt). So
  `declaragent run .` on any freshly-scaffolded agent failed validation
  before it could even start.

  **The fix:**

  - `model` and `systemPrompt` are now optional in the agent.yaml
    schema.
  - When `model` is absent from the yaml, `loadAgent` returns an
    empty string on `spec.model`. `declaragent run`'s CLI layer
    falls back to `--model` > auth-config default > provider preset
    default — same precedence as a plain `declaragent` REPL launch.
  - When `systemPrompt` is absent, `loadAgent` synthesises
    `"You are <name>, a declaragent-authored agent. Help the user.
Use your skills when they apply to the user's request."` —
    good enough to get a new agent talking; users can edit
    agent.yaml to add a real prompt.

  Only `name` remains hard-required.

  **Tests:** +3 cases covering the slim-yaml shape. 2062 pass / 0
  fail.

- Updated dependencies [826a0bd]
  - @declaragent/core@0.2.2

## 0.3.3

### Patch Changes

- c270520: Add `declaragent run <dir>` — load a scaffolded agent + drop into a REPL as that agent.

  Closes the biggest usability gap: until 0.3.3, a user could scaffold
  an agent via the builder conversationally, land the files on disk,
  and then have no first-class way to _run_ that agent. The only
  workaround was telling the builder-REPL to read the skill file and
  apply it as text — exposing the wrong mental model + the wrong
  persona.

  **`@declaragent/core`**

  - New `agents/load-agent.ts`: - `loadAgent({ agentDir })` — parses `agent.yaml` against a Zod
    schema (name / model / systemPrompt required; temperature /
    maxTokens / subagentDepthCap / skills / tools.defaults
    optional; `passthrough()` so channels / sources / plugin refs
    don't trip validation yet). - Walks `<agentDir>/skills/*.md` via the existing `loadSkills`. - Returns `{ spec: AgentSpec, skills, toolNames, agentDir,
agentYamlPath, skillConflicts }`. - `AgentConfigError` for typed failure surfaces.
  - New `composeSystemPromptWithSkills(basePrompt, skills)` —
    appends skill bodies into the prompt under an `# Available
skills` section. Simplest way to let a runtime agent _use_ its
    skills without waiting for the core skill-invocation channel
    to mature.

  **`@declaragent/cli`**

  - New `src/run-agent-cli.ts` exporting `runAgent(args, deps)`.
  - New `run` subcommand wired in `src/index.tsx`:
    - `declaragent run [<dir>]` (default `.`).
    - Respects `--model` and `--mode`.
    - Accepts `--no-sources` for forward-compat; PR #1 is skill-
      only regardless. Source-wiring lands in PR #2 once the
      daemon's per-agent model (backlog #15) is ready.
  - `src/app.tsx` — `App` accepts an optional `agentSpec` prop.
    When supplied, it overrides the builder-REPL persona used by
    every `store.create()` call (initial session, `/clear` reset,
    `createChildSession`). The builder persona remains the default
    for plain `declaragent` (no verb).

  **Tests:**

  - `load-agent.test.ts` — 9 cases covering valid load, missing
    agent.yaml, malformed yaml, schema violations, passthrough
    keys, skill-frontmatter errors, relative-path resolution, and
    empty tool defaults.
  - `run-agent-cli.test.ts` — 7 cases covering happy path, missing
    directory, missing agent.yaml, injected renderRepl (verifies
    composed system prompt), `--no-sources` semantics, sources-
    not-wired hint, and default-to-cwd behaviour.

  **Not in scope this patch:**

  - No `event-sources.yaml` wiring (declared + validated; not yet
    routed to the REPL session). Tracked as backlog #15.
  - No tool-name → `Tool` object resolution (each tool name today
    is just read from yaml and surfaced to the caller; core + CLI
    keep their own tool registries). Tracked as a follow-up.
  - No `fleet run` engine integration (backlog #16) — separate
    work.

  **Next ship:** PR #2 adds `event-sources.yaml` loading to the `run`
  verb so `declaragent run <dir>` registers the scaffolded agent's
  webhook / file-watch sources in-process and dispatches real events
  to the session.

- Updated dependencies [c270520]
  - @declaragent/core@0.2.1

## 0.3.2

### Patch Changes

- 38878e9: Fix REPL hangs when the agent-builder's propose flow blocks on user input.

  `DeclaraProposeChange.execute` intentionally awaits the user's
  `/yes` / `/no` / `/edit` via a Promise the proposal registry
  resolves — but the REPL's render path was unmounting the
  `TextInput` whenever `busy === true`, leaving no way to type the
  confirming slash command. The only escape was a double Ctrl+C
  exit; users lost the proposal and any in-progress work.

  **Render path** (`packages/cli/src/app.tsx`)

  - `TextInput` is now always mounted unless a model-picker or
    permission prompt is claiming exclusive focus.
  - When `busy`, a "…working… (Ctrl+C to abort)" status line
    renders above the input box + the border turns yellow, so the
    user sees the engine is still running but can still type.
  - Slash-suggestion + history-navigation `useInput` handlers no
    longer gate on `!busy`, so Up/Down + tab-complete work during
    a turn.

  **Ctrl+C abort** — first press now has three behaviours:

  1. Turn in flight → abort via an `AbortController` wired through
     `engine.runAgent({ abortSignal })`. The `DeclaraProposeChange`
     tool's `raceWithAbort` rejects the pending proposal so the
     engine unwinds cleanly + `busy` clears.
  2. Pending proposal with no live turn (edge case) → reject it.
  3. Nothing to abort → warn; second press within 2s exits as
     before.

  **Unmount cleanup** — the registry-listener useEffect now
  rejects any dangling pending proposals on component unmount so
  closing the REPL doesn't leak a listener or a half-resolved
  Promise.

  No API changes; patch bump.

## 0.3.0

### Minor Changes

- f374273: Agent-builder toolkit (phases 1–6 of `docs/BUILDER_PLAN.md`).

  The REPL ships an in-process builder: schema-validated, scope-
  confined, audit-tracked tools that let the user author agents + fleets
  through conversation instead of hand-rolled YAML. Every multi-file
  change flows through a propose → confirm → apply loop; rollback runs
  off a git HEAD captured before each apply.

  Loaded only when `DECLARAGENT_BUILDER=on` — production agents shipped
  as dependencies never see the toolkit.

  **Toolkit** (11 tools under `packages/cli/src/builder/`)

  - Authoring — `DeclaraAddSkill`, `DeclaraAddSecret`,
    `DeclaraFleetAdd`, `DeclaraAddPeer`, `DeclaraAuthPlaybook`.
  - Plan/apply — `DeclaraProposeChange` (awaits the user's
    `/yes`/`/no`/`/edit` + returns the resolved steps),
    `DeclaraApplyChange` (captures git HEAD, dispatches per step,
    emits audit records, marks the proposal applied with rollback
    metadata on the registry).
  - Read-only inspection — `DeclaraEventsTail`, `DeclaraFleetStatus`,
    `DeclaraAuditVerify`, `DeclaraDlqShow`.

  **Slash commands** (`src/slash-commands.ts`)

  - `/plan <description>` — ask the builder to propose. Empty-arg form
    stays as the `/mode plan` alias.
  - `/yes [<phrase>]`, `/no`, `/edit <n> <replacement>` — drive the
    proposal state machine.
  - `/diff [<path>]`, `/scope` — surface git + scope context inline.
  - `/fleet graph [mermaid|dot|json]` — inline peer-graph renderer.
  - `/undo` — revert the last apply via scoped `git checkout`.
  - `/history [<limit>]` — render recent builder actions from the
    audit chain.

  **Safety** (phases 2 + 6)

  - Pre-turn secret-leak redactor — 7 pattern detectors run before
    every user message. The original value is discarded; model only
    ever sees `<redacted:label>` markers.
  - `DeclaraAddSecret` never accepts a value — derives a placeholder
    env-var, appends a commented block to `.env.example`, returns an
    actionable hint.
  - Scope confinement — every file-writing tool checks
    `path.startsWith(scopeRoot + sep)`. Explicit breach requires
    `confirmOutsideScope: true` routed through the proposal flow.
  - Deploy deny floor — `Bash:declaragent deploy*` and
    `Bash:declaragent fleet deploy*` are bottom-of-stack `deny` rules
    in the permission gate. Users flip to `/mode bypass` intentionally.
  - Git-backed undo — `captureHead` + `revertPaths` in
    `src/builder/git.ts`. Non-git trees surface a clear "no git"
    message instead of attempting a homegrown snapshot.

  **Audit**

  Each `DeclaraApplyChange` writes one `tool_call` record per step
  (`tool: 'Declara:<stepKind>'`) plus a summary (`tool:
'DeclaraApplyChange'`), sharing a correlation id. `/history` filters
  the audit sink by the `Declara` tool-name prefix; hash-chain
  verification via `DeclaraAuditVerify` stays green because we append,
  never mutate. (The `builder.*` discriminated kind the plan envisions
  requires a core schema bump; it lands with the next core minor.)

  **Integration**

  - `packages/cli/src/app.tsx` — session-scoped `ProposalRegistry`,
    async-opened SQLite audit sink, extended `SYSTEM_PROMPT` with
    plan-confirm-execute, fleet-heuristic, monitoring, and phase-6
    deploy-gate guidance. Pre-turn `redactSecrets` hook wired in
    `handleSubmit`.
  - `packages/cli/package.json` — adds `zod` + `yaml` as direct deps
    (already transitive via core; listing here makes the manifest
    honest).
  - `packages/cli/src/fleet-add-cli.ts` — `defaultTemplatesDir`
    promoted to an export so `DeclaraFleetAdd` reuses the same walk.

  **Docs**

  - `docs-site/docs/cookbook/build-an-agent.mdx` — end-to-end
    annotated transcript for "Building a PR-review Slack bot through
    conversation."
  - `docs-site/docs/reference/builder.mdx` — tool catalog + slash
    command reference + safety-model summary.
  - Cookbook + reference index pages gain rows linking to the new
    surface.
  - `website/app.js` — hero terminal extended with a 3-line builder
    fragment (propose → `/yes` → apply).

  **Tests**

  +195 tests under `packages/cli/src/builder/` covering every tool, the
  proposal state machine (register, confirm, reject, edit, expire,
  apply, revert), secret-guard patterns + redaction, scope
  confinement (including the `/foo` vs `/foo-bar` prefix bug), git
  helpers, the fleet-add + add-peer surgical YAML append, the propose
  → apply end-to-end flow, and the phase-4 "concierge + pr-reviewer
  fleet" acceptance scenario.

  Baseline `bun test` count at v0.1.8: 1845 pass. After phase 7:
  **2042 pass / 0 fail**.

  **Deferred to v0.3+**

  - `/monitor` bottom-of-screen Ink live-tail — needs daemon-side push
    semantics first (event bus has `.subscribe()` but no push hook
    the REPL can wire into). The four read-only tools cover the
    "check state" need.
  - Multi-step `/undo` stacking.
  - Snapshot fallback for non-git projects.
  - Core-side `builder.*` audit-record discriminator.
  - `runCommand` step runner — deploys still require `/mode bypass`
    - manual invocation after the plan is confirmed.

  **Next.** Soak + tag `@declaragent/cli@v0.2.0`.

- 4309000: Fleet slice 1 — `declaragent fleet list / validate / capabilities`.

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

- 4309000: Fleet slice 2 — `declaragent init --fleet` + `declaragent fleet add`.

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

- 4309000: Fleet slice 3 — `declaragent fleet run`.

  Single-process multi-agent dev loop. Boots one memory bus + one worker
  per agent, wires each agent's `capabilities.yaml → memory` transport
  onto the shared bus, and dispatches incoming requests to a pluggable
  handler. Inter-agent RPC round-trips in one process — no broker needed.

  ```bash
  declaragent fleet run                 # every agent
  declaragent fleet run --agent pr-reviewer --agent concierge   # subset
  ```

  **`packages/cli/src/fleet-run.ts`**

  - `startFleetDaemon({fleet, bus?, makeHandler?})` — test-driveable
    entry point. Returns a `FleetDaemon` with `agents` (per-worker
    metrics + topics), `bus`, `shutdown()`, `waitForShutdown()`. Partial
    boot failures stop the workers that did start before re-throwing so
    callers don't need cleanup logic in their error paths.
  - `FleetAgentHandler` — per-agent request handler signature. The slice-3
    **defaultHandler** echoes `{ agent, capability, echoed: payload }`
    back to the caller so wiring is observable without an LLM provider.
    Slice 3.5 will plug the engine loop behind `makeHandler`.
  - `fleetRun(args, deps)` — CLI verb. Loads the fleet (with
    `findFleetRoot` discovery), filters to `--agent` subset when
    supplied, prints the ready line, and installs `SIGINT`/`SIGTERM`
    handlers that call `daemon.shutdown()`.

  **Transport scope.** Only `memory` transports are wired in this slice.
  Agents whose `capabilities.yaml` declares a `kafka` / `nats` / `sqs`
  / `amqp` / `mqtt` transport are loaded cleanly (they surface in
  `fleet list` + `fleet capabilities`) but the dev loop silently skips
  them — production fleets wire those via their existing source adapters.

  **CLI integration.** Added `fleet run` verb; help text updated.
  `packages/cli/package.json` adds a `workspace:*` dep on
  `@declaragent/plugin-agent-rpc` for the memory bus + respond hook.

  **Tests.** 10 new tests in `fleet-run.test.ts` covering:

  - per-worker subscription wiring (memory topics + client-only agents).
  - full end-to-end RPC round-trip (concierge → pr-reviewer → response)
    via the actual `RequestAgent` producer tool + a shared bus.
  - `makeHandler` override.
  - handler exception → `HANDLER_ERROR` RPC response.
  - clean shutdown unsubscribes from the bus.
  - CLI verb's error paths (no fleet, empty fleet, no matching `--agent`).

  **Not in scope for slice 3 (tracked for a follow-up):**

  - File-watch hot reload per agent (§9 slice-3 bullet 4).
  - Engine-loop integration — agents respond via the default echo stub.
  - Per-agent `event-sources.yaml` wiring (the broader Phase-3 daemon is
    not yet hosted here; each agent's sources + dispatcher will land
    once `makeHandler` ties into the engine).
  - Non-memory transports.

  **Next.** Slices 4 / 5 / 6 parallelize — `fleet promote`, `fleet deploy`,
  `fleet graph`/`fleet peers`.

- 4309000: Fleet slice 4 — `declaragent fleet promote` + `declaragent fleet demote`.

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

- 4309000: Fleet slice 5 — `declaragent fleet deploy` (rolling + per-agent,
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

  - `--target` override + `--json` + `--rollback`.

  **Next.** Slice 6 — `fleet graph` + `fleet peers [--verify]`.

- 4309000: Fleet slice 6 — `declaragent fleet graph` + `declaragent fleet peers [--verify]`.

  Two read-only verbs that surface the aggregated inter-agent RPC
  topology. Slot into the slice-1 read-only verb family; neither boots a
  daemon.

  ```bash
  declaragent fleet graph                    # mermaid (default)
  declaragent fleet graph --format=dot       # graphviz
  declaragent fleet graph --format=json      # structured edges for CI
  declaragent fleet peers                    # print aggregated rpc-peers.yaml
  declaragent fleet peers --verify           # + reachability check
  declaragent fleet peers --verify --json    # machine-readable report
  ```

  **`packages/cli/src/fleet-graph-cli.ts`**

  - `buildGraph(fleet): GraphModel` — pure, test-friendly transform from a
    `LoadedFleet` into `{ nodes, edges }`. Nodes per agent (plus any
    external peer the fleet talks to), edges from every potential caller
    to each peer target tagged with transport kind + single-capability
    label when the callee declares exactly one.
  - `renderMermaid` / `renderDot` / `renderJson` — format emitters.
    Mermaid edges are color-coded per transport (memory=blue, kafka=red,
    nats=green, sqs=amber, amqp=violet, mqtt=pink) via `linkStyle`.
  - `fleetGraph(args, deps)` — CLI verb. Default format is mermaid.

  **`packages/cli/src/fleet-peers-cli.ts`**

  - `buildPeersReport(fleet, {verify})` — pure transform. Classifies each
    peer + transport as `reachable`, `unreachable`, `external`, or
    `not-yet-probed`. Memory peers verify by checking that the named
    agent declares matching capabilities on the expected topic;
    non-memory peers are deferred to a follow-up slice with live broker
    wiring. External peers are informational only.
  - `fleetPeers(args, deps)` — CLI verb. Prints grouped sections
    (reachable / not-yet-probed / unreachable / external). `--verify`
    makes the verb exit non-zero on any in-fleet peer that fails to
    resolve (dangling id or missing matching memory transport). `--json`
    emits a machine-readable report keyed the same way.

  **Tests.** 19 new tests across `fleet-graph-cli.test.ts` and
  `fleet-peers-cli.test.ts` covering `buildGraph` shape, mermaid / dot /
  json emitter well-formedness, verb exit codes, `--verify` behavior on
  dangling vs external peers, and `--json` parse shape.

  **Not in scope for slice 6.** Live broker probing (kafka, nats, sqs,
  amqp, mqtt) — slice 7 extends `fleet peers --verify` once broker
  adapters ship. Caller annotations on peers are still the slice-6
  approximation: every in-fleet agent is a potential caller of any peer
  target. A later slice replaces the approximation with explicit caller
  manifests once `capabilities.yaml` grows a `calls:` block.

  **Next.** Slice 7 all-or-nothing deploys + version-skew wiring.

- 4309000: Fleet slice 7 — all-or-nothing deploy polish + version-skew wiring.

  Closes the RPC + deploy loop for FLEET_PLAN.md §8.2 / §8.3 / §14.8 —
  fleets can now detect and optionally reject callers running an older
  code version than the receiver will accept.

  **`@declaragent/core`**

  New module `packages/core/src/fleet/version-skew.ts`:

  - `FLEET_VERSION_HEADER` — constant `'x-fleet-version'`.
  - `FLEET_VERSION_ENV` — constant `'DECLARAGENT_FLEET_VERSION'`.
  - `parseFleetVersion(raw)` → parses `vMAJOR.MINOR.PATCH-sha` or
    returns undefined.
  - `compareFleetVersions(a, b)` → `-1 | 0 | 1` over `(major, minor, patch)`
    (sha is informational and ignored — a rolling deploy mid-flip doesn't
    spuriously register skew).
  - `stampFleetVersionHeader(envelope, version)` — non-mutating clone that
    adds `x-fleet-version` to `headers`.
  - `readFleetVersionHeader(envelope)` — extractor.
  - `checkFleetVersionSkew({callerVersion, selfVersion, minFleetVersion?})`
    → `{status: 'match' | 'older-caller' | 'newer-caller' | 'rejected' | 'unknown', caller?, self?, message?}`.
    `minFleetVersion` is a hard gate: caller below it returns `rejected`
    regardless of self's version.
  - `injectFleetVersionEnv(env, version)` / `readFleetVersionFromEnv(env)`
    — env-var helpers for deploy adapters.

  Also: `RPC_ERROR_CODES.VERSION_SKEW = 'EVERSION_SKEW'` — the code
  receivers return when rejecting a too-old caller (§14.8).

  **`@declaragent/plugin-agent-rpc`**

  - `createRequestAgentTool({...fleetVersion?})` — new **opt-in** option.
    When supplied, every outbound request envelope carries
    `headers: { 'x-fleet-version': <value> }`. Omit to leave envelopes
    unstamped (the default — §14.8 says the stamp is opt-in per
    `fleet.yaml → rpc.stampFleetVersion: true`).

  **`@declaragent/cli`**

  - `startFleetDaemon({...selfFleetVersion?})` — new option lets tests
    inject the receiver's version without touching ambient env.
    Production callers let it default to
    `readFleetVersionFromEnv(process.env)`.
  - `fleet-run` workers now consult `fleet.manifest.rpc.minFleetVersion`
    - the caller's `x-fleet-version` header on every request:
    * `match` / `older-caller` / `unknown` → proceed silently.
    * `newer-caller` → process the request + increment `versionSkewNewer`
      - log `fleet.version.skew agent=… caller=… self=…`.
    * `rejected` → respond with `{ok: false, error: {code: 'EVERSION_SKEW'}}`
      - increment `versionRejected` + log `fleet.version.skew.reject`.
  - `FleetAgentWorkerMetrics` gains `versionRejected` + `versionSkewNewer`.
  - `fleet-deploy-cli.DeployContext` gains `injectedEnv:
Record<string, string>` containing `DECLARAGENT_FLEET_VERSION` (§8.2).
    The in-memory deploy target records the env map per agent on
    `envForAgent` so tests can assert the contract.

  **Out of scope for slice 7 (noted):** `fleet status --history` already
  lists deploy records (slice 5); a Prometheus `fleet.version.skew`
  histogram is a follow-up — slice 7 emits the signal via the stdio
  logger until the metrics registry wire-up lands.

  **Tests.** 27 new: 23 `version-skew.test.ts` units (parse/compare/stamp/
  read/check/env), 3 `fleet-run.test.ts` integration (reject older,
  accept newer with metric, unstamped passes through), 1 `fleet-deploy-
cli.test.ts` assertion that `DECLARAGENT_FLEET_VERSION` flows into
  adapter env.

  **Next.** Slice 8 — `fleet status` + live health.

- 4309000: Fleet slice 8 — `declaragent fleet status`.

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

- 4309000: Phase 7 slice 0.3: `declaragent tenants / audit / secrets` CLI verbs.

  Third of the Phase-6 carry-over PRs. The multi-tenant + audit + secrets
  primitives are now driveable from a terminal without writing a script.
  Every verb ships a `--json` flag for scripted workflows.

  **`declaragent tenants …`**

  - `list [--json]` — summary of every tenant declared in `tenants.yaml`
    (strategy + id + displayName + residency + quota count).
  - `show <id> [--json]` — full context for one tenant: quotas, labels,
    extension allow/deny, secret scopes.
  - `diff [--json]` — parses the local config and reports the tenants that
    would be loaded. Live-vs-disk drift surfacing needs a daemon
    control-plane method and is tracked for slice 0.5.

  **`declaragent audit …`**

  - `query [--tenant X] [--kind Y] [--since ms] [--until ms] [--limit N]
[--json]` — runs `TenantAuditSink.query` against the default sqlite
    sink at `${configDir}/audit.db`.
  - `verify [--tenant X] [--json]` — runs chain-verify; exit 0 on
    `ok: true`, 1 on violations (with the first 10 violation messages on
    stderr).
  - `erase --user <platformUserId> [--reason R] [--json]` — wraps
    `erasePlatformUser`. Prints the tombstone count.
  - `prune --tenant <id> --retention-days <N> [--json]` — wraps
    `TenantAuditSink.prune`.

  **`declaragent secrets …`**

  - `list [--provider <name>] [--json]` — prints providers declared in
    `secrets.yaml`. Enumerating individual refs per provider needs a
    provider-surface change and is tracked for slice 0.5.
  - `describe <ref> [--json]` — splits the ref into `(provider, path)`,
    calls `provider.metadata()` when available, prints version / TTL /
    last-rotated. Providers without metadata support surface a clear
    "not supported" line.
  - `rotate <ref> [--tenant X] [--reason R] [--json]` — verifies provider
    reachability via one `resolve()` call, then writes a `secret_access`
    audit record (`outcome: 'resolved'`). Real rotation stays
    provider-owned (Vault / AWS-SM rotate themselves); the CLI traces the
    moment in the audit chain.

  **Paths**

  - `tenantsConfigPath()` → `${configDir}/tenants.yaml`
  - `secretsConfigPath()` → `${configDir}/secrets.yaml`
  - `auditDbPath()` → `${configDir}/audit.db`

  **Tests**

  - `tenants-cli.test.ts` — 9 tests covering list/show/diff happy paths +
    one error per verb (missing config, unknown id, loader throws).
  - `audit-cli.test.ts` — 8 tests covering query (unfiltered + filtered +
    missing DB), verify (intact chain + violations), erase (channel
    records + sink-open error), and prune (retention window).
  - `secrets-cli.test.ts` — 8 tests covering list (human + JSON +
    unknown provider error), describe (metadata + no-metadata +
    unknown provider), and rotate (audit entry + resolve-fail abort).

  **Remaining slice 0:** 0.4 — per-tenant Prometheus `constLabels`
  auto-stamping in the daemon's metrics exporter.

- 4309000: Phase 7 slice 8: config freeze + `declaragent migrate`.

  - **`declaragent migrate` verb** (`packages/cli/src/migrate-cli.ts`).
    Walks pre-v1.0 configs forward. Dry-run by default; `--apply`
    writes. Every migration is idempotent. Covers three surfaces:
    - **`agent.yaml`** — stamps `schemaVersion: 1` when absent; bumps
      `0` / `"0.9"` / legacy pre-v1.0 markers up to `1`. Leaves
      unknown future versions (>= 2) untouched.
    - **`tenants.yaml`** — advises only. When multi-tenant hints
      exist on disk but no `tenants.yaml` is present, prints a
      pointer to `declaragent tenants diff` + hand-authoring.
      Never writes a tenant topology automatically.
    - **`sessions.db`** — read-only pre-flight that confirms the
      Phase-7-slice-0.1 on-open migration will add the `tenant_id`
      column and backfill the default tenant on next daemon/CLI
      open.
  - **Pure transforms** exported from
    `packages/cli/src/migrate-transforms.ts` for reuse + tests:
    `migrateAgentYaml`, `migrateTenantsYaml`, `migrateSessionSchema`.
  - **Frozen surfaces — `@since 1.0.0` JSDoc tags** added to every
    public type the spec pins: `AgentSpec`, `SessionHandle`,
    `SessionLedger`, `TurnStatus`, `ToolContext`, `Tool`,
    `PendingToolCall`, `CompletedToolCall`, `ToolError`, `ToolEvent`,
    `TenantContext`, `TenantQuotas`, `TenantResidency`,
    `AgentEvent`, `AgentEventMeta`, `EventKind`,
    `SourceDependencies`, `EventSourceAdapter`, `ChannelAdapter`,
    `ChannelDependencies`, `TenantAuditRecord`,
    `TenantAuditRecordKind`, `TenantAuditSink`, `PluginManifest`.
  - **Conformance test**
    (`packages/core/src/conformance.test.ts`). Minimal-surface
    fixtures assert `satisfies ChannelAdapter<unknown>` /
    `EventSourceAdapter<unknown>` — a new required field on either
    contract refuses to compile.
  - **`docs/VERSIONING.md`** documents the v1.0 stability contract
    and the release cadence.

### Patch Changes

- 4309000: Fleet slice 10 — docs-site `reference/fleet` + `cookbook/fleet-starter`.

  First public documentation of the v1.2 fleet surface. Two new pages
  wired into the sidebar + linked from the reference + cookbook indices.

  **`docs-site/docs/reference/fleet.mdx`**

  - When to use a fleet vs keep the single-agent layout.
  - Directory layout + promote/demote invariant.
  - Full `fleet.yaml` v1 schema with per-section field tables
    (top-level, agent entry, environments, deploy strategies).
  - Config precedence order (per-agent → env override → fleet-root →
    defaults).
  - Every CLI verb in one table (new / add / promote / demote / run /
    deploy / list / validate / capabilities / graph / peers / status).
  - Promote + demote walkthrough, "when NOT to promote", and the risks
    the flow flags (CI workflow paths, Dockerfiles, published npm).
  - Version skew decision matrix (match / older / newer / rejected)
    with the `EVERSION_SKEW` error code.
  - The ten §14 design decisions as a lookup table.
  - Mermaid sequence diagram for the rolling deploy health-gate +
    rollback flow.

  **`docs-site/docs/cookbook/fleet-starter.mdx`**

  - End-to-end walkthrough of the `templates/fleet-starter/` template
    (scaffold → validate → explore → run → deploy → day-two ops).
  - Single-process dev loop via `fleet run`.
  - Cross-process swap to Kafka (memory → kafka in `rpc-peers.yaml` +
    `capabilities.yaml`).
  - Opt-in version-skew wiring.
  - Cost estimate table per agent + deployed.

  **Sidebar + index wiring**

  - `sidebars.ts` — `reference/fleet` added after `reference/rpc`;
    `cookbook/fleet-starter` added to the Templates sub-category.
  - `reference/index.mdx` gains a table row linking to the new page.
  - `cookbook/index.mdx` gains a table row for `fleet-starter`.

  **Verification.** `cd docs-site && bun run build` — static build
  completes cleanly; no new warnings beyond the pre-existing
  `vscode-languageserver-types` notice that ships with Docusaurus.

  **Next.** Slice 11 — soak + release candidate.

- 4309000: Fleet slice 9 — `templates/fleet-starter/` + verifier recursion.

  First fleet template ships the full §9 reference: a two-agent fleet
  pairing **concierge** (RPC producer, Haiku 4.5) with **pr-reviewer**
  (RPC consumer, Sonnet 4.6). Completes FLEET_PLAN.md §16 acceptance
  check #1 for the `fleet new` + `fleet add` bootstrap loop — the
  `--template fleet-starter` path now produces a working fleet without a
  single further edit.

  **New under `templates/fleet-starter/`**

  ```
  fleet.yaml               # 2 agents + shared env + rolling deploy + optional RPC knobs
  package.json             # bun workspaces + fleet:* scripts + core/plugin-agent-rpc pins
  rpc-peers.yaml           # fleet-level peer table (memory default, kafka commented)
  .env.example             # ANTHROPIC_API_KEY + KAFKA_BROKERS (opt)
  .gitignore
  README.md                # dev + cross-process + deploy + cost sections
  agents/concierge/        # agent.yaml + event-sources.yaml + skills/delegate.md
  agents/pr-reviewer/      # agent.yaml + capabilities.yaml + event-sources.yaml + skills/review-pr.md
  ```

  **`scripts/verify-templates.ts` extension**

  - Detects a fleet template by presence of a top-level `fleet.yaml`.
  - Parses the manifest, walks every `agents[].path` as a nested
    single-agent template (`verifyAgentDirectory(nestedInFleet: true)`).
  - Threads the fleet-root `.env.example` keys through so fleet members
    don't need their own `.env.example` / `README.md`.
  - Enforces the §14.4 invariant (`fleet.yaml → agents[].id ==
agent.yaml.name`) as a verification failure, not a runtime surprise.

  `bun run scripts/verify-templates.ts` now verifies 8 templates (was 7).

  **Tests.** 3 integration tests in `fleet-starter-template.test.ts`:
  shape assertions, `loadFleet` + `aggregateCapabilities` round-trip
  against a tmpdir copy of the template, and a full `startFleetDaemon`
  RPC round-trip (concierge → pr-reviewer → response).

  **Next.** Slice 10 — docs-site `docs/reference/fleet.mdx` +
  `cookbook/fleet.mdx`.

- 4309000: Phase 7 slice 2: `curl`-bash installer.

  `declaragent` now ships a one-command install path. Ops teams can run
  `curl -sSL https://get.declaragent.dev | sh` on a clean laptop and
  land a working binary in under two minutes.

  - **`scripts/install.sh`**. Portable `/bin/sh` installer. Detects OS

    - arch (`linux-{x64,arm64}` / `darwin-{x64,arm64}`), fetches the
      tarball + `.sha256` from GitHub releases, verifies the hash, and
      extracts into `$HOME/.local/bin/declaragent` (override via
      `DECLARAGENT_PREFIX`). Environment knobs:

    * `DECLARAGENT_VERSION` — pin to a tag (default `latest`).
    * `DECLARAGENT_PREFIX` — install prefix (default `$HOME/.local`).
    * `DECLARAGENT_BASE_URL` — release base URL (used by the CI smoke
      test; defaults to the GitHub release origin).
    * `DECLARAGENT_NO_CHECKSUM` — explicit escape hatch, never advised.
    * `HTTPS_PROXY` — honored transparently via `curl` / `wget`.
      Exits non-zero on checksum mismatch (`1`), unsupported OS/arch
      (`2`), or any download / extraction failure (`1`).
      macOS 14+'s `com.apple.provenance` xattr (Gatekeeper kill) is
      stripped at install time so the extracted binary runs immediately
      until the slice-1.5 notarization pipeline lands.

  - **`declaragent --version` / `-v`**. New CLI flag that prints
    `declaragent <version>` + exits 0. Reuses the existing
    `@declaragent/core` `VERSION` constant — both packages version in
    lockstep via changesets, so the source of truth stays single.

  - **`.github/workflows/installer-smoke.yml`**. Three jobs:
    - `shellcheck` — lints `install.sh` (`-s sh`) and `build-binary.sh`
      (`-s bash`). Catches bashisms sneaking into the POSIX script.
    - `install` — hermetic end-to-end: builds a `linux-x64` tarball via
      `scripts/build-binary.sh`, serves it with a local
      `python3 -m http.server`, runs `install.sh` against it, and
      asserts `declaragent --version` prints `declaragent X.Y.Z`.
    - `checksum-mismatch` — corrupts the `.sha256` file and verifies
      `install.sh` refuses to install.

  **Locally validated.** Ran the installer end-to-end against a
  darwin-arm64 tarball served from `python3 -m http.server`:

  - Happy path: download → sha256 verify → extract → install.
    Prints a PATH-export hint when the prefix isn't on `$PATH`.
  - Checksum mismatch: aborts cleanly with non-zero exit + no
    binary written to the prefix.
  - Unsupported arch: exits 2 with the fix hint
    (`Windows users: install via npm`).

  **Still open (slice 1.5 + 3).**

  - macOS binaries are not yet notarized. The `xattr -cr` hack keeps
    slice-2 local installs working on modern macOS; the real fix is
    `codesign` + `notarytool` in the release pipeline.
  - The `declaragent.dev` / `get.declaragent.dev` domain isn't live
    yet. Until then, installers served from the GitHub release origin
    still work via `curl -sSL <raw-install.sh-url> | sh`.

- 4309000: Phase 7 slice 3: npm + Homebrew packaging.

  `@declaragent/cli` now ships via both canonical paths. Users on
  ubuntu / macos-13 / macos-14 can `npm install -g @declaragent/cli`
  (or `brew install declaragent/tap/declaragent`, once the tap repo is
  live) and land the same single-file binary the curl-installer writes.

  - **npm postinstall shim** (`packages/cli/bin/postinstall.js`). Pure
    Node (no deps). Detects `(process.platform, process.arch)` and maps
    to `linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64`,
    mirroring `scripts/install.sh`. Downloads the tarball + `.sha256`
    from the matching GitHub release, verifies the hash, and extracts
    the binary into `bin/declaragent-binary/declaragent` inside the
    installed npm package. Strips the `com.apple.provenance` xattr on
    macOS so Gatekeeper doesn't SIGKILL the binary on first run.

  - **Node launcher** (`packages/cli/bin/declaragent.js`). Registered
    as the `bin` entry. Exec's the downloaded binary, forwarding argv,
    stdio, and env. Prints a one-line recovery hint if the postinstall
    was skipped (e.g. `DECLARAGENT_NO_POSTINSTALL=1` or a sandboxed
    install blocked the network).

  - **Opt-outs** (documented in `packages/cli/bin/README.md`):

    - `DECLARAGENT_NO_POSTINSTALL=1` — skip the download; `npm install`
      still succeeds so air-gapped installs can bring their own binary.
    - `DECLARAGENT_BASE_URL=<url>` — override the release origin.
      Accepts `file://<dir>` for mirrors + the CI smoke test.
    - `DECLARAGENT_VERSION=vX.Y.Z` — pin a specific tag.
    - Windows: prints a "run under WSL2" hint and exits 0 (never fails
      `npm install`).

  - **Homebrew formula stamper** (`scripts/stamp-homebrew-formula.sh`).
    POSIX `/bin/sh`, `shellcheck -s sh` clean, idempotent. Takes
    `--version` + the four per-target SHA-256 flags, validates each
    hash is a 64-char hex digest, and writes a stamped copy of
    `homebrew-tap/Formula/declaragent.rb`. Uses `awk` (not `sed`) for
    the literal `{{TOKEN}}` swap to dodge BSD/GNU delimiter quirks.

  - **`release-binaries.yml` stamp-homebrew job**. New tail job on the
    tag-triggered pipeline: downloads the SHA-256 artifacts, extracts
    the first-column hash from each, calls the stamper, validates the
    output with `ruby -c`, and uploads the stamped formula as a
    `homebrew-formula` artifact. The PR-open step against
    `declaragent/homebrew-tap` is stubbed until that repo + its deploy
    token exist.

  - **`.github/workflows/npm-install-smoke.yml`**. Two jobs:
    - `npm-install` — matrix on ubuntu-latest / macos-13 / macos-14.
      Each runner compiles its own target via `build-binary.sh`,
      stages a release-layout tree, `npm pack`s the CLI, sets
      `DECLARAGENT_BASE_URL=file://<stage>`, `npm install -g`s the
      tarball, and asserts `declaragent --version` prints
      `declaragent X.Y.Z`. Uses a user-writable `npm config set prefix`
      to avoid `sudo`.
    - `stamp-formula` — runs shellcheck + the stamper against fixture
      hashes, asserts no `{{...}}` placeholders remain, `ruby -c`s the
      output, and re-runs the stamper to verify byte-for-byte idempotency.

  **Notes.**

  - `packages/cli/package.json` now pinpoints `"bin": { "declaragent":
"./bin/declaragent.js" }` instead of `./dist/index.js`. The old
    entry point is still valid for the `bun run dev` path; `dist/` is
    still published in `files` for programmatic importers.
  - Locally validated `bun run typecheck`, `bun test`, `bun run lint`,
    `bun run build`, `/bin/sh -n scripts/stamp-homebrew-formula.sh`,
    and `npm pack --dry-run` (confirmed `bin/postinstall.js` +
    `bin/declaragent.js` are included, 1520 existing tests still pass).

- 4309000: Phase 7 slice 4: `declaragent init` wizard.

  First-run flow built on the existing Ink + `ink-text-input` stack. Walks the
  user through telemetry opt-out → provider pick → (optional) tenant id →
  template pick → config write → verify in under three minutes. Targets `./`
  by default, `-o <dir>` for an explicit path, `--force` to overwrite an
  existing `agent.yaml`, `--multi-tenant` to scaffold `tenants.yaml` alongside.

  - **`packages/cli/src/init-wizard.tsx`** — orchestrator + Ink components.
    Exports `runInit(options, deps?)` that returns `0 | 1` so the top-level
    `index.tsx` routes cleanly. When both `--provider` and `--template` are
    passed, runs fully non-interactive. Missing flags without a
    `launchInteractive` dep exit 1 with a fix hint (the real interactive
    launcher lands when the Ink flow is wired end-to-end — the orchestrator
    already accepts it via DI).

  - **`packages/cli/src/init-template-unpacker.ts`** — pure
    `unpackTemplate(opts, fs)` that writes `agent.yaml` + `.env.example` +
    `README.md` (and `tenants.yaml` when `multiTenant`). Idempotency guard
    checks every target before the first write and aborts unless `force`.
    Template bodies are stubbed; the five template names match the slice-5
    roster (`concierge`, `oncall-escalator`, `pr-review`, `kafka-pipeline`,
    `multi-tenant-starter`). TODO marker points at `templates/<name>/` for
    the real packs.

  - **`packages/cli/src/init-paths.ts`** — `initializedMarkerPath()` +
    `telemetryOptOutPath()` helpers anchored on `configDir()`. The marker
    lands after a successful run; the telemetry opt-out is a pure-file
    sentinel (no network writes — slice 8's job).

  - **`packages/cli/src/index.tsx`** — new `runInitSubcommand` that parses
    `--out / -o`, `--force`, `--multi-tenant`, `--template`, `--provider`,
    `--tenant-id`, `--skip-verify`, and `--help`. Help block grew one line
    under the `secrets` entry.

  - **Verify step.** One `hello` turn against the resolved provider. Anthropic
    routes through `createAnthropicProvider`; every OpenAI-compat preset goes
    through `createOpenAICompatProvider`. Injectable via `deps.verify` or
    `deps.makeVerifyProvider` for tests. Errors are classified: `401` →
    `auth login` hint; network/timeout → `HTTPS_PROXY` hint; else → the
    `--skip-verify` escape.

  - **Tests.** `init-wizard.test.ts` covers the non-interactive path,
    `--force` overwrite guard, `--multi-tenant` toggle, verify success +
    failure paths (injected provider + injected verify hook), and the
    interactive-gate fallback. Uses the same captured-IO + injected-FS
    pattern as `tenants-cli.test.ts` — no Ink is mounted.

  **Not yet landed.**

  - `templates/<name>/` real packs (slice 5's territory).
  - Full interactive Ink orchestration that chains auth → tenant id →
    template pick → verify inside one render; slice 4 ships the Ink
    components + the non-interactive orchestrator and the `launchInteractive`
    DI seam, but the end-to-end chaining needs the auth flows to yield a
    continuation token rather than exiting their Ink instance — tracked for
    a slice 4.5 polish pass.
  - Telemetry upload side of the opt-out sentinel — slice 8.

- 4309000: Phase 7 slices 6 + 8 — CLI dispatch wiring.

  Orchestrator step that follows the three parallel slice agents. Wires
  the `deploy` and `migrate` subcommand routers into
  `packages/cli/src/index.tsx`:

  - `declaragent deploy gcp-cloud-run` — forwards to
    `deployGcpCloudRun` / `verifyGcpCloudRunDeploy` from slice 6's
    `deploy-cli.ts`. Flags: `--out`, `--force`, `--project`, `--region`,
    `--service`, `--agent-yaml`, `--cpu`, `--memory-mib`,
    `--min-instances`, `--verify`, `--json`.
  - `declaragent migrate` — forwards to `migrateConfig` from slice 8's
    `migrate-cli.ts`. Flags: `--config-dir`, `--apply`, `--json`.
  - Help text updated to surface both verbs.
  - Top-level `--help` intercept extended to pass through `init`,
    `deploy`, and `migrate` so each subcommand's own `--help` path fires.

  This changeset only bumps `@declaragent/cli` because neither `deploy`
  nor `migrate` changed any public core export — the runtime surface
  was already frozen by slice 8's `@since 1.0.0` pass.

- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
- Updated dependencies [4309000]
  - @declaragent/core@0.2.0
  - @declaragent/plugin-agent-rpc@1.0.0

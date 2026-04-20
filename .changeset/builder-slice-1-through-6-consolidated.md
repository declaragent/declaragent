---
'@declaragent/cli': minor
---

Agent-builder toolkit (phases 1–6 of `docs/BUILDER_PLAN.md`).

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
  + manual invocation after the plan is confirmed.

**Next.** Soak + tag `@declaragent/cli@v0.2.0`.

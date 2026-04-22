# Post-demo fix backlog

Log of known issues surfaced during the v0.3.x E2E demo walkthrough.
Local-only (the `docs/` dir is gitignored); move items into proper
issues / PRs on the repo when prioritising.

Format: severity · surface · description · proposed fix · status.

---

## Critical (ship next)

### 0. `/yes` / `/no` as a selectable prompt, not typed slash commands
- **Surface:** `packages/cli/src/app.tsx` — proposal-rendered system
  line + `handleSlash`.
- **Symptom:** after a proposal renders, the user has to type `/yes`
  or `/no`. Awkward for a "just confirm the plan" UX; typing slash
  commands on review is a minor friction that compounds when the
  model proposes often.
- **Fix:** render the pending proposal like the existing
  `pendingPrompt` (permission-gate) surface — an inline y/n/e
  selector that consumes the input focus, reads a single keypress,
  dispatches the right slash handler, and releases focus. Reuses
  the `PromptRow` component pattern already in the file.
- **Impl sketch:**
  1. New state `pendingProposal: Proposal | null` subscribed via the
     registry listener; set on `'registered'`, cleared on any
     terminal event.
  2. When non-null, render a proposal-focused box with the plan + a
     `[Y]es / [N]o / [E]dit / [↑↓] pick step` single-keypress input
     instead of the generic TextInput.
  3. `/yes` / `/no` / `/edit` typed commands stay supported as a
     fallback + so the power-user can still use slash muscle memory.
- **Estimate:** half a day (~80 lines in app.tsx, probably 5 new
  tests).

### 1. Multi-line paste broken in REPL
- **Surface:** `ink-text-input` inside `packages/cli/src/app.tsx`
- **Symptom:** pasting a multi-line prompt submits the first line and
  spills the rest into successive turns (or drops them).
- **Root cause:** `ink-text-input` treats every `\n` as an Enter. No
  bracketed-paste detection.
- **Workaround landed in-demo:** tell the user to write the prompt to
  a file, then in the REPL say "please read `/tmp/prompt.txt` and do
  what it says."
- **Proper fix:** implement bracketed paste support.
  1. On REPL mount, write `\x1b[?2004h` to stdout (enables the mode).
  2. In a raw-mode stdin listener (or a wrapper `useInput`), buffer
     any bytes arriving between `\x1b[200~` and `\x1b[201~` into a
     paste buffer; do not propagate the embedded newlines to
     `TextInput`'s `onSubmit`. On `\x1b[201~`, deliver the buffered
     content to `setInput` as a single atomic update.
  3. On unmount, write `\x1b[?2004l` to disable.
  4. Terminals without bracketed-paste support (rare) keep the
     current behaviour.
- **Quick alternative (0.3.3):** add a `/prompt <path>` slash command
  that reads a file + submits its contents as a user message
  verbatim. ~20 lines. Not a substitute for the proper fix but
  unblocks heavy prompts immediately.
- **Estimate:** 1 day for the bracketed-paste version; 30 min for
  the slash-command workaround.

---

## High (next minor)

### 2. CI on `main` has been red for ~15 commits (pre-existing)
- **Surface:** `.github/workflows/ci.yml` typecheck step
- **Symptom:** typecheck fails on `packages/cli/src/whatsapp-templates-cli.ts`,
  `tenants-cli.ts`, `source-adapters-cli.ts`, `source-cli.ts` — all
  complaining `Cannot find module '@declaragent/core'` or
  `'@declaragent/channel-whatsapp'`.
- **Root cause:** combination of (a) `channel-whatsapp` being an
  `optionalDependencies` entry on CLI (not installed in CI's
  default Ubuntu runner for some archs), (b) TS files imported from
  the cli package referencing those workspace deps without the
  corresponding install guaranteed.
- **Proper fix:**
  - Move the whatsapp-specific CLI files behind dynamic imports so
    the typecheck path doesn't require the optional dep.
  - OR add a conditional `ci.yml` step that installs the optional
    deps explicitly.
- **Estimate:** 2–4 hours.

### 3. GitHub Actions can't open PRs
- **Surface:** `.github/workflows/release.yml` changesets/action step
- **Symptom:** every release cycle fails with "HttpError: GitHub
  Actions is not permitted to create or approve pull requests."
  Workflow pushes the `changeset-release/main` branch but the PR
  creation step errors out. Someone has to open the PR manually
  every time.
- **Fix:** repo Settings → Actions → General → enable "Allow GitHub
  Actions to create and approve pull requests." No code change.
- **Owner:** repo admin (can't be done from agent).
- **Estimate:** 30 seconds once someone clicks the toggle.

### 4. Volta skips npm postinstall
- **Surface:** npm install path
- **Symptom:** users on volta (`~/.volta/tools/...`) install the
  package but the binary doesn't land; `declaragent --version`
  errors with "binary not found."
- **Root cause:** volta's default behaviour elides lifecycle scripts
  unless explicitly opted in.
- **Workaround in-demo:** re-run postinstall manually
  (`node <path>/postinstall.js`).
- **Fix:** document volta quirk in the README install section; point
  to `npm install --foreground-scripts` or the manual re-run path.
- **Estimate:** 15 min docs update.

---

## Medium (next minor)

### 5. Step-kind dispatchers: `addSource`, `addChannel`, `addMCP`, `addPlugin`
- **Surface:** `packages/cli/src/builder/apply-change.ts` — the
  switch in `dispatchStep()`.
- **Symptom:** builder tools for these four kinds return `ok: false,
  error: "step kind X is not supported yet in this build."`
- **Fix path:** implement `DeclaraAddSource`, `DeclaraAddChannel`,
  `DeclaraAddMCP`, `DeclaraAddPlugin` tools, wire into the
  dispatcher. Each is ~150 lines + tests.
- **Priority:** `addSource` + `addChannel` first — those unlock the
  "wire a webhook + Slack channel from the builder" demo without
  falling back to templates.
- **Estimate:** 2–3 days for all four.

### 6. Multi-step `/undo`
- **Surface:** `packages/cli/src/builder/proposals.ts` +
  `undo.ts`.
- **Symptom:** `/undo` only reverts the most recent apply. A second
  `/undo` in the same session reports "nothing to undo."
- **Fix:** stack `lastApplied` metadata; `/undo` pops the top and
  reverts; `/undo <N>` reverts N.
- **Estimate:** 1 day.

### 7. `/monitor` Ink live-tail pane
- **Surface:** new work under `packages/cli/src/builder/monitor.tsx`.
- **Why deferred:** the event bus exposes `.subscribe()` + `.recent()`
  but no push semantics into the REPL process. The pane needs
  either polling (error-prone in Ink) or a daemon-side push channel
  (substantial work).
- **Estimate:** 2–3 days once the push channel lands.

---

## Low (backlog / nice-to-have)

### 8. Core-side `builder.*` audit-record kind
- v0.3 reuses `kind: 'tool_call'` with `tool` prefixed `Declara:`.
  Cleaner long-term: add a `BuilderAuditRecord` discriminator in
  `packages/core/src/audit/types.ts` with dedicated fields
  (`gitHeadBefore`, `writes`, `diff`).
- Needs a core-package minor bump.

### 9. Snapshot fallback for non-git trees
- `/undo` requires git. A homegrown snapshot layer for non-git
  workflows is a v0.4+ follow-up per BUILDER_PLAN §13.

### 10. Release workflow consumes the 62 MB compiled binary
- Fixed in `b0af858` via `.gitignore`, but the Release workflow's
  `git add .` step is still indiscriminate. A future hardening
  pass: restrict it to `packages/*/package.json` +
  `packages/*/CHANGELOG.md` only.

### 11. `release-gate.yml`, `deps-scan.yml`, `npm-audit.yml`, `installer-smoke.yml` red
- Pre-existing failures across multiple prior commits. Each fails
  fast (<20s) suggesting env/secret misconfigurations rather than
  real defects. Worth a half-day sweep to audit what each needs.

### 12. Slash-command file-ref expansion (`@<path>`)
- Convention borrowed from Claude Code: `please summarize @README.md`
  pre-reads the file and injects contents inline.
- Would complement `/prompt <path>` and covers the "I want to mention
  a file without the model running `Read`" ergonomic.
- **Estimate:** 30 min.

### 15. Daemon does not load per-agent `event-sources.yaml`
- **Surface:** `packages/cli/src/daemon-cli.ts:22-48` —
  `loadConfiguredSources()` reads a single user-global
  `~/.declaragent/event-sources.json` (JSON, not YAML), not the
  `./event-sources.yaml` that templates like `pr-review` and
  `oncall-escalator` ship. `declaragent events-config validate ./file.yaml`
  accepts the yaml, and `declaragent source add` registers one source
  at a time into the user-global file, but there's no "run the
  daemon against this dir" mode.
- **Symptom:** after scaffolding an agent with a webhook source in
  its `event-sources.yaml`, `declaragent daemon` only binds the
  admin control socket — no webhook listener on 7777, so `curl`
  times out with no response.
- **Also affected:** the `target: {kind: skill, name: X}` event
  target can't resolve an agent context without a live session.
  `declaragent daemon` alone has no concept of "which agent
  should handle this event."
- **Fix options:**
  - **Short-term**: add a `declaragent run <agent-dir>` verb that
    loads `<dir>/agent.yaml` + `<dir>/event-sources.yaml`,
    instantiates the agent in-process, and starts a scoped daemon
    that owns those sources + dispatches to that agent's skills.
    Exactly what someone typing `declaragent run .` would expect.
  - **Long-term**: the daemon's source registry learns to
    associate each source with an `agentRef` pointing at a
    scaffolded dir; `declaragent source add` takes
    `--agent <path>` and the dispatcher resolves targets through
    that link.
- **Estimate:** short-term is ~2 days (glue, not new core). Blocks
  the "drop contract file → see LLM-extracted YAML" demo flow —
  today the only way to exercise a scaffolded skill is via the
  builder-REPL "read + apply" hack.
- **Cross-ref:** related to item #14 (no `declaragent --as-agent`
  REPL). Either solution would validate the other.

### 16. `declaragent fleet run` is an RPC-routing stub, no LLM
- **Surface:** `packages/cli/src/fleet-run.ts:11-17`:
  > "Engine integration (an agent's handler runs a full LLM turn)
  > is out of scope for slice 3 — the default handler returns a
  > typed stub. Slice 3.5 will plug the engine behind `makeHandler`.
  > Hot-reload, file-watch, and per-agent sources from
  > `event-sources.yaml` are tracked for a follow-up."
- **Symptom:** even swapping to `fleet run` doesn't unlock a real
  E2E test; handlers are stubs that don't touch the LLM.
- **Fix:** land slice 3.5. The plumbing exists; the handler
  constructor just needs to instantiate an engine + session + run
  the skill/turn, same as the REPL does.
- **Estimate:** 1–2 days.

### 14. No "run the REPL as this scaffolded agent" entry point
- **Surface:** `packages/cli/src/index.tsx` / app entry.
- **Symptom:** `declaragent` from inside a scaffolded agent dir still
  launches the builder-REPL persona; doesn't load the local
  `agent.yaml` + its skills into the session. Testing a scaffolded
  skill requires either running the daemon + triggering an event, or
  telling the builder-REPL to read the skill file + apply it as
  text — neither is a clean dev-loop.
- **Fix:** `declaragent run <path>` or `declaragent --as <path>`
  loads `<path>/agent.yaml` via core's `loadAgent`, installs its
  skills + tools into a session, and drops into a REPL where the
  loaded agent's system prompt + skill list are live. Identical
  REPL UX; different persona.
- **Secondary benefit:** unblocks skill authoring end-to-end —
  build a skill via the builder, then `declaragent run .` to try
  it without standing up the daemon.
- **Estimate:** 1 day (session spec + loader wiring; tests).

### 13. Homebrew formula auto-bump
- Tap updated for `v0.3.0`; `v0.3.2` patch doesn't trigger an auto
  PR unless the tap's GitHub Action is wired. Check the tap repo's
  workflows after the next release.

---

## Closed during demo

- ✅ TextInput unmounted during `busy` → patched in 0.3.2.
- ✅ Ctrl+C didn't abort the turn → wired `AbortController` in 0.3.2.
- ✅ Build race in CI (testkit/source-sqs couldn't find core) →
  topological build script in `70ed747`.
- ✅ 62MB binary leaked into `changeset-release/main` → gitignored
  in `b0af858`.
- ✅ `v0.2.0` git tag misaligned with npm publishes → retagged to
  `v0.3.0`.

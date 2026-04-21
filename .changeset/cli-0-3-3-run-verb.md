---
'@declaragent/cli': patch
'@declaragent/core': patch
---

Add `declaragent run <dir>` — load a scaffolded agent + drop into a REPL as that agent.

Closes the biggest usability gap: until 0.3.3, a user could scaffold
an agent via the builder conversationally, land the files on disk,
and then have no first-class way to *run* that agent. The only
workaround was telling the builder-REPL to read the skill file and
apply it as text — exposing the wrong mental model + the wrong
persona.

**`@declaragent/core`**

- New `agents/load-agent.ts`:
  - `loadAgent({ agentDir })` — parses `agent.yaml` against a Zod
    schema (name / model / systemPrompt required; temperature /
    maxTokens / subagentDepthCap / skills / tools.defaults
    optional; `passthrough()` so channels / sources / plugin refs
    don't trip validation yet).
  - Walks `<agentDir>/skills/*.md` via the existing `loadSkills`.
  - Returns `{ spec: AgentSpec, skills, toolNames, agentDir,
    agentYamlPath, skillConflicts }`.
  - `AgentConfigError` for typed failure surfaces.
- New `composeSystemPromptWithSkills(basePrompt, skills)` —
  appends skill bodies into the prompt under an `# Available
  skills` section. Simplest way to let a runtime agent *use* its
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

# Agent-Builder — In-REPL Construction Plan

> ⚠️ **Historical design doc — not maintained.** This document predates the shipped
> implementation and is kept for design context only; command names, config shapes,
> versions, and file paths in it may no longer match the code. `docs/SPEC_AND_PLAN.md`
> supersedes it for requirements; for live capability status see `AGENTS.md`, and for
> user-facing behavior see the docs site (`docs-site/`).


**Status:** Phases 1–7 shipped in `@declaragent/cli@0.2.0`. §11 decisions are binding for the v0.2 freeze; revisit only via changeset. Follow-ons tracked in §13 (multi-step undo, snapshot fallback for non-git, `/monitor` live-tail, core-side `builder.*` audit kinds).
**Last updated:** 2026-04-20.
**Phase status:**
- Phase 1 (tool foundation) ✅
- Phase 2 (secret hygiene + auth playbooks) ✅
- Phase 3 (plan-confirm-execute loop) ✅
- Phase 4 (fleet-scale flows) ✅
- Phase 5 (read-only inspection) ✅ — `/monitor` pane deferred (§13)
- Phase 6 (rollback + safety) ✅ — single-step `/undo` in v0.2; stacked undo v0.3
- Phase 7 (docs + launch) ✅

The v0.1.8 REPL ships with a declaragent-builder persona in the system prompt — it already understands the mental model and can Read/Write/Edit/Bash its way to most outcomes. The gap is **durability**: hand-crafted YAML drifts from the Zod schemas, secret tokens pasted into chat can leak into files, channel ownership invariants are easy to violate, and rollback is "hope you had git committed recently."

This plan specifies the **agent-builder toolkit** — a set of schema-validated, audit-tracked, scope-constrained tools the REPL calls on the user's behalf. The user converses; the CLI builds. Same core, same tools, same permission gate as the target agent — just a bigger toolkit for the meta task of *authoring* agents.

The forcing function is the moment a user says *"I want a Slack bot that reviews PRs and DMs me on blockers"* and needs everything — skill file, webhook source, Slack channel wiring, secret placeholders, permission grants, deploy target — to land without either (a) the user typing YAML or (b) the model guessing at schema details.

---

## 1. Goals and non-goals

**Goals.**
- **Five validated builder tools** for the hot paths: skill, source, channel, MCP server, plugin. Each validates inputs against the same Zod schema `@declaragent/core` uses at load time. Version 1 frozen at v0.2.
- **Secret safety.** Real secrets never land in files. A pre-turn leak detector redacts high-entropy tokens from user messages before they reach the model. `DeclaraAddSecret` only takes `ref` + `provider`, never a value.
- **Plan-then-execute.** Every multi-file change flows through `DeclaraProposeChange` → explicit user "yes" → `DeclaraApplyChange`. No silent writes.
- **Git-backed undo.** Every write records `HEAD` before mutating. `/undo` reverts scoped paths. If the working dir isn't a git repo, the builder initializes one (with user confirmation).
- **Scope confinement.** Builder tools default to the current agent / fleet root. Writes outside that root require explicit user confirmation (`confirmOutsideScope: true`).
- **Auditable.** Every builder tool writes a `builder.<action>` audit record so `declaragent audit query --kind builder.*` surfaces the full session history.
- **Fleet-scale flows.** The builder understands fleets — when the user describes two distinct responsibilities, it proposes a fleet + wires peers.
- **Monitoring inside the REPL.** Read-only tools (`DeclaraEventsTail`, `DeclaraFleetStatus`, `DeclaraAuditVerify`, `DeclaraDlqShow`) let the assistant answer "what's happening" questions without leaving the session.
- **Progressive disclosure.** MVP is phases 1–3 (~4 days). Full toolkit is 7 phases (~8 days). Each phase ships independently behind a changeset.

**Non-goals.**
- **No agent.yaml AI-generation from scratch.** The builder uses templates as the short path. Hand-writing a whole agent.yaml is rare; if needed, `Write` + `Edit` still work.
- **No multi-turn editing session primitives.** Users edit in their editor too. The builder doesn't try to be an LSP.
- **No cloud provisioning.** The builder configures declaragent; it doesn't call GCP / AWS / Azure APIs. `declaragent deploy` already does that.
- **No inline skill execution.** The builder authors skills; it doesn't fire them.
- **No Windows-specific pathways.** Same constraint as earlier phases.
- **No prompt-library.** Users bring their own system prompts. The builder doesn't curate a library of skill bodies.
- **No automated git commits.** The builder records `HEAD` for undo but does not commit on the user's behalf. Commits stay user-intentional.

---

## 2. Architecture

```
   user message
        │
        ▼
┌────────────────────────────┐
│  Leak detector (pre-turn)  │ — strips suspected secrets; warns user
└────────┬───────────────────┘
         │
         ▼
┌────────────────────────────┐
│  Engine turn (Claude)      │
│  system prompt: builder    │
│  tools: Read/Write/…/      │
│         + DeclaraAdd*      │
│         + DeclaraPropose   │
│         + DeclaraApply     │
│         + DeclaraEvents*   │
│         + DeclaraFleet*    │
│         + DeclaraAudit*    │
└────────┬───────────────────┘
         │
         ▼ (model picks a tool)
┌────────────────────────────┐
│  Permission gate           │ — unchanged; new per-tool keys
└────────┬───────────────────┘
         │
         ▼
┌────────────────────────────┐
│  Builder tool impl         │
│  1. Validate (Zod)         │
│  2. Scope check            │
│  3. Git snapshot HEAD      │
│  4. Propose → confirm      │
│  5. Write                  │
│  6. Audit record           │
│  7. Return diff            │
└────────┬───────────────────┘
         │
         ▼
   diff rendered in REPL
```

**Key constraints:**
- Builder tools live in `packages/cli/src/builder/` — a net-new subdirectory under the CLI package. They're *only* loaded when the CLI runs as the REPL (not when users install `@declaragent/cli` for production deploys — the REPL is the agent-builder surface).
- Every tool imports the same Zod schemas `@declaragent/core` uses at load time. No reimplementation.
- Scope root is resolved on session startup via `findFleetRoot(cwd) ?? findAgentRoot(cwd) ?? cwd`. Tools refuse writes outside unless `confirmOutsideScope: true` was passed + the user re-confirmed.
- Permission-gate keys are `DeclaraAddSkill:<agentId>/<skillName>`, `DeclaraAddSource:<sourceType>/<id>`, etc. — same shape as existing tool keys so the same modes (default / plan / bypass / auto) apply.

---

## 3. Tool contracts

All tools are registered via the existing `@declaragent/core` extension system.

### 3.1 `DeclaraProposeChange` (no side effects)

```ts
interface DeclaraProposeChangeInput {
  summary: string;             // one-sentence description of the goal
  steps: ReadonlyArray<{
    kind: 'addSkill' | 'addSource' | 'addChannel' | 'addMCP' | 'addPlugin'
        | 'addSecret' | 'editFile' | 'runCommand' | 'addPeer' | 'addAgent';
    description: string;
    preview?: string;          // YAML fragment, command, or diff hunk
  }>;
  requiresExplicitYes?: boolean;  // true for deploy / audit erase / scope breach
}

interface DeclaraProposeChangeOutput {
  proposalId: string;          // UUID; passed to DeclaraApplyChange
  confirmed: boolean;           // set by the user via /yes or /no
}
```

Behavior: renders the plan in the REPL, freezes until the user types `/yes`, `/no`, or `/edit <n> <replacement>`. The call returns once the user responds. The model then either calls `DeclaraApplyChange(proposalId)` or revises.

### 3.2 `DeclaraApplyChange`

```ts
interface DeclaraApplyChangeInput {
  proposalId: string;
}
interface DeclaraApplyChangeOutput {
  ok: boolean;
  results: ReadonlyArray<ToolResult>;  // one per step from the proposal
  gitHeadBefore: string;                // sha for undo
  auditCorrelationId: string;
}
```

Walks the proposal's steps in order. Stops + rolls back on any failure. Writes one `builder.apply` audit record + a `builder.<step.kind>` record per step.

### 3.3 `DeclaraAddSkill`

```ts
interface DeclaraAddSkillInput {
  agentPath?: string;           // defaults to scope root
  name: string;                 // `[a-z0-9][a-z0-9_-]*`
  description: string;
  inputs?: Record<string, SkillInputSpec>;
  outputs?: Record<string, SkillOutputSpec>;
  body: string;                 // Markdown skill body
  addToAgentYaml?: boolean;     // default true
}
```

- Validates frontmatter against the existing skills schema.
- Rejects duplicate names in the same agent.
- Refuses if `body` matches any of the secret patterns (see §5).
- Writes `<agentPath>/skills/<name>.md`.
- If `addToAgentYaml`, edits `<agentPath>/agent.yaml` adding `skills: - skills/<name>.md` (preserves comments + formatting via the slice-2 surgical append pattern).

### 3.4 `DeclaraAddSource`

```ts
interface DeclaraAddSourceInput {
  agentPath?: string;
  type: 'cron' | 'webhook' | 'file-watch' | 'kafka' | 'nats' | 'sqs' | 'amqp' | 'mqtt' | 'agent-inbox';
  id: string;
  config: Record<string, unknown>;
  delivery?: DeliveryConfig;    // at-least-once / at-most-once / exactly-once
  idempotency?: IdempotencyConfig;
  limits?: LimitsConfig;
  envPlaceholders?: ReadonlyArray<string>;   // e.g. ['KAFKA_BROKERS'] — written to .env.example
}
```

- Picks the right source-adapter's Zod schema (one of the registered adapters in core).
- Appends to `event-sources.yaml`.
- For at-least-once sources, forces `idempotency.strategy` to be set.
- Adds `${env:FOO}` placeholders referenced in `config` to `.env.example` if missing.
- Never accepts a secret value inline — only `${env:...}` references.

### 3.5 `DeclaraAddChannel`

```ts
interface DeclaraAddChannelInput {
  agentPath?: string;
  type: 'slack' | 'telegram' | 'discord' | 'whatsapp';
  id: string;
  config: Record<string, unknown>;
  permissions?: ChannelPermissionsConfig;
  owner?: string;               // fleet-level only — the agent id that owns inbound
}
```

- Validates against the channel adapter's schema.
- When in a fleet, enforces exactly one owner per channel per environment (§14.3 fleet plan).
- Adds token placeholders to `.env.example`.
- Never accepts a bot token / webhook secret inline.

### 3.6 `DeclaraAddMCP`

```ts
interface DeclaraAddMCPInput {
  name: string;
  command: string;              // or --url for HTTP transport
  args?: ReadonlyArray<string>;
  protocolVersion?: string;
  permissions?: ReadonlyArray<string>;  // tool-permission keys this MCP requests
}
```

- Wraps `declaragent mcp add` with a **consent summary** rendered through `DeclaraProposeChange` first — the user sees exactly what permissions are being granted before the MCP is wired.
- Rejects MCPs that request `Bash:*` or any wildcard tool without a narrow scope reason field.

### 3.7 `DeclaraAddPlugin`

```ts
interface DeclaraAddPluginInput {
  pkg: string;                  // npm package name (scoped allowed)
  version?: string;             // defaults to latest
}
```

- Wraps `declaragent plugin install <pkg>`.
- Renders the plugin manifest's requested permissions through `DeclaraProposeChange`.
- Uses the existing consent flow from `@declaragent/core/src/plugins/`.

### 3.8 `DeclaraAddSecret`

```ts
interface DeclaraAddSecretInput {
  ref: string;                  // e.g. 'vault:kv/acme/gh-token'
  provider: 'env' | 'vault' | 'aws-sm' | 'gcp-sm' | 'k8s';
  usedBy?: string;              // which tool/source/channel consumes it
  tenantScope?: string;         // multi-tenant: restrict to this tenant
}
interface DeclaraAddSecretOutput {
  ok: boolean;
  hint: string;                 // "Paste the value into .env as DECLARA_ACME_GH_TOKEN=…"
}
```

**Never accepts a value.** Always returns an actionable hint. Writes a ref to `secrets.yaml` + a placeholder to `.env.example`. Caller (REPL) surfaces the hint as a system line the user sees next.

### 3.9 `DeclaraFleetAdd`

```ts
interface DeclaraFleetAddInput {
  template: string;             // rpc-client, rpc-server, etc.
  id: string;
  force?: boolean;
}
```

Wraps slice-2's `addAgentFromTemplate`. Exists as a tool (vs. having the model shell out) so the result is typed + the diff is uniform with other builder tool outputs.

### 3.10 `DeclaraAddPeer`

```ts
interface DeclaraAddPeerInput {
  agent: string;                // e.g. 'agent://pr-reviewer'
  transport: PeerTransport;     // same shape as rpc-peers.yaml
}
```

Appends to `rpc-peers.yaml`, preserves comments, validates against the slice-0 `peersConfigSchema`.

### 3.11 Read-only inspection tools (Phase 5)

```ts
DeclaraEventsTail({ last?: number; correlationId?: string; }): { events: AgentEvent[] }
DeclaraFleetStatus({ history?: boolean }): FleetStatusReport  // reuses slice-8 report
DeclaraAuditVerify({ tenant?: string }): VerifyReport
DeclaraDlqShow({ sourceId: string; limit?: number }): DLQEntry[]
```

No side effects. Each wraps the existing CLI verb so the model can answer "what's happening" questions without shelling out.

---

## 4. Slash commands

Extend `slash-commands.ts`:

| Command | Behavior |
| --- | --- |
| `/plan <description>` | Asks the builder to produce a plan via `DeclaraProposeChange` without executing. Useful for review. |
| `/yes` | Confirms the pending proposal. |
| `/no` | Rejects the pending proposal. |
| `/edit <n> <replacement>` | Replaces step `n` of the pending proposal with the text. |
| `/diff [<path>]` | Shows `git diff` for the agent scope root (or a specific path). |
| `/undo` | Reverts the last applied change via `git checkout HEAD~1 -- <scoped-paths>`. Scoped to paths modified by the last `DeclaraApplyChange`. |
| `/monitor` | Opens a live-tail pane for events + status. Press `esc` to exit. |
| `/scope` | Prints the current scope root + offers to widen via confirmation. |

---

## 5. Safety model

### 5.1 Secret leak detection (pre-turn)

Runs before every user message reaches the model:

```ts
const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bsk-(live|proj|ant)-[A-Za-z0-9_-]{20,}\b/, label: 'likely API key' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/,                  label: 'GitHub PAT' },
  { re: /\bgho_[A-Za-z0-9]{30,}\b/,                  label: 'GitHub OAuth token' },
  { re: /\bnpm_[A-Za-z0-9]{30,}\b/,                  label: 'npm token' },
  { re: /\bxox[bpoasr]-[A-Za-z0-9-]{20,}\b/,         label: 'Slack token' },
  { re: /\bAKIA[A-Z0-9]{16}\b/,                      label: 'AWS access key id' },
  { re: /\bey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/, label: 'JWT' },
];
```

Each match is redacted to `<redacted:label>` before the message lands in the transcript. A system line tells the user *"secret pattern detected — never paste credentials, use $(env:VAR) refs."* The original value is not stored anywhere in the session; not saved to SQLite, not sent to the model, not logged.

### 5.2 Scope confinement

Scope root resolved on session startup:

```
scopeRoot = findFleetRoot(cwd) ?? findAgentRoot(cwd) ?? cwd
```

Every file-writing tool validates:

```
if (!path.startsWith(scopeRoot + path.sep) && !options.confirmOutsideScope) {
  throw new BuilderScopeError(
    `path ${path} is outside scope ${scopeRoot}. ` +
    `Re-invoke with confirmOutsideScope: true (which also triggers a user confirmation).`,
  );
}
```

When `confirmOutsideScope: true` is passed, the tool still routes through `DeclaraProposeChange` with `requiresExplicitYes: true` so the user sees the path before the write.

### 5.3 Git-backed undo

**Assumption: git is available and the working tree lives in a git repo.** If not:

1. On first builder tool invocation, detect missing `.git/`.
2. `DeclaraProposeChange` fires with a single `initGit` step explaining that the builder needs git for undo.
3. User `/yes` → `git init -b main && git add -A && git commit -m "declaragent: initial snapshot before builder actions"`.
4. If user `/no` → builder refuses to proceed with any file-writing tool. Read-only tools still work.

Before every `DeclaraApplyChange`:

```
gitHeadBefore := git rev-parse HEAD
```

Stored on the proposal. `/undo` runs:

```
git checkout <gitHeadBefore> -- <scoped-paths-from-proposal>
```

Scoped — never touches unrelated files. If the user committed mid-session, `/undo` can only revert back to that commit.

### 5.4 Destructive-op gates

Certain operations require explicit confirmation regardless of permission mode:

| Operation | Gate |
| --- | --- |
| `declaragent deploy` (any kind) | `DeclaraProposeChange` with `requiresExplicitYes: true`. User types `/yes deploy` (exact match, to prevent habituation). |
| `audit erase --user` | Same + user types the reason as a second confirmation field. |
| Scope breach (writing outside scope root) | Same. |
| Git `--force` operations (push -f, reset --hard) | Builder never performs these. Full stop. |

---

## 6. Telemetry + audit

Every builder tool writes an audit record. New kind: `builder.<action>`. Shape:

```ts
interface BuilderAuditRecord {
  kind: `builder.${string}`;        // e.g. 'builder.addSkill'
  timestamp: string;
  sessionId: string;
  correlationId: string;
  tenantId?: string;
  input: Record<string, unknown>;    // redacted — no secret fields
  output: { ok: boolean; writes: string[]; diff?: string };
  gitHeadBefore?: string;
  gitHeadAfter?: string;
}
```

Queryable via:

```bash
declaragent audit query --kind 'builder.*' --since <ts> --json
declaragent audit verify                    # chain still covers builder actions
```

Enables a later UX: `/history` slash command showing the builder's action log in the REPL.

---

## 7. Phase breakdown

### Phase 1 — Builder tool foundation (~2 days)

Deliverables:
- `packages/cli/src/builder/` directory
  - `types.ts` — tool input/output interfaces, Zod schemas
  - `scope.ts` — scope-root resolution, path confinement
  - `git.ts` — HEAD capture, undo helpers, init-git prompt
  - `add-skill.ts`, `add-source.ts`, `add-channel.ts`, `add-mcp.ts`, `add-plugin.ts`
  - `register.ts` — registers all builder tools with the engine extension registry
  - `index.ts` — re-exports
- Each tool: unit tests against tmpdir fixtures
- Integration test: scaffold a fresh agent → run each tool via the engine → validate resulting agent.yaml + related files via `@declaragent/core/loadAgent`

Test target: **40+ new tests**.

Critical path for phases 2–7.

### Phase 2 — Secret hygiene + auth (~1 day)

Deliverables:
- `packages/cli/src/builder/secret-guard.ts` — leak detection patterns + `redactSecrets(text)` helper
- Pre-turn hook wired in `app.tsx` — runs on every user message before `runUserMessage`
- `DeclaraAddSecret` tool (no-value variant)
- Skills bundle `packages/cli/src/builder/auth-playbooks/` — one Markdown file per supported provider (slack, github, openai, anthropic, vault) covering OAuth setup + required scopes
- `DeclaraAuthPlaybook(provider)` tool — loads a playbook, renders it as a system line
- Hard rule update in system prompt: the model MUST refuse to even echo a redacted secret back in its response

Test target: **20+ new tests**, including adversarial leak-test fixtures.

### Phase 3 — Plan-confirm-execute loop (~1 day)

Deliverables:
- `DeclaraProposeChange` + `DeclaraApplyChange` tools
- Proposal state machine — proposal lives in a `Map<uuid, Proposal>` scoped to the REPL session
- New slash commands: `/plan`, `/yes`, `/no`, `/edit`, `/diff`, `/scope`
- System prompt update — embed worked examples showing the propose→confirm→apply flow
- Rendering: proposals render as a numbered list with each step's preview block, followed by a `/yes` / `/no` prompt line
- `/diff` uses `git diff` under the hood, scoped to the scope root

Test target: **25+ new tests** covering the state machine + slash parsing.

### Phase 4 — Fleet-scale flows (~1 day)

Deliverables:
- `DeclaraFleetAdd` — wraps slice-2's `addAgentFromTemplate`
- `DeclaraAddPeer` — appends to `rpc-peers.yaml`
- System prompt extension: fleet-aware heuristics — when the user describes two responsibilities the builder proposes a fleet structure + auto-wires peers
- End-to-end test: user transcript `"build a concierge + pr-reviewer fleet"` → builder produces a valid `fleet-starter`-shaped fleet
- New slash command: `/fleet graph` — renders the fleet's peer graph inline (reuses slice-6 mermaid emitter)

Test target: **15+ new tests**.

### Phase 5 — Monitoring inside the REPL (~1 day)

Deliverables:
- `DeclaraEventsTail`, `DeclaraFleetStatus`, `DeclaraAuditVerify`, `DeclaraDlqShow` — read-only wrappers
- `/monitor` slash command — opens a bottom-of-screen live-tail pane using Ink; streams new events via the same bus as `declaragent events list`
- Correlation threading: when a message mentions a correlation id, the monitor pane auto-filters on it
- System prompt extension: teach the builder to query these tools before speculating about state

Test target: **15+ new tests**.

### Phase 6 — Rollback + safety (~1 day)

Deliverables:
- `packages/cli/src/builder/undo.ts` — git-scoped revert + snapshot fallback scaffolding (snapshot fallback deferred to v0.3 since we've mandated git)
- `/undo` slash command — reverts the last `DeclaraApplyChange` via scoped `git checkout`
- `/history` slash command — renders `audit query --kind 'builder.*'` in the REPL
- Destructive-op gate — intercept `Bash: declaragent deploy` through the permission gate and re-route through `DeclaraProposeChange`
- Test: replay a full session (propose → apply → undo → apply new plan) and assert git history is clean + audit chain verifies

Test target: **20+ new tests**.

### Phase 7 — Docs + launch (~0.5 day)

Deliverables:
- `docs-site/docs/cookbook/build-an-agent.mdx` — full annotated transcript: "Building a PR-review Slack bot through conversation"
- `docs-site/docs/reference/builder.mdx` — tool catalog, slash-command reference, safety model summary
- Website hero terminal extended — a 3-line conversational fragment shows the builder flow
- Bump `@declaragent/cli` to **0.2.0** (first minor — tools are additive, no breaking changes)
- Tag, release-binaries.yml fires, tap updated, homebrew formula stamped to 0.2.0
- Changeset: `builder-slice-1-through-6-consolidated.md` aggregating the full phase work

---

## 8. File layout

```
packages/cli/src/builder/                 # net-new, phase 1
├── types.ts                              # tool input/output Zod schemas
├── scope.ts                              # scope-root resolution
├── git.ts                                # HEAD capture, undo, init-git flow
├── secret-guard.ts                       # phase 2
├── add-skill.ts
├── add-source.ts
├── add-channel.ts
├── add-mcp.ts
├── add-plugin.ts
├── add-secret.ts                         # phase 2
├── add-peer.ts                           # phase 4
├── fleet-add.ts                          # phase 4
├── proposals.ts                          # phase 3 — propose/apply state machine
├── events-tail.ts                        # phase 5
├── fleet-status.ts                       # phase 5
├── audit-verify.ts                       # phase 5
├── dlq-show.ts                           # phase 5
├── auth-playbooks/                       # phase 2
│   ├── anthropic.md
│   ├── github.md
│   ├── openai.md
│   ├── slack.md
│   └── vault.md
├── undo.ts                               # phase 6
├── register.ts                           # wires all tools into the registry
└── index.ts

packages/cli/src/slash-commands.ts        # extend with /plan /yes /no /edit /diff /scope /undo /history /monitor
packages/cli/src/app.tsx                  # wire secret-guard pre-turn hook + builder tool loader

docs-site/docs/reference/builder.mdx      # phase 7
docs-site/docs/cookbook/build-an-agent.mdx   # phase 7

docs/BUILDER_PLAN.md                      # this file
.changeset/builder-*.md                   # one per phase
```

---

## 9. Testing strategy

Six tiers — same shape as FLEET_PLAN.md:

1. **Unit.** Every new file's `*.test.ts`. Zod validation round-trips, secret-guard fixtures, scope-confinement rejections, surgical YAML rewrites preserve comments.
2. **Integration.** Fixture REPL sessions under `packages/cli/src/builder/__fixtures__/`. Feed a transcript of user messages, assert the tool call sequence + resulting file tree.
3. **Golden-path transcripts.** For each template, author a reference transcript: *"build a concierge bot"* → full conversation → scaffolded agent that `declaragent fleet validate` passes cleanly.
4. **Adversarial.** Inject secret-like strings into user messages, assert redaction. Submit malformed YAML configs to each tool, assert Zod rejection with a clear message. Attempt scope breaches without `confirmOutsideScope`, assert refusal.
5. **Undo.** For every builder tool, run apply → undo → assert the file tree + audit chain match pre-apply.
6. **Soak.** Nightly: a 50-turn builder session building a 3-agent fleet + editing + undoing. Assert zero leaks in audit, zero un-reverted files, zero orphan processes.

Baseline test count at v0.1.8: ~1845 pass. Phase target: **+135 tests** through phase 6; final count ≥1980.

---

## 10. Risks

- **Prompt bloat + cost.** Embedding tool contracts + worked examples will push the system prompt from ~650 to ~1800 tokens. Mitigation: move tool-specific guidance into `packages/cli/src/builder/builder-persona.md` that loads only when builder tools are registered; use prompt caching so steady-state cost is minimal.
- **Tool proliferation in production agents.** Shipping 11 builder tools in the npm package means they're loadable by *any* agent, including user-deployed ones. Mitigation: `register.ts` checks a `DECLARAGENT_BUILDER=on` env var OR REPL-context detection; production agents don't get them by default.
- **Schema drift.** Builder tools import source/channel schemas from core. If core's schema evolves, the tools could emit stale YAML. Mitigation: every tool's test imports the same schema at runtime; CI asserts round-trip via the actual loader.
- **Git assumption.** Not every user's project is a git repo. Mitigation: first-turn `initGit` prompt. Users who refuse git forgo the `/undo` surface; that's explicit.
- **Secret-detector false positives.** A high-entropy string that isn't a secret gets redacted. Mitigation: patterns are tight (well-known prefixes + length); a `/secret ignore <snippet>` slash command lets users whitelist in-session.
- **Secret-detector false negatives.** Novel secret formats slip through. Mitigation: quarterly review of patterns + user-reportable issue template; `declaragent audit query` can surface the moment such a secret landed in a file.
- **Proposal churn.** User oscillates between `/edit` steps and never converges. Mitigation: proposals expire after 15 minutes; builder re-proposes cleanly from scratch.
- **Destructive ops habituation.** Users type `/yes deploy` reflexively. Mitigation: the exact match requirement means typing `/yes` alone doesn't trigger deploy. Tested.

---

## 11. Design decisions

Every lean is promoted to a concrete v0.2 commit.

### 11.1 Architecture — **hybrid (tools + rich prompt)**
- Why. Prompt-only is model-dependent; all-tool is slow + redundant for long-tail cases. Hybrid gets schema safety where it matters + flexibility everywhere else.

### 11.2 Git is required for undo — **hard requirement; offer to init**
- Why. Git is ubiquitous + gives us a better rollback primitive than any homegrown snapshot system. Users who refuse git lose `/undo` only.

### 11.3 Tool naming — **`DeclaraAdd*` / `DeclaraPropose*` / `DeclaraApply*`**
- Why. Matches the existing `Read`/`Write`/`Edit` TitleCase convention. The `Declara` prefix disambiguates from any future MCP server that might ship similarly-named tools.

### 11.4 Scope confinement — **default-on; explicit opt-in per call**
- Why. A model that goes off-path should trip a user-visible confirmation, not silently edit a sibling repo. The `confirmOutsideScope` path is always explicit.

### 11.5 Telemetry — **audit records on every builder action**
- Why. Declaragent's enterprise story is built on a hash-chained audit surface. The builder is the highest-privilege agent in the system; its actions belong in the chain.

### 11.6 Secret handling — **pre-turn redaction + no-value `DeclaraAddSecret`**
- Why. The *only* reliable way to keep secrets out of transcripts + files is to never let them in. Detectors are best-effort, but the `DeclaraAddSecret` contract makes the safe path the easy one.

### 11.7 Proposal confirmation — **exact-match phrases for destructive ops**
- Why. `/yes` alone ≠ `/yes deploy`. Destructive ops need intentional typing. Prevents habituation-driven mistakes.

### 11.8 Fleet heuristic — **auto-propose fleets when 2+ responsibilities**
- Why. Single-agent sprawl is a known anti-pattern. Builder defaults to the v1.2 fleet story when the user's ask spans responsibilities.

### 11.9 Packaging — **builder tools load only in REPL context**
- Why. Shipping `DeclaraAddSkill` to a production agent would let the agent edit its own source. Gatekeep to REPL + `DECLARAGENT_BUILDER=on` env.

### 11.10 Plan-then-execute — **mandatory for all multi-file changes**
- Why. Silent writes break the mental model ("I said to add a skill; why did it also touch agent.yaml and .env.example?"). Every change shows + confirms.

---

## 12. Acceptance check

Practical bar for v0.2.0:

1. **Conversational flow works.** User transcript `"I want a Slack bot that reviews every PR and DMs me on blockers"` → builder proposes (concierge + pr-review templates merged into a fleet), asks 2–3 clarifying questions, gets answers, proposes a concrete plan via `DeclaraProposeChange`, applies on `/yes`. Result: a validated fleet tree + `.env.example` with the right placeholders.
2. **Secret hygiene.** Pasting `ghp_abcdef…` in a message triggers redaction before the model ever sees it. The literal token never appears in the transcript, session store, or audit log.
3. **Scope breach.** Asking the builder to edit a file in `../other-repo/` triggers a `DeclaraProposeChange` with `requiresExplicitYes: true`. The user's `/yes` lands the edit; `/no` blocks it.
4. **Undo works.** After a multi-step apply, `/undo` reverts every touched file via `git checkout`. Audit chain still verifies (the undo itself is a new record).
5. **Monitoring inside the REPL.** `/monitor` opens a live pane showing inbound events for the current agent. Killing it returns to the REPL cleanly.
6. **Audit-query surfaces the session.** `declaragent audit query --kind 'builder.*' --session <id>` returns the full action log.
7. **Destructive ops gated.** `/yes` alone cannot trigger a deploy; the user must type `/yes deploy`.
8. **Every slice ships a changeset.** `release-gate.yml` stays green on every merge.
9. **CLI size budget.** Compiled binary stays under the existing 120 MiB ceiling.

---

## 13. Risks that require future work (out of scope for v0.2)

- **Multi-model builders.** The builder uses the current session's provider. A follow-up: allow `DeclaraProposeChange` to use a cheaper model for planning + the session's model for execution.
- **Snapshot fallback for non-git projects.** Deferred; will land if adoption surfaces users with non-git workflows at rate.
- **Collaborative sessions.** Two users building the same agent — merge conflicts on proposals + undo racing. v0.3.
- **Rich diff UX.** Current plan renders unified diffs; a syntax-aware diff (showing which YAML *keys* changed) is a separate polish slice.
- **Telemetry privacy knob.** Current plan records builder actions unconditionally. A `DECLARAGENT_BUILDER_AUDIT=off` escape is likely needed for air-gapped deploys. v0.3.

---

## 14. Next step

**First concrete PR:** `packages/cli/src/builder/types.ts` + `scope.ts` + `git.ts` + `add-skill.ts` + tests. Smallest slice that proves the scaffold, ~1 day, ~25 new tests. Unblocks every subsequent phase.

Once phase 1 lands:
- Phase 2 (secret guard + `DeclaraAddSecret`) is parallelizable with phase 3 (propose/apply loop).
- Phase 4 (fleet) gates on phases 1 + 3.
- Phase 5 (monitoring) parallelizes with 4.
- Phase 6 (undo) gates on phase 3 (needs proposals to scope reverts).
- Phase 7 (docs + launch) gates on all.

Total estimate: **~8 days of focused work**. Minimum-viable (phases 1–3 only) ships in **~4 days** and covers the 80% conversational experience; phases 4–7 elevate it to the full v0.2 acceptance bar.

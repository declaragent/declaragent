# Usability plan — declaragent CLI

**Frame:** "what is the user trying to do, and where do they stall?"
not "what's broken in the code?"

**Source of truth for fixes:** `POST_DEMO_BACKLOG.md` — that's the bug
list. This doc explains *which* bugs matter when + *why*.

**Primary user:** developer or technical PM at an SME who wants to
stand up an AI agent for an internal workflow — support triage,
contract intake, PR review, on-call routing, etc. Has a real job to
do, can't invest a week just to evaluate.

**Product promise** (from declaragent.dev hero): "Production AI
agents, declared in your repo." Reasonable user expectation from
that sentence: I declare → it works.

---

## The user's journey (what the product needs to support)

```
   Install  →  Design  →  Test  →  Refine  →  Deploy  →  Operate
     J1         J2       J3       J4         J5         J6
```

Each stage has a success condition. Usability = can the user reach
the next stage without abandoning, asking for help, or learning
internals they shouldn't need to learn?

| Stage | Success = | Current state |
| --- | --- | --- |
| **J1 Install** | `declaragent --version` prints a version | ⚠ volta / bunx eat postinstall; binary missing |
| **J2 Design** | Scaffold lands on disk via conversation | ⚠ paste broken, y/n typed, sources/channels can't be scaffolded |
| **J3 Test** | Scaffolded agent runs against real input, I see output | ❌ **no path exists** |
| **J4 Refine** | Edit skills, re-test, repeat | ⚠ requires full REPL restart |
| **J5 Deploy** | Agent runs in production | ⚠ gated by `/mode bypass`; path not demoed anywhere |
| **J6 Operate** | See what the live agent is doing, debug failures | ✅ read-only tools exist (events-tail, audit, dlq, fleet status) |

Two hard blocks (J3 marked ❌). Three soft blocks (J1/J2/J4 marked
⚠). Downstream stages are thin but not blocked.

---

## Principles that drive prioritization

1. **Remove hard blocks before polishing soft blocks.** A user who
   can't get past J3 never experiences whatever fine-grained input
   UX we invested in at J2.
2. **Time to first real success (TTFR) < 15 minutes.** "Real" =
   a skill runs against the user's actual data, not a canned demo.
   Optimize the longest stretch between stages.
3. **Every failure mode surfaces the next action.** An error
   message without a "try X" is a dead-end — half the users quit
   there.
4. **Mental model = output on disk + one command to run it.** If
   the user has to understand the daemon's global source registry,
   or the fleet RPC topology, to test a single-agent skill, we've
   failed at progressive disclosure.
5. **Conversational flow handles the input the user types.** Paste,
   multi-line, file refs — all baseline, not phase-7.

---

## Priority ladder (friction ranked by user impact)

### P0 — Journey 3 is impossible (ship-blocking)

**Symptom:** user scaffolds an agent, types `declaragent daemon` /
`declaragent fleet run` / `declaragent`, and nothing in the
scaffold runs. The only way to "test" a skill is to tell the
builder REPL to read the skill file + apply it as a text prompt —
a hack that exposes the wrong mental model.

**What matters to the user:** "did my scaffold actually do the
thing I described?"

**Fix:** `declaragent run <dir>` — one command that loads the
scaffolded `agent.yaml`, boots a session with that persona +
skills, and drops into the REPL. Wire sources (file-watch,
webhook, cron) declared in `event-sources.yaml` so events
actually fire against this session.

**Why P0:** without this, every user hits the same wall we hit in
the demo. Until it ships, demos lie and the product isn't
usable end-to-end.

**Backlog mapping:** #14 (run-as-agent REPL) + #15 (daemon
per-agent sources) + #16 (fleet-run engine integration). Of
these, #14 is 80% of the value for 20% of the work; the others
can follow.

**Shipping shape:** `@declaragent/cli@0.3.3` (patch — additive
verb). ~2–3 days.

**Acceptance:** `declaragent run .` against the pr-review scaffold
accepts a webhook curl; skill invokes; YAML output visible in the
event audit.

---

### P1 — Journey 2 has dead-ends mid-conversation

**Symptom:** user says "add a Slack channel" → builder model tries
to emit an `addChannel` step → dispatcher says "not supported yet
in this build." User has to drop to a shell + hand-edit
`channels.yaml` to proceed. Breaks the conversational promise.

**What matters to the user:** "can I author the whole agent
through conversation, or just the skill part?"

**Fix:** complete the four missing step-kind dispatchers:
`DeclaraAddSource`, `DeclaraAddChannel`, `DeclaraAddMCP`,
`DeclaraAddPlugin`. Same pattern as the five already-shipping
authoring tools.

**Why P1:** it's the difference between "the builder can scaffold
a skill for you" and "the builder can scaffold an entire agent."
Huge perceived-completeness delta.

**Order within P1:** source > channel > MCP > plugin. Sources
block event-driven agents. Channels block user-facing agents. MCP
and plugin are nice-to-haves by comparison.

**Backlog mapping:** #5.

**Shipping shape:** `@declaragent/cli@0.4.0` (minor — new tools).
~3–4 days.

**Acceptance:** "build a Slack PR-review bot" → one proposal with
`addAgent` + `addSource` + `addChannel` + `addSkill` + `addSecret`;
`/yes` → apply → `declaragent run .` → live bot.

---

### P2 — Input UX breaks during the conversation

**Symptom:** user pastes a 20-line prompt → first line submits,
rest trickles in as garbage or gets dropped. User has to retype
everything one line at a time. Happens every time a prompt is
non-trivial. Soft block — not catastrophic, but grinding.

**Plus:** `/yes /no /edit` require typing slash-commands. Fine
for power users, friction for newcomers who expect "press Y to
confirm".

**What matters to the user:** "can I have a normal
conversation, or do I have to contort to the tool?"

**Fix:** three pieces, independent:
- Bracketed-paste detection (backlog #1) — proper multi-line
  paste. 1 day.
- `/prompt <path>` slash command (stopgap for long prompts). 30
  min.
- Y/N selector for pending proposals (backlog #0). 0.5 day.
- `@<path>` file-ref expansion (backlog #12) — mention files
  inline. 0.5 day.

**Why P2:** every user hits these eventually; the pain scales
with how much the user trusts the tool with complex input.

**Shipping shape:** `@declaragent/cli@0.4.1` or fold into 0.4.0.
~2 days total.

---

### P3 — Install has sharp edges

**Symptom:** user runs `npm install -g @declaragent/cli` under
volta → postinstall is skipped → binary missing → confusing
"binary not found" on first invocation. `bunx` has the same
issue. Fresh installs fail ~20% of the time on macOS dev boxes.

**What matters to the user:** "does this thing work right after
install, or do I have to debug?" A fail-at-install is often a
silent abandonment.

**Fix:** two pieces.
- Smarter `bin/declaragent.js` launcher — if binary missing on
  first invocation, offer to run postinstall inline + continue
  instead of erroring. No more "re-run postinstall" cryptic.
- README + docs-site install section: call out volta / bunx /
  fnm quirks explicitly with the foreground-scripts flag
  (`npm install -g --foreground-scripts @declaragent/cli`).

**Why P3:** early abandonment is expensive — we never hear
from users who bounce at install.

**Backlog mapping:** #4 (volta postinstall).

**Shipping shape:** docs in 0.3.3; launcher polish in 0.4.x.
~1 day.

---

### P4 — Refine cycle requires full restart

**Symptom:** user builds a skill → `declaragent run .` → tries it
→ wants to tweak the skill's prompt → has to exit REPL, edit the
md file, restart, hope prior session isn't still in history.

**What matters to the user:** "can I iterate fast, or do I lose my
context on every tweak?"

**Fix:** `/reload` slash command in the REPL that re-loads
`<cwd>/agent.yaml` + skills without exiting. Preserves the
session transcript + the model history.

**Why P4:** iteration speed is where long-term usability
compounds. Not a first-impression issue but a week-two
retention issue.

**Backlog mapping:** (new — add as item #17 in backlog)

**Shipping shape:** `@declaragent/cli@0.5.0`. ~1 day.

---

### P5 — Deploy path is documented nowhere

**Symptom:** user has a working scaffold + tested it. Now what?
The CLI has `declaragent deploy gcp-cloud-run` but:
- the permission gate blocks it
- `/yes deploy` is a proposal concept
- no step-by-step docs on the dev→prod transition

User bails or sinks hours into figuring it out.

**Fix:** cookbook page — `cookbook/dev-to-prod.mdx` — walks
through the exact sequence: validate locally with
`declaragent run .` → fill secrets → deploy target picked → what
to expect post-deploy. The ergonomics mostly exist; the path
through them needs documenting.

**Why P5:** conversion from evaluator → user happens here. No
docs = no conversion.

**Shipping shape:** docs-only. ~half day.

---

### P6 — Operations surface is thin

**Symptom:** agent is running in prod; something goes wrong; user
wants to debug. `declaragent events list` + `declaragent audit
verify` exist but aren't composed into a "my agent is failing,
here's what's happening" flow.

**Fix:** `/monitor` Ink live-tail pane (backlog #7, deferred for
now). Until then: a cookbook recipe + a simple
`declaragent tail [--correlation <id>]` verb that follows new
events.

**Why P6:** advanced-user problem. Matters once we have users
running real traffic. Not an onboarding blocker.

**Shipping shape:** new verb + cookbook page in 0.5.x;
`/monitor` pane in 0.6+.

---

## What success looks like by release

| Release | After this ships, the user can … | Cumulative time to first real success |
| --- | --- | --- |
| **0.3.3** (P0 + P3) | scaffold an agent conversationally + run it + get output | ~15 min (was: impossible) |
| **0.4.0** (P1) | scaffold a *complete* agent (source + channel + skill + secret) without manual yaml | ~10 min |
| **0.4.1** (P2) | carry on a natural conversation with the builder — paste, multi-line, file refs, keypress confirms | friction drop, not a new stage |
| **0.5.0** (P4 + P5) | iterate fast + ship to prod with confidence | from "it works locally" to "it's deployed" in under 20 min |
| **0.6+** (P6) | diagnose a live agent's behavior fluently | day-2 operations |

---

## Non-goals (explicitly not part of the usability plan)

- **Multi-step `/undo`** (backlog #6) — single-step is fine until
  we have evidence users actually want stacked.
- **Core audit-kind refactor** (backlog #8) — internal cleanup;
  no user impact.
- **Non-git snapshot fallback** (backlog #9) — git's ubiquitous
  enough that this is optimizing for an edge case.
- **Multi-model builders** (plan §13) — power-user feature.

---

## The one thing I'd do first

Land **`declaragent run <dir>`** as `@declaragent/cli@0.3.3`.

Everything else in this plan compounds on the assumption that
users can actually run their scaffolds. Until the verb exists,
every other fix is building on sand.

First PR scope (tight):
- `packages/cli/src/run-agent-cli.ts` — new verb.
- `packages/core/src/agents/load-agent.ts` — extracted from the
  fleet-manifest-loader's single-agent code path if not already
  standalone.
- `packages/cli/src/app.tsx` — accept an optional `agentSpec`
  prop so the REPL can run as something other than the builder
  persona.
- Skill-only mode first (no source wiring) — that's still useful
  for conversational testing. Source wiring in PR #2.

Ship, measure, then keep walking the ladder.

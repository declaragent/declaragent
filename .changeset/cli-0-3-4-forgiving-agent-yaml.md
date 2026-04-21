---
'@declaragent/cli': patch
'@declaragent/core': patch
---

Fix `declaragent run` rejecting agents scaffolded by `declaragent init`.

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

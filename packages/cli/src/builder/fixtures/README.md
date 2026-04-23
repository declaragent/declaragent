# Builder replay fixtures

JSONL transcripts used by `fixture-replay.test.ts` to prove the
conversational builder's understand → propose → apply loop still
drives the expected `DeclaraApplyChange` step kinds in the current
build. See `docs/ENTERPRISE_PRODUCTION_PLAN.md` §3 Item #12.

Each line is one JSON object. Blank lines and `#`-prefixed comment
lines are allowed. Entry shapes:

```jsonl
{ "role": "user", "text": "..." }
{ "role": "assistant", "content": [ ... ], "stopReason": "tool_use" }
```

User entries kick off one `engine.runAgent()` turn. Assistant entries
are replayed verbatim by the stub provider. `stopReason` defaults to
`tool_use` when any content block is a `tool_use`, otherwise `end_turn`.

`tool_result` blocks are **not** in the fixture — the replay harness
lets the real tools execute and synthesises results just like a live
session. That's the point: we're regression-testing the Engine's
response to the recorded assistant sequence, not replaying a
predetermined filesystem outcome.

All five fixtures here were **hand-authored** against the published
tool schemas; see the per-fixture Authorship note in the test file.
Real Claude-driven transcripts slot in here unchanged via the
`BUILDER_RECORD=1` capture flow below.

## How to record a fixture

Set `BUILDER_RECORD=1` before launching the REPL to capture every
assistant completion and user turn into a JSONL file that's byte-for-
byte replayable by the existing `replayFixture()` harness — no
harness edits required.

```sh
# 1. Minimal — writes recorded-<ISO8601>.jsonl to the current directory.
BUILDER_RECORD=1 declaragent

# 2. Pick the output location explicitly.
BUILDER_RECORD=1 \
BUILDER_RECORD_OUT=packages/cli/src/builder/fixtures/06-my-case.jsonl \
  declaragent

# 3. Builder persona + recording in one shot.
DECLARAGENT_BUILDER=on BUILDER_RECORD=1 declaragent
```

On the first engine build the REPL prints a `recording conversation
to …` system line so you can confirm the capture is live. On clean
exit (`/exit` or double-Ctrl+C) the REPL prints the output path to
stderr so the operator can grab the transcript.

Accepted truthy values for `BUILDER_RECORD`: `1`, `true`, `yes`,
`on` (case-insensitive). Anything else — including unset — disables
the recorder.

### Safety

- Every captured line passes through the same `redactSecrets()`
  pipeline the REPL uses on user input *before* writing. Pasted
  GitHub PATs, Slack tokens, JWTs, AWS access key ids, npm tokens,
  `sk-…` API keys, and OAuth tokens are replaced with `<redacted:…>`
  placeholders. Never commit a recorded fixture without eyeballing
  the file first — the redactor catches the common cases, not every
  possible secret shape.
- `stream()` is not recorded. The builder's engine always uses
  `complete()`; a future streaming path would need a matching hook
  here before it's safe to ship.
- Writes are durable per-line: `appendFileSync` flushes before
  returning, so a crash mid-conversation leaves a partial but
  replayable JSONL on disk.

### Turning a recording into a checked-in fixture

1. Run the capture flow end-to-end (user → assistant → apply).
2. `mv recorded-<stamp>.jsonl packages/cli/src/builder/fixtures/NN-short-name.jsonl`.
3. Add a comment header + any inline `#` notes explaining what
   surface the fixture exercises.
4. Add a test case to `__tests__/fixture-replay.test.ts` asserting
   the expected `appliedStepKinds`.
5. Eyeball the JSONL for anything that *looks* secret-y — the
   redactor is tight on prefixes but not exhaustive.

See `docs/ENTERPRISE_PRODUCTION_PLAN.md` §3 Item #12 and the stretch-
goal entry for the spec the capture mode closes.

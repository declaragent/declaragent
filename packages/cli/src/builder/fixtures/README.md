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
When `BUILDER_RECORD=1 declaragent` lands (stretch goal in the spec),
real Claude-driven transcripts will slot in here unchanged.

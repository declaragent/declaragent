---
'@declaragent/cli': patch
---

feat(builder): tool_result capture + cache-token usage fields + stable RecordingProviderHandle (#36, #37, #38)

Three post-enterprise backlog polish items land together in the builder fixture surface (`packages/cli/src/builder/**`):

- **#36 `tool_result` block capture.** `BUILDER_RECORD=1` JSONL now persists any `tool_result` blocks observed in an assistant response under a new optional `toolResults` field on `FixtureEntry`. The replay harness merges recorded `toolResults` into the emitted `LLMResponse.content` so a future provider that surfaces tool results as first-class assistant content (or a streamed content_block event) round-trips faithfully. Forward-compat: the engine's current non-streaming `complete()` path never emits `tool_result` directly, so existing fixtures carry no `toolResults` and replay unchanged.

- **#37 cost-regression usage fields.** `FixtureEntry.usage` grows `cacheCreationInputTokens`, `cacheReadInputTokens`, and `serverTimestamps: { firstToken, lastToken }` so prompt-cache efficiency + TTFT regressions can be asserted against recorded fixtures. New helpers `computeCacheHitRate(entries)` and `expectCacheHitRateAtLeast(fixturePath, threshold)` in `__tests__/replay-harness.ts`. New fixture `06-cache-usage-regression.jsonl` wires a 0.8-threshold assertion into the regression suite.

- **#38 stable `RecordingProviderHandle`.** The outer handle now survives engine rebuilds (mode / model / auditSink changes). `handle.swapInnerProvider(next)` rotates the wrapped provider without recreating the observer, preserving output-path + any turn-id → fixture bookkeeping the caller has accumulated. In-flight `complete()` calls pin the pre-swap inner at call time so a mid-turn rebuild doesn't fork the transcript across two providers.

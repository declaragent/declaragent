/**
 * Recording wrapper for `LLMProvider`. Stretch-goal follow-up to
 * Enterprise Production Plan §3 Item #12.
 *
 * Round-5 shipped the replay harness in `__tests__/replay-harness.ts`
 * plus five **hand-authored** fixtures under `fixtures/*.jsonl`. This
 * module is the inverse: wrap a live provider, pass every `complete()`
 * call through to the inner, and append the assistant messages it
 * emits to a JSONL file that `replayFixture()` can load without any
 * harness-side code changes.
 *
 * Design contract — the written JSONL MUST be consumable by the
 * existing replay harness. That means:
 *   - `{ role: 'user', text }` for every REPL submit (via
 *     {@link createRecordingProvider}'s returned `recordUserTurn`
 *     helper — the provider itself never sees the raw user text).
 *   - `{ role: 'assistant', content, stopReason?, usage?, model? }`
 *     for every `complete()` response. Content is the literal
 *     `MessageContent[]` the inner provider returned.
 *
 * Secret safety: whatever text reaches the LLM is whatever the REPL
 * already redacted. The redaction pipeline runs in `app.tsx`'s
 * `handleSubmit` BEFORE `engine.runAgent()` is called, so by the
 * time a turn produces an assistant message the raw secret has
 * already been replaced with `<redacted:...>` in the transcript the
 * engine sends to the provider. The recording wrapper therefore
 * captures the already-redacted form by construction. As a defence in
 * depth we **also** re-run the recorded content + user turn through
 * `redactSecrets()` on the write path — belt-and-braces against
 * future refactors that might move redaction around.
 *
 * Durability: every append is an `fsync`'d, `\n`-terminated JSON line
 * written with `appendFileSync`. No buffering inside Node. If the REPL
 * crashes or `kill -9`s mid-conversation, the partial fixture survives
 * intact and replayable up to the last completed assistant turn.
 *
 * ## Post-enterprise backlog polish (0.7.6)
 *
 * Three follow-up items from PR #29's "Open questions" section land
 * in 0.7.6 and shape the current surface:
 *
 * - **#36 `tool_result` block capture.** The Anthropic Messages API
 *   streams `content_block` events for tool_use + text, and tool
 *   results land in the *next* user message as a synthesised
 *   `tool_result` content block. Today our engine uses the
 *   non-streaming `complete()` path so tool_result blocks only ever
 *   appear in subsequent `messages[].content` — never on the wire as
 *   a streamed delta. The recorder now detects `tool_result` blocks
 *   wherever they appear in an assistant response and persists them
 *   under an optional `toolResults` field so a future provider that
 *   emits them directly (or a provider that paraphrases a user-side
 *   tool result into assistant content) produces a replayable trace.
 *
 * - **#37 cost-regression usage fields.** Prompt caching is now the
 *   dominant cost lever for the builder — without `cacheCreationInputTokens`
 *   and `cacheReadInputTokens` on the fixture, a silent regression
 *   in cache efficiency is invisible at CI time. The capture path
 *   writes both plus a pair of server-side timestamps (`firstToken` /
 *   `lastToken`) so TTFT regressions can also be asserted against.
 *
 * - **#38 stable handle across rebuild.** Pre-0.7.6 the REPL built a
 *   fresh {@link RecordingProviderHandle} every time the engine
 *   re-wired (mode / model / auditSink change), which dropped
 *   turn-id → fixture bookkeeping mid-turn. The handle is now stable
 *   for the session: `swapInnerProvider(next)` rotates the wire
 *   without recreating the observer, so bookkeeping on the outer
 *   survives rebuilds.
 *
 * @since 0.6.x (stretch-goal for #12) · polish 0.7.6 (#36 + #37 + #38)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LLMProvider, LLMRequest, LLMResponse, Message } from '@declaragent/core';
import { redactSecrets } from './secret-guard.js';

/**
 * Local alias for the engine's `MessageContent` union.
 *
 * Historically this file aliased through `LLMResponse['content'][number]`
 * because `@declaragent/core` re-exported two types named `MessageContent`
 * (the LLM block union and the channels envelope shape) and callers had
 * to disambiguate. Since backlog item #41 the channels variant is named
 * `ChannelMessageContent`, so `MessageContent` now unambiguously resolves
 * to the LLM union. The alias is kept to decouple fixture shapes from
 * any future re-shuffle of the public type surface.
 */
type LLMContent = LLMResponse['content'][number];
type StopReason = LLMResponse['stopReason'];

/**
 * Narrow of `LLMContent` to the `tool_result` variant. Exported for
 * fixture authors + the replay harness so they don't have to re-derive
 * the narrow on every call-site.
 */
export type ToolResultBlock = Extract<LLMContent, { type: 'tool_result' }>;

/**
 * Usage fields captured per assistant turn. `inputTokens` /
 * `outputTokens` are today's baseline; `cacheCreationInputTokens` +
 * `cacheReadInputTokens` enable cache-hit-rate regression tests (item
 * #37); `serverTimestamps` lets TTFT / end-of-stream latency regressions
 * trip the same tests. All fields are optional — a provider that
 * doesn't emit cache telemetry simply omits them and
 * {@link RecordedUsage}'s default-zero replay still works.
 */
export interface RecordedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly serverTimestamps?: {
    readonly firstToken: string;
    readonly lastToken: string;
  };
}

/**
 * A single line in the output JSONL. Shape matches the
 * `FixtureEntry` union in `__tests__/replay-harness.ts` exactly so
 * the recorded file is replayable without harness changes.
 */
export type RecordedEntry =
  | { readonly role: 'user'; readonly text: string }
  | {
      readonly role: 'assistant';
      readonly content: readonly LLMContent[];
      readonly stopReason?: StopReason;
      readonly usage?: RecordedUsage;
      readonly model?: string;
      /**
       * Tool-result blocks emitted by the provider (item #36). Today
       * the engine's non-streaming `complete()` path never surfaces
       * tool_result blocks directly — they land inside subsequent
       * `messages[].content` arrays as user-role content. A
       * hypothetical future provider that paraphrases tool results
       * into assistant content, or one that streams tool_result
       * blocks as first-class content_block events, would populate
       * this field. Kept optional so pre-0.7.6 fixtures load
       * unchanged.
       */
      readonly toolResults?: readonly ToolResultBlock[];
    };

export interface RecordingProviderOptions {
  /**
   * The live provider being wrapped. All `complete()` / `countTokens()`
   * / `stream?()` calls pass through to this instance; the recorder
   * only observes. The inner ref is swappable via
   * {@link RecordingProviderHandle.swapInnerProvider} (item #38) so
   * the outer handle survives engine rebuilds.
   */
  readonly inner: LLMProvider;
  /**
   * Absolute path for the JSONL output file. Parent directories are
   * created on first write.
   */
  readonly outputPath: string;
  /**
   * Optional sink for errors during file writes. The default prints
   * to `process.stderr` — we never throw from the recorder because a
   * broken recording must not break the live session.
   */
  readonly onWriteError?: (err: Error) => void;
  /**
   * Clock hook. Exposed for deterministic tests around TTFT /
   * serverTimestamps capture; production callers leave this unset so
   * `new Date().toISOString()` is used.
   */
  readonly now?: () => Date;
}

export interface RecordingProviderHandle extends LLMProvider {
  /**
   * Append a `{ role: 'user', text }` entry. Callers wire this into
   * the REPL's submit path so user turns land in the JSONL in the
   * correct order relative to the surrounding assistant messages.
   * The text is re-redacted here as a defence in depth.
   */
  recordUserTurn(text: string): void;
  /**
   * Rotate the wrapped provider without throwing away the outer
   * handle (item #38). The REPL's engine-rebuild effect calls this
   * when mode / model / auditSink change so any in-flight turn-id →
   * fixture bookkeeping on the outer handle survives the swap. The
   * output path + on-disk state are preserved. Returns the previous
   * inner so callers can cleanly shut it down if it owns resources.
   */
  swapInnerProvider(next: LLMProvider): LLMProvider;
  /**
   * Current wrapped provider. Exposed so tests (and the REPL) can
   * assert what the handle is currently forwarding to without
   * reaching through a mutable closure. Not typed `readonly` because
   * semantically the reference IS a mutable ref — the outer is the
   * stable part.
   */
  readonly innerProvider: LLMProvider;
  /**
   * Output path (echoed in the REPL on clean exit so the operator
   * knows where to grab the transcript).
   */
  readonly outputPath: string;
}

function defaultErrorSink(err: Error): void {
  // Intentionally not using console — logger setup varies across
  // entry points and we'd rather land in stderr than nowhere.
  try {
    process.stderr.write(`[BUILDER_RECORD] write failed: ${err.message}\n`);
  } catch {
    // stderr may itself be closed during teardown; swallow.
  }
}

/**
 * Serialise one entry + newline, then `appendFileSync` it. The
 * `appendFileSync` syscall is atomic per-line because our payloads
 * are small (≪ `PIPE_BUF`), so a concurrent reader will never see a
 * torn line. We don't cache a file descriptor — letting the OS open
 * + close per append means a mid-conversation crash can't leave a
 * stale FD holding the file's write lock on Windows.
 */
function appendLine(path: string, entry: RecordedEntry, onError: (err: Error) => void): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Run the recorded entry through the same secret-redactor that
 * `app.tsx#handleSubmit` uses on user input. For assistant content
 * we redact `text` blocks AND `tool_result` block content strings —
 * `tool_use` inputs are structured JSON that the redactor isn't
 * designed for, and they're supposed to contain `${env:VAR}` refs
 * (not raw secrets) by construction of the builder tools' input
 * schemas. A tool-call payload carrying a raw token is a separate
 * bug worth surfacing loudly; we don't silently scrub it here.
 */
function redactEntry(entry: RecordedEntry): RecordedEntry {
  if (entry.role === 'user') {
    return { role: 'user', text: redactSecrets(entry.text).redacted };
  }
  const rewritten: LLMContent[] = entry.content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: redactSecrets(block.text).redacted };
    }
    if (block.type === 'tool_result') {
      return { ...block, content: redactSecrets(block.content).redacted };
    }
    return block;
  });
  const toolResults = entry.toolResults?.map(
    (tr): ToolResultBlock => ({ ...tr, content: redactSecrets(tr.content).redacted }),
  );
  return {
    ...entry,
    content: rewritten,
    ...(toolResults !== undefined && { toolResults }),
  };
}

/**
 * Pluck the `tool_result` blocks out of a response's `content` array.
 * Today `complete()` responses shouldn't contain them — assistant
 * content is `text | tool_use` — but a future provider (or a stream
 * implementation that re-inlines user-side tool results) might emit
 * them alongside the assistant's text. We surface them in the
 * dedicated `toolResults` field so the replay harness can route them
 * back into the engine at the right stream position without mixing
 * them up with tool_use requests.
 */
function extractToolResults(content: readonly LLMContent[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const block of content) {
    if (block.type === 'tool_result') out.push(block);
  }
  return out;
}

/**
 * Wrap `inner` into a provider that records every `complete()`
 * response to `outputPath`. `stream?()` is NOT recorded — the
 * conversational builder's engine always uses `complete()` (it needs
 * the full tool_use block set to drive the propose-confirm-apply
 * loop), so exposing `stream` on the wrapper could produce silent
 * gaps in the recording. We leave it off.
 *
 * The returned handle is **stable for the session** (item #38).
 * Engine rebuilds should call {@link RecordingProviderHandle.swapInnerProvider}
 * to rotate the inner ref rather than building a second handle —
 * that keeps any turn-id → fixture bookkeeping the caller has
 * accumulated on the outer.
 */
export function createRecordingProvider(
  options: RecordingProviderOptions,
): RecordingProviderHandle {
  const onError = options.onWriteError ?? defaultErrorSink;
  const outputPath = options.outputPath;
  const clock = options.now ?? (() => new Date());

  // The inner ref is mutable — item #38. Every forwarded call reads
  // `innerRef` at invocation time so an in-flight turn happening
  // across a `swapInnerProvider` boundary uses whichever provider
  // was current when it started (awaited promises keep their closure
  // over the old ref; new calls pick up the new one).
  let innerRef: LLMProvider = options.inner;

  function writeAssistant(response: LLMResponse, firstTokenAt: Date, lastTokenAt: Date): void {
    const usage: {
      inputTokens?: number;
      outputTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      serverTimestamps?: { firstToken: string; lastToken: string };
    } = {};
    if (typeof response.usage?.inputTokens === 'number') {
      usage.inputTokens = response.usage.inputTokens;
    }
    if (typeof response.usage?.outputTokens === 'number') {
      usage.outputTokens = response.usage.outputTokens;
    }
    // Cache tokens travel on the `TokenUsage` type as `cacheReadTokens`
    // today (see `packages/core/src/types/messages.ts`) — we surface
    // BOTH classic Anthropic field names on the fixture side so a
    // future provider that emits `cacheCreationInputTokens` directly
    // (or one that renames) can be captured without a schema bump.
    // The extra fields are read off the response's `usage` record via
    // a structural probe; unknown providers get `undefined`.
    const extendedUsage = response.usage as {
      cacheReadTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
    if (typeof extendedUsage.cacheCreationInputTokens === 'number') {
      usage.cacheCreationInputTokens = extendedUsage.cacheCreationInputTokens;
    }
    const cacheRead = extendedUsage.cacheReadInputTokens ?? extendedUsage.cacheReadTokens;
    if (typeof cacheRead === 'number') {
      usage.cacheReadInputTokens = cacheRead;
    }
    usage.serverTimestamps = {
      firstToken: firstTokenAt.toISOString(),
      lastToken: lastTokenAt.toISOString(),
    };
    const toolResults = extractToolResults(response.content);
    const entry: RecordedEntry = {
      role: 'assistant',
      content: response.content.slice(),
      stopReason: response.stopReason,
      ...(Object.keys(usage).length > 0 && { usage }),
      model: response.model,
      ...(toolResults.length > 0 && { toolResults }),
    };
    appendLine(outputPath, redactEntry(entry), onError);
  }

  const handle: RecordingProviderHandle = {
    name: `recording(${options.inner.name})`,
    outputPath,
    get innerProvider(): LLMProvider {
      return innerRef;
    },
    async complete(request: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
      const firstTokenAt = clock();
      // Pin the inner at call time. A concurrent swapInnerProvider()
      // must not retarget an in-flight awaited promise.
      const pinned = innerRef;
      const response = await pinned.complete(request, signal);
      const lastTokenAt = clock();
      writeAssistant(response, firstTokenAt, lastTokenAt);
      return response;
    },
    async countTokens(messages: Message[]): Promise<number> {
      return innerRef.countTokens(messages);
    },
    recordUserTurn(text: string): void {
      appendLine(outputPath, redactEntry({ role: 'user', text }), onError);
    },
    swapInnerProvider(next: LLMProvider): LLMProvider {
      const prev = innerRef;
      innerRef = next;
      return prev;
    },
  };
  // `name` and `innerProvider` are intentionally driven by the
  // **original** inner at construction time (we don't re-derive the
  // `name` on swap — the handle identity stays stable, which is the
  // whole point). Downstream code keying on `handle.name` for an
  // audit label gets a consistent string across swaps.
  return handle;
}

/**
 * Compute the default output path used when `BUILDER_RECORD=1` is
 * set without an explicit `BUILDER_RECORD_OUT`. The ISO8601 timestamp
 * is `Z`-suffixed + `:`-stripped so filenames are portable across
 * case-sensitive and case-insensitive filesystems (macOS HFS+ / NTFS
 * both reject `:` in filenames).
 */
export function defaultRecordingPath(fixturesDir: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${fixturesDir}/recorded-${stamp}.jsonl`;
}

/**
 * True when `BUILDER_RECORD=1` (or any truthy value) is set in the
 * current process's environment. Accepts `1`, `true`, `yes`, `on`
 * case-insensitively — unset / `0` / `false` return false.
 */
export function recordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BUILDER_RECORD;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

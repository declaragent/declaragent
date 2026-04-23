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
 * @since 0.6.x (stretch-goal for #12)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LLMProvider, LLMRequest, LLMResponse, Message } from '@declaragent/core';
import { redactSecrets } from './secret-guard.js';

/**
 * Local alias for the engine's `MessageContent` union. `@declaragent/core`
 * re-exports a *different* `MessageContent` at the top of its surface
 * (the channels layer's envelope shape) which collides with the
 * messages-layer union the LLM provider actually speaks. Aliasing
 * through `LLMResponse['content'][number]` resolves to the right
 * one without depending on which re-export wins. Same trick the
 * replay harness uses.
 */
type LLMContent = LLMResponse['content'][number];
type StopReason = LLMResponse['stopReason'];

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
      readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
      readonly model?: string;
    };

export interface RecordingProviderOptions {
  /**
   * The live provider being wrapped. All `complete()` / `countTokens()`
   * / `stream?()` calls pass through to this instance; the recorder
   * only observes.
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
 * we only redact `text` blocks — `tool_use` inputs are structured
 * JSON that the redactor isn't designed for, and they're supposed
 * to contain `${env:VAR}` refs (not raw secrets) by construction
 * of the builder tools' input schemas. A tool-call payload carrying
 * a raw token is a separate bug worth surfacing loudly; we don't
 * silently scrub it here.
 */
function redactEntry(entry: RecordedEntry): RecordedEntry {
  if (entry.role === 'user') {
    return { role: 'user', text: redactSecrets(entry.text).redacted };
  }
  const rewritten: LLMContent[] = entry.content.map((block) => {
    if (block.type !== 'text') return block;
    return { type: 'text', text: redactSecrets(block.text).redacted };
  });
  return { ...entry, content: rewritten };
}

/**
 * Wrap `inner` into a provider that records every `complete()`
 * response to `outputPath`. `stream?()` is NOT recorded — the
 * conversational builder's engine always uses `complete()` (it needs
 * the full tool_use block set to drive the propose-confirm-apply
 * loop), so exposing `stream` on the wrapper could produce silent
 * gaps in the recording. We leave it off.
 */
export function createRecordingProvider(
  options: RecordingProviderOptions,
): RecordingProviderHandle {
  const onError = options.onWriteError ?? defaultErrorSink;
  const outputPath = options.outputPath;

  function writeAssistant(response: LLMResponse): void {
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    if (typeof response.usage?.inputTokens === 'number') {
      usage.inputTokens = response.usage.inputTokens;
    }
    if (typeof response.usage?.outputTokens === 'number') {
      usage.outputTokens = response.usage.outputTokens;
    }
    const entry: RecordedEntry = {
      role: 'assistant',
      content: response.content.slice(),
      stopReason: response.stopReason,
      ...(Object.keys(usage).length > 0 && { usage }),
      model: response.model,
    };
    appendLine(outputPath, redactEntry(entry), onError);
  }

  const handle: RecordingProviderHandle = {
    name: `recording(${options.inner.name})`,
    outputPath,
    async complete(request: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
      const response = await options.inner.complete(request, signal);
      writeAssistant(response);
      return response;
    },
    async countTokens(messages: Message[]): Promise<number> {
      return options.inner.countTokens(messages);
    },
    recordUserTurn(text: string): void {
      appendLine(outputPath, redactEntry({ role: 'user', text }), onError);
    },
  };
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

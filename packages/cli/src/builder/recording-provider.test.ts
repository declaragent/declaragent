/**
 * Unit + round-trip tests for {@link createRecordingProvider}. Proves:
 *
 *   - `complete()` responses are appended to the JSONL output file.
 *   - `recordUserTurn()` appends `{ role: 'user', text }` entries.
 *   - Pasted secrets are redacted before the line lands on disk.
 *   - The output file is replayable by the existing
 *     {@link replayFixture} harness with zero harness-side changes —
 *     that's the load-bearing contract for the stretch goal.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, LLMResponse, Message } from '@declaragent/core';
import { replayFixture } from './__tests__/replay-harness.js';
import {
  type RecordedEntry,
  createRecordingProvider,
  defaultRecordingPath,
  recordingEnabled,
} from './recording-provider.js';

type LLMContent = LLMResponse['content'][number];

/** Minimal stub provider that replays a scripted queue of responses. */
function stubProvider(responses: LLMResponse[]): LLMProvider {
  let index = 0;
  return {
    name: 'stub',
    async complete(_request: LLMRequest, _signal: AbortSignal): Promise<LLMResponse> {
      const response = responses[index];
      if (!response) throw new Error(`stub exhausted at ${index}`);
      index += 1;
      return response;
    },
    async countTokens(_messages: Message[]): Promise<number> {
      return 0;
    },
  };
}

function readJsonl(path: string): RecordedEntry[] {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as RecordedEntry);
}

/** Mirror of the webhook-triager fixture as stub responses. */
function webhookFleetResponses(): LLMResponse[] {
  return [
    {
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 40 },
      model: 'claude-opus-4-7',
      content: [
        { type: 'text', text: "I'll propose a webhook source plus a triage skill." },
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'DeclaraProposeChange',
          input: {
            summary: 'webhook triager with inbound source + triage skill',
            steps: [
              {
                kind: 'addSource',
                description: 'webhook source bound to /gh',
                payload: {
                  type: 'webhook',
                  id: 'gh',
                  config: {
                    id: 'gh',
                    path: '/gh',
                    target: { type: 'skill', name: 'triage' },
                  },
                },
              },
              {
                kind: 'addSkill',
                description: 'triage inbound events',
                payload: {
                  name: 'triage',
                  description: 'triage github webhook events',
                  body: 'When an event arrives, classify it and respond.',
                },
              },
            ],
          },
        },
      ] satisfies LLMContent[],
    },
    {
      stopReason: 'tool_use',
      usage: { inputTokens: 110, outputTokens: 10 },
      model: 'claude-opus-4-7',
      content: [
        {
          type: 'tool_use',
          id: 'call-2',
          name: 'DeclaraApplyChange',
          input: { proposalId: '__LATEST__' },
        },
      ] satisfies LLMContent[],
    },
    {
      stopReason: 'end_turn',
      usage: { inputTokens: 130, outputTokens: 8 },
      model: 'claude-opus-4-7',
      content: [
        { type: 'text', text: 'Done — webhook source + triage skill are in place.' },
      ] satisfies LLMContent[],
    },
  ];
}

describe('recording-provider', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'declara-record-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('passes complete() through and writes an assistant JSONL line', async () => {
    const out = join(tmp, 'rec.jsonl');
    const rec = createRecordingProvider({
      inner: stubProvider([
        {
          stopReason: 'end_turn',
          usage: { inputTokens: 3, outputTokens: 2 },
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'hello' }],
        },
      ]),
      outputPath: out,
    });
    const response = await rec.complete(
      { model: 'claude-opus-4-7', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    expect(response.content).toEqual([{ type: 'text', text: 'hello' }]);

    const entries = readJsonl(out);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.role !== 'assistant') throw new Error('expected assistant role');
    expect(entry.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(entry.stopReason).toBe('end_turn');
    expect(entry.model).toBe('claude-opus-4-7');
    // Cache-token fields are absent on this stub response, but the
    // `serverTimestamps` capture (backlog #37) is unconditional.
    expect(entry.usage?.inputTokens).toBe(3);
    expect(entry.usage?.outputTokens).toBe(2);
    expect(entry.usage?.serverTimestamps).toBeDefined();
  });

  test('recordUserTurn appends a user entry', async () => {
    const out = join(tmp, 'rec.jsonl');
    const rec = createRecordingProvider({
      inner: stubProvider([]),
      outputPath: out,
    });
    rec.recordUserTurn('build me an agent');
    const entries = readJsonl(out);
    expect(entries).toEqual([{ role: 'user', text: 'build me an agent' }]);
  });

  test('redacts GitHub PATs from user turns before writing', () => {
    const out = join(tmp, 'rec.jsonl');
    const rec = createRecordingProvider({
      inner: stubProvider([]),
      outputPath: out,
    });
    // 40-char GitHub PAT pattern; matches SECRET_PATTERNS.
    const leaked = `ghp_${'a'.repeat(40)}`;
    rec.recordUserTurn(`use ${leaked} please`);
    const raw = readFileSync(out, 'utf8');
    // Never leaks the raw token.
    expect(raw).not.toContain(leaked);
    // Landed as the redacted placeholder instead.
    expect(raw).toContain('<redacted:GitHub PAT>');
  });

  test('redacts secrets embedded in assistant text blocks on the write path', async () => {
    const out = join(tmp, 'rec.jsonl');
    const leaked = `ghp_${'b'.repeat(40)}`;
    const rec = createRecordingProvider({
      inner: stubProvider([
        {
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'claude-opus-4-7',
          // Worst-case: the LLM quoted the token back. Shouldn't
          // happen because redaction runs before the request is sent,
          // but the recorder must still scrub on the write path.
          content: [{ type: 'text', text: `saw token ${leaked}` }],
        },
      ]),
      outputPath: out,
    });
    await rec.complete(
      { model: 'claude-opus-4-7', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    const raw = readFileSync(out, 'utf8');
    expect(raw).not.toContain(leaked);
    expect(raw).toContain('<redacted:GitHub PAT>');
  });

  test('onWriteError receives errors instead of throwing from complete()', async () => {
    // Force a write failure by pointing at a path whose parent can't
    // be created (a file where a directory is expected).
    const blocker = join(tmp, 'blocker');
    writeFileSync(blocker, 'not a dir');
    const out = join(blocker, 'sub', 'rec.jsonl');
    const errors: Error[] = [];
    const rec = createRecordingProvider({
      inner: stubProvider([
        {
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'x',
          content: [{ type: 'text', text: 'hi' }],
        },
      ]),
      outputPath: out,
      onWriteError: (err) => errors.push(err),
    });
    // Should not throw — the live session must survive a broken recorder.
    const r = await rec.complete(
      { model: 'x', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    expect(r.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('recordingEnabled reads BUILDER_RECORD env', () => {
    expect(recordingEnabled({})).toBe(false);
    expect(recordingEnabled({ BUILDER_RECORD: '0' })).toBe(false);
    expect(recordingEnabled({ BUILDER_RECORD: 'false' })).toBe(false);
    expect(recordingEnabled({ BUILDER_RECORD: '1' })).toBe(true);
    expect(recordingEnabled({ BUILDER_RECORD: 'TRUE' })).toBe(true);
    expect(recordingEnabled({ BUILDER_RECORD: 'on' })).toBe(true);
  });

  test('defaultRecordingPath is portable across filesystems', () => {
    const now = new Date('2026-04-23T14:15:16.789Z');
    const path = defaultRecordingPath('/tmp/fixtures', now);
    // `:` and `.` are stripped so Windows + macOS HFS+ accept the name.
    expect(path).not.toContain(':');
    expect(path.endsWith('.jsonl')).toBe(true);
    expect(path).toContain('recorded-2026-04-23T14-15-16-789Z');
  });

  // ── #36 tool_result capture ──────────────────────────────────────────
  test('captures tool_result blocks into a dedicated toolResults field (#36)', async () => {
    const out = join(tmp, 'rec.jsonl');
    const rec = createRecordingProvider({
      inner: stubProvider([
        {
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'claude-opus-4-7',
          content: [
            { type: 'text', text: 'tool ran' },
            {
              type: 'tool_result',
              toolUseId: 'call-42',
              content: 'ok',
            },
          ],
        },
      ]),
      outputPath: out,
    });
    await rec.complete(
      { model: 'claude-opus-4-7', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    const entries = readJsonl(out);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.role !== 'assistant') throw new Error('expected assistant role');
    // `content` preserves the tool_result — we never strip blocks.
    expect(entry.content.some((c) => c.type === 'tool_result')).toBe(true);
    // AND the dedicated toolResults field is populated for the
    // replay harness to route back into the engine.
    expect(entry.toolResults).toBeDefined();
    expect(entry.toolResults?.[0]?.toolUseId).toBe('call-42');
    expect(entry.toolResults?.[0]?.content).toBe('ok');
  });

  test('omits toolResults field when no tool_result block is present', async () => {
    const out = join(tmp, 'rec.jsonl');
    const rec = createRecordingProvider({
      inner: stubProvider([
        {
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'plain' }],
        },
      ]),
      outputPath: out,
    });
    await rec.complete(
      { model: 'claude-opus-4-7', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    const entries = readJsonl(out);
    const entry = entries[0];
    if (entry?.role !== 'assistant') throw new Error('expected assistant role');
    expect(entry.toolResults).toBeUndefined();
  });

  test('redacts secrets embedded in tool_result block content', async () => {
    const out = join(tmp, 'rec.jsonl');
    const leaked = `ghp_${'c'.repeat(40)}`;
    const rec = createRecordingProvider({
      inner: stubProvider([
        {
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'claude-opus-4-7',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call-leaky',
              content: `token ${leaked} returned`,
            },
          ],
        },
      ]),
      outputPath: out,
    });
    await rec.complete(
      { model: 'claude-opus-4-7', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    const raw = readFileSync(out, 'utf8');
    expect(raw).not.toContain(leaked);
    expect(raw).toContain('<redacted:GitHub PAT>');
  });

  // ── #37 usage field extensions ──────────────────────────────────────
  test('persists cacheCreation + cacheRead tokens + server timestamps (#37)', async () => {
    const out = join(tmp, 'rec.jsonl');
    const clockValues = [
      new Date('2026-04-23T12:00:00.000Z'),
      new Date('2026-04-23T12:00:00.500Z'),
    ];
    let i = 0;
    const rec = createRecordingProvider({
      inner: stubProvider([
        {
          stopReason: 'end_turn',
          // Cast through unknown so the stub can carry the extended
          // cache fields the production provider emits.
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationInputTokens: 500,
            cacheReadInputTokens: 9000,
          } as unknown as LLMResponse['usage'],
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'ok' }],
        },
      ]),
      outputPath: out,
      now: () => {
        // Two calls: firstToken at start, lastToken at end.
        const v = clockValues[Math.min(i, clockValues.length - 1)];
        i += 1;
        if (!v) throw new Error('clock exhausted');
        return v;
      },
    });
    await rec.complete(
      { model: 'claude-opus-4-7', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    const entries = readJsonl(out);
    const entry = entries[0];
    if (entry?.role !== 'assistant') throw new Error('expected assistant role');
    expect(entry.usage?.inputTokens).toBe(10);
    expect(entry.usage?.outputTokens).toBe(20);
    expect(entry.usage?.cacheCreationInputTokens).toBe(500);
    expect(entry.usage?.cacheReadInputTokens).toBe(9000);
    expect(entry.usage?.serverTimestamps?.firstToken).toBe('2026-04-23T12:00:00.000Z');
    expect(entry.usage?.serverTimestamps?.lastToken).toBe('2026-04-23T12:00:00.500Z');
  });

  test('maps legacy cacheReadTokens field onto cacheReadInputTokens on write', async () => {
    // Today's TokenUsage surface exposes `cacheReadTokens`; future
    // drift to Anthropic's native `cacheReadInputTokens` is captured
    // structurally so either name lands in the fixture.
    const out = join(tmp, 'rec.jsonl');
    const rec = createRecordingProvider({
      inner: stubProvider([
        {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            cacheReadTokens: 1234,
          },
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'ok' }],
        },
      ]),
      outputPath: out,
    });
    await rec.complete(
      { model: 'claude-opus-4-7', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    const entries = readJsonl(out);
    const entry = entries[0];
    if (entry?.role !== 'assistant') throw new Error('expected assistant role');
    expect(entry.usage?.cacheReadInputTokens).toBe(1234);
  });

  // ── #38 stable handle + swappable inner ─────────────────────────────
  test('swapInnerProvider preserves the handle identity + output path (#38)', async () => {
    const out = join(tmp, 'rec.jsonl');
    const first = stubProvider([
      {
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'm1',
        content: [{ type: 'text', text: 'first' }],
      },
    ]);
    const second = stubProvider([
      {
        stopReason: 'end_turn',
        usage: { inputTokens: 2, outputTokens: 2 },
        model: 'm2',
        content: [{ type: 'text', text: 'second' }],
      },
    ]);
    const rec = createRecordingProvider({ inner: first, outputPath: out });
    const handleId = rec;

    // First complete() goes through `first`.
    const r1 = await rec.complete(
      { model: 'x', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    expect(r1.model).toBe('m1');

    // Rotate. The outer object reference stays the same.
    const prev = rec.swapInnerProvider(second);
    expect(prev).toBe(first);
    expect(rec).toBe(handleId);
    expect(rec.innerProvider).toBe(second);
    expect(rec.outputPath).toBe(out);

    // Second complete() goes through `second`.
    const r2 = await rec.complete(
      { model: 'x', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    expect(r2.model).toBe('m2');

    // Both lines landed in the same file.
    const entries = readJsonl(out);
    expect(entries).toHaveLength(2);
  });

  test('swapInnerProvider mid-turn: in-flight call uses the pre-swap inner', async () => {
    // Simulate a rebuild that lands mid-turn. The in-flight
    // complete() promise must not retarget the new inner — that
    // would fork the transcript across two providers on a single
    // logical turn.
    const out = join(tmp, 'rec.jsonl');
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const slow: LLMProvider = {
      name: 'slow',
      async complete(): Promise<LLMResponse> {
        await gate;
        return {
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'slow-m',
          content: [{ type: 'text', text: 'slow' }],
        };
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };
    const fast: LLMProvider = {
      name: 'fast',
      async complete(): Promise<LLMResponse> {
        return {
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'fast-m',
          content: [{ type: 'text', text: 'fast' }],
        };
      },
      async countTokens(): Promise<number> {
        return 0;
      },
    };
    const rec = createRecordingProvider({ inner: slow, outputPath: out });
    const inflight = rec.complete(
      { model: 'x', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    // Swap inner while the call is awaiting. Release the slow call.
    rec.swapInnerProvider(fast);
    release();
    const r = await inflight;
    expect(r.model).toBe('slow-m'); // in-flight call uses pre-swap inner
    // A *new* call after swap hits the fast provider.
    const r2 = await rec.complete(
      { model: 'x', system: '', messages: [], tools: [] },
      new AbortController().signal,
    );
    expect(r2.model).toBe('fast-m');
  });

  test('round-trip: record with stub provider, then replay yields same step kinds', async () => {
    // Arrange a scope root that the webhook fixture tools expect.
    const scopeRoot = mkdtempSync(join(tmpdir(), 'declara-rt-scope-'));
    try {
      writeFileSync(
        join(scopeRoot, 'agent.yaml'),
        'name: demo\nmodel: claude-sonnet-4-5\nsystemPrompt: |\n  You are demo.\nskills: []\ntools:\n  defaults:\n    - Read\n',
      );
      mkdirSync(join(scopeRoot, 'skills'));

      const out = join(tmp, 'round-trip.jsonl');
      const rec = createRecordingProvider({
        inner: stubProvider(webhookFleetResponses()),
        outputPath: out,
      });

      // Simulate one full REPL turn: user submit + three assistant
      // completions (text+tool_use, apply tool_use, end_turn text).
      rec.recordUserTurn('build me an agent that triages github webhook events');
      const sig = new AbortController().signal;
      for (let i = 0; i < 3; i += 1) {
        await rec.complete({ model: 'claude-opus-4-7', system: '', messages: [], tools: [] }, sig);
      }

      // Sanity: JSONL is parseable and has four entries.
      const entries = readJsonl(out);
      expect(entries).toHaveLength(4);
      expect(entries[0]?.role).toBe('user');
      expect(entries.slice(1).every((e) => e.role === 'assistant')).toBe(true);

      // Replay through the existing harness with no shim. This is the
      // load-bearing check: the recording format MUST be replayable
      // as-is by `replayFixture`.
      const result = await replayFixture({ fixturePath: out, scopeRoot });
      expect(result.appliedStepKinds).toEqual(['addSource', 'addSkill']);
      expect(result.appliedResults).toHaveLength(1);
      expect(result.appliedResults[0]?.ok).toBe(true);
      expect(result.turnCount).toBe(1);
      expect(result.providerCallCount).toBe(3);
    } finally {
      rmSync(scopeRoot, { recursive: true, force: true });
    }
  });
});

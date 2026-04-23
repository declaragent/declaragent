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
    expect(entry.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
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

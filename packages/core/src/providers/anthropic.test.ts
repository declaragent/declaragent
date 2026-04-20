import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { LLMRequest, LLMResponse } from '../types/llm.js';
import {
  createAnthropicProvider,
  fromAnthropicResponse,
  toAnthropicMessages,
  toAnthropicTools,
} from './anthropic.js';

type FakeClient = Pick<Anthropic, 'messages'>;

function fakeClient(
  createImpl: (
    params: Anthropic.Messages.MessageCreateParams,
  ) => Promise<Anthropic.Messages.Message>,
  countImpl?: () => Promise<{ input_tokens: number }>,
): Anthropic {
  const stub: FakeClient = {
    messages: {
      create: createImpl,
      countTokens: countImpl ?? (async () => ({ input_tokens: 0 })),
    } as unknown as Anthropic['messages'],
  };
  return stub as unknown as Anthropic;
}

const baseRequest: LLMRequest = {
  model: 'claude-opus-4-6',
  system: 'be helpful',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
};

describe('Anthropic translation', () => {
  test('toAnthropicMessages maps roles, text, tool_use, tool_result', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'X', input: { a: 1 } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 't1',
            content: 'ok',
            isError: true,
          },
        ],
      },
    ]);
    // System role dropped.
    expect(out.length).toBe(3);
    expect(out[0]?.role).toBe('user');
    const tu = out[1]?.content as Anthropic.Messages.ContentBlockParam[];
    expect(tu[0]?.type).toBe('tool_use');
    const tr = out[2]?.content as Anthropic.Messages.ContentBlockParam[];
    expect(tr[0]?.type).toBe('tool_result');
    expect(tr[0]?.type === 'tool_result' && (tr[0] as { is_error?: boolean }).is_error).toBe(true);
  });

  test('toAnthropicTools renames inputSchema → input_schema', () => {
    const out = toAnthropicTools([
      {
        name: 'Read',
        description: 'd',
        inputSchema: { type: 'object' },
      },
    ]);
    expect(out[0]?.name).toBe('Read');
    expect((out[0] as unknown as { input_schema: unknown }).input_schema).toEqual({
      type: 'object',
    });
  });

  test('fromAnthropicResponse maps stop_reason, usage, content', () => {
    const sdkMsg: Anthropic.Messages.Message = {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
      } as Anthropic.Messages.Usage,
      content: [
        { type: 'text', text: 'thinking', citations: [] },
        { type: 'tool_use', id: 't1', name: 'X', input: { y: 2 } },
      ],
    } as Anthropic.Messages.Message;
    const out: LLMResponse = fromAnthropicResponse(sdkMsg);
    expect(out.stopReason).toBe('tool_use');
    expect(out.usage.inputTokens).toBe(100);
    expect(out.usage.outputTokens).toBe(20);
    expect(out.usage.cacheReadTokens).toBe(5);
    expect(out.content.length).toBe(2);
    expect(out.content[0]?.type).toBe('text');
    expect(out.content[1]?.type).toBe('tool_use');
  });

  test('fromAnthropicResponse drops unknown content block types', () => {
    const sdkMsg = {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'thinking', thinking: 'private', signature: 'sig' },
        { type: 'text', text: 'visible', citations: [] },
      ],
    } as unknown as Anthropic.Messages.Message;
    const out = fromAnthropicResponse(sdkMsg);
    expect(out.content.length).toBe(1);
    expect(out.content[0]?.type).toBe('text');
  });
});

describe('AnthropicProvider', () => {
  test('complete forwards translated params and returns mapped response', async () => {
    let captured: Anthropic.Messages.MessageCreateParams | undefined;
    const provider = createAnthropicProvider({
      client: fakeClient(async (params) => {
        captured = params;
        return {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 3 },
          content: [{ type: 'text', text: 'pong', citations: [] }],
        } as unknown as Anthropic.Messages.Message;
      }),
    });
    const ac = new AbortController();
    const out = await provider.complete(baseRequest, ac.signal);
    expect(out.stopReason).toBe('end_turn');
    expect(out.usage.inputTokens).toBe(7);
    expect(out.content[0]?.type).toBe('text');
    expect(captured?.model).toBe('claude-opus-4-6');
    expect(captured?.system).toBe('be helpful');
    expect(captured?.max_tokens).toBeGreaterThan(0);
  });

  test('complete retries on a 503 and then succeeds', async () => {
    let calls = 0;
    const provider = createAnthropicProvider({
      client: fakeClient(async () => {
        calls += 1;
        if (calls < 2) {
          throw Object.assign(new Error('boom'), { status: 503 });
        }
        return {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'text', text: 'ok', citations: [] }],
        } as unknown as Anthropic.Messages.Message;
      }),
      retry: { baseDelayMs: 1, maxDelayMs: 5 },
    });
    const ac = new AbortController();
    const out = await provider.complete(baseRequest, ac.signal);
    expect(calls).toBe(2);
    expect(out.content[0]?.type).toBe('text');
  });

  test('complete does not retry 4xx', async () => {
    let calls = 0;
    const provider = createAnthropicProvider({
      client: fakeClient(async () => {
        calls += 1;
        throw Object.assign(new Error('bad'), { status: 400 });
      }),
      retry: { baseDelayMs: 1, maxDelayMs: 5 },
    });
    await expect(
      provider.complete(baseRequest, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  test('accepts authToken in config (Bearer auth path)', () => {
    // Smoke test: constructor accepts the field without throwing.
    // Real Bearer behavior is the SDK's job.
    expect(() => createAnthropicProvider({ authToken: 'sk-ant-oat01-fake' })).not.toThrow();
  });

  test('countTokens delegates to SDK and returns input_tokens', async () => {
    const provider = createAnthropicProvider({
      client: fakeClient(
        async () => ({}) as Anthropic.Messages.Message,
        async () => ({ input_tokens: 42 }),
      ),
    });
    const tokens = await provider.countTokens([
      { role: 'user', content: [{ type: 'text', text: 'count me' }] },
    ]);
    expect(tokens).toBe(42);
  });
});

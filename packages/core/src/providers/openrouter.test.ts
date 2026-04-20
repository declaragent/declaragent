import { describe, expect, test } from 'bun:test';
import type { LLMRequest } from '../types/llm.js';
import type { Message } from '../types/messages.js';
import {
  createOpenRouterProvider,
  fromOpenAIResponse,
  toOpenAIMessages,
  toOpenAITools,
} from './openrouter.js';

describe('toOpenAIMessages', () => {
  test('text user → simple user message', () => {
    const out = toOpenAIMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('assistant text → assistant message with content string', () => {
    const out = toOpenAIMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(out).toEqual([{ role: 'assistant', content: 'hello' }]);
  });

  test('assistant tool_use → tool_calls array, content nullable', () => {
    const out = toOpenAIMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/a' } },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('assistant');
    expect(out[0]?.content).toBe('thinking');
    expect(out[0]?.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'Read', arguments: '{"path":"/a"}' },
      },
    ]);
  });

  test('user tool_result → standalone role:tool messages preceding any text', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call_1', content: 'ok' },
          { type: 'tool_result', toolUseId: 'call_2', content: 'oops', isError: true },
          { type: 'text', text: 'and now please continue' },
        ],
      },
    ];
    const out = toOpenAIMessages(messages);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'ok' });
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: 'oops' });
    expect(out[2]).toEqual({ role: 'user', content: 'and now please continue' });
  });

  test('drops system role (caller hoists into messages[0])', () => {
    const out = toOpenAIMessages([
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });
});

describe('toOpenAITools', () => {
  test('wraps each tool in {type: function, function: {...}}', () => {
    const out = toOpenAITools([
      {
        name: 'Read',
        description: 'read a file',
        inputSchema: { type: 'object' },
      },
    ]);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'Read',
          description: 'read a file',
          parameters: { type: 'object' },
        },
      },
    ]);
  });
});

describe('fromOpenAIResponse', () => {
  test('text choice → end_turn with single text content block', () => {
    const out = fromOpenAIResponse({
      id: 'r',
      model: 'openai/gpt-4o',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    expect(out.stopReason).toBe('end_turn');
    expect(out.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(out.model).toBe('openai/gpt-4o');
  });

  test('tool_calls → tool_use blocks with parsed arguments', () => {
    const out = fromOpenAIResponse({
      id: 'r',
      model: 'openai/gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'Read', arguments: '{"path":"/a"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(out.stopReason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/a' } },
    ]);
  });

  test('text + tool_calls → both content blocks emitted', () => {
    const out = fromOpenAIResponse({
      id: 'r',
      model: 'openai/gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'let me check',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'Read', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(out.content).toHaveLength(2);
    expect(out.content[0]?.type).toBe('text');
    expect(out.content[1]?.type).toBe('tool_use');
  });

  test('finish_reason length → max_tokens', () => {
    const out = fromOpenAIResponse({
      id: 'r',
      model: 'm',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'length' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect(out.stopReason).toBe('max_tokens');
  });

  test('handles unparseable tool arguments by passing the raw string', () => {
    const out = fromOpenAIResponse({
      id: 'r',
      model: 'm',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c',
                type: 'function',
                function: { name: 'X', arguments: 'not-json' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    });
    const block = out.content[0];
    expect(block?.type).toBe('tool_use');
    if (block?.type === 'tool_use') {
      expect(block.input).toBe('not-json');
    }
  });
});

describe('createOpenRouterProvider.complete', () => {
  const baseRequest: LLMRequest = {
    model: 'openai/gpt-4o-mini',
    system: 'be helpful',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
  };

  test('POSTs to /chat/completions with Bearer auth and parsed body', async () => {
    let captured: { url: string; init: RequestInit } = {
      url: '',
      init: {},
    };
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          id: 'r',
          model: 'openai/gpt-4o-mini',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'pong' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = createOpenRouterProvider({
      apiKey: 'sk-or-test',
      fetchImpl: fakeFetch,
      referrer: 'https://example.test',
      title: 'test',
    });
    const out = await provider.complete(baseRequest, new AbortController().signal);
    expect(out.stopReason).toBe('end_turn');
    expect(captured.url).toContain('/chat/completions');
    const headers = (captured.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-or-test');
    expect(headers['HTTP-Referer']).toBe('https://example.test');
    expect(headers['X-Title']).toBe('test');
    const body = JSON.parse(String(captured.init.body ?? '{}'));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be helpful' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  test('non-2xx surfaces status on the thrown error', async () => {
    const fakeFetch = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const provider = createOpenRouterProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 },
    });
    await expect(
      provider.complete(baseRequest, new AbortController().signal),
    ).rejects.toMatchObject({ status: 401 });
  });

  test('retries on 503 and then succeeds', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      if (calls < 2) return new Response('busy', { status: 503 });
      return new Response(
        JSON.stringify({
          id: 'r',
          model: 'm',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const provider = createOpenRouterProvider({
      apiKey: 'k',
      fetchImpl: fakeFetch,
      retry: { baseDelayMs: 1, maxDelayMs: 5 },
    });
    const out = await provider.complete(baseRequest, new AbortController().signal);
    expect(calls).toBe(2);
    expect(out.content[0]?.type).toBe('text');
  });
});

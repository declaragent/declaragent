import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMRequest, LLMResponse, LLMToolDefinition } from '../types/llm.js';
import type { Message, MessageContent, StopReason } from '../types/messages.js';
import { type RetryConfig, withRetry } from './retry.js';

export const DEFAULT_MAX_TOKENS = 4_096;

export interface AnthropicProviderConfig {
  apiKey?: string;
  /**
   * Bearer token (passed to the SDK's `authToken`). Used for OAuth-issued
   * tokens or any flow that returns a Bearer credential. Takes precedence
   * over `apiKey` when both are set.
   */
  authToken?: string;
  baseURL?: string;
  /** Model used by `countTokens` when none is supplied via request context. */
  defaultModel?: string;
  /** Inject a pre-built (or test-stub) client. */
  client?: Anthropic;
  retry?: Partial<RetryConfig>;
}

type AnthropicMessageParam = Anthropic.Messages.MessageParam;
type AnthropicContentBlockParam = Anthropic.Messages.ContentBlockParam;
type AnthropicMessage = Anthropic.Messages.Message;
type AnthropicToolParam = Anthropic.Messages.Tool;

function toContentBlockParam(c: MessageContent): AnthropicContentBlockParam {
  switch (c.type) {
    case 'text':
      return { type: 'text', text: c.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.input as Record<string, unknown>,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: c.toolUseId,
        content: c.content,
        ...(c.isError === true && { is_error: true }),
      };
  }
}

export function toAnthropicMessages(messages: Message[]): AnthropicMessageParam[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content.map(toContentBlockParam),
    }));
}

export function toAnthropicTools(tools: LLMToolDefinition[]): AnthropicToolParam[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as AnthropicToolParam['input_schema'],
  }));
}

function fromContentBlock(block: AnthropicMessage['content'][number]): MessageContent | null {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  // Thinking, server_tool_use, etc. — surface as nothing for v0.1.
  return null;
}

function mapStopReason(reason: AnthropicMessage['stop_reason']): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

export function fromAnthropicResponse(response: AnthropicMessage): LLMResponse {
  const content: MessageContent[] = [];
  for (const block of response.content) {
    const mapped = fromContentBlock(block);
    if (mapped) content.push(mapped);
  }
  return {
    content,
    stopReason: mapStopReason(response.stop_reason),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens != null && {
        cacheReadTokens: response.usage.cache_read_input_tokens,
      }),
    },
    model: response.model,
  };
}

function buildCreateParams(request: LLMRequest): Anthropic.Messages.MessageCreateParams {
  return {
    model: request.model,
    system: request.system,
    messages: toAnthropicMessages(request.messages),
    tools: toAnthropicTools(request.tools),
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(request.temperature !== undefined && {
      temperature: request.temperature,
    }),
    ...(request.toolChoice && {
      tool_choice: { type: request.toolChoice },
    }),
  };
}

export function createAnthropicProvider(config: AnthropicProviderConfig = {}): LLMProvider {
  const client =
    config.client ??
    new Anthropic({
      ...(config.authToken !== undefined && { authToken: config.authToken }),
      ...(config.apiKey !== undefined && { apiKey: config.apiKey }),
      ...(config.baseURL !== undefined && { baseURL: config.baseURL }),
    });
  const defaultModel = config.defaultModel ?? 'claude-opus-4-6';

  return {
    name: 'anthropic',
    async complete(request, signal): Promise<LLMResponse> {
      return withRetry(
        async () => {
          const response = await client.messages.create(
            { ...buildCreateParams(request), stream: false },
            { signal },
          );
          return fromAnthropicResponse(response);
        },
        config.retry,
        signal,
      );
    },
    async countTokens(messages): Promise<number> {
      const result = await client.messages.countTokens({
        model: defaultModel,
        messages: toAnthropicMessages(messages),
      });
      return result.input_tokens;
    },
  };
}

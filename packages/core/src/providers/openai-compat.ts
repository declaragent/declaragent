import type { LLMProvider, LLMRequest, LLMResponse, LLMToolDefinition } from '../types/llm.js';
import type { Message, MessageContent, StopReason } from '../types/messages.js';
import { type RetryConfig, withRetry } from './retry.js';

export const DEFAULT_OPENAI_COMPAT_MAX_TOKENS = 4_096;

/**
 * Generic provider for any backend that speaks the OpenAI Chat Completions
 * wire format at `<baseURL>/chat/completions`. Used for OpenAI itself,
 * OpenRouter, Groq, DeepSeek, Together, Mistral, xAI, Ollama, LM Studio,
 * llama.cpp, etc. — most modern LLM endpoints.
 */
export interface OpenAICompatConfig {
  /** Base URL up to and including the API version (e.g. `/v1`). */
  baseURL: string;
  /** Bearer token. Some local endpoints (Ollama) accept any value or empty. */
  apiKey: string;
  /** Extra headers (e.g. `HTTP-Referer`/`X-Title` for OpenRouter). */
  headers?: Record<string, string>;
  retry?: Partial<RetryConfig>;
  fetchImpl?: typeof fetch;
}

// ---- OpenAI ChatCompletions wire types (subset we use) ----

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAICreateParams {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  tool_choice?: 'auto' | 'none' | 'required';
  temperature?: number;
  max_tokens: number;
  stream?: false;
}

interface OpenAIChoice {
  index: number;
  message: { role: string; content: string | null; tool_calls?: OpenAIToolCall[] };
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string | null;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ---- Translation: ours → OpenAI ----

export function toOpenAITools(tools: LLMToolDefinition[]): OpenAIToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Convert our Message[] (Anthropic-shaped) into OpenAI's flatter shape:
 *  - assistant `tool_use` content blocks → `tool_calls[]` on assistant message
 *  - user `tool_result` content blocks → separate `role: 'tool'` messages
 *  - text blocks join into the message `content` string
 *
 * `system` is hoisted by the caller into a leading system message.
 */
export function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const textParts: string[] = [];
    const toolUses: Extract<MessageContent, { type: 'tool_use' }>[] = [];
    const toolResults: Extract<MessageContent, { type: 'tool_result' }>[] = [];
    for (const c of m.content) {
      if (c.type === 'text') textParts.push(c.text);
      else if (c.type === 'tool_use') toolUses.push(c);
      else if (c.type === 'tool_result') toolResults.push(c);
    }
    if (m.role === 'user' && toolResults.length > 0) {
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: tr.content,
        });
      }
    }
    if (m.role === 'user') {
      const text = textParts.join('\n');
      if (text) out.push({ role: 'user', content: text });
      continue;
    }
    const msg: OpenAIMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
    };
    if (toolUses.length > 0) {
      msg.tool_calls = toolUses.map((tu) => ({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments: JSON.stringify(tu.input ?? {}),
        },
      }));
    }
    out.push(msg);
  }
  return out;
}

function buildCreateParams(request: LLMRequest): OpenAICreateParams {
  const messages: OpenAIMessage[] = [];
  if (request.system) {
    messages.push({ role: 'system', content: request.system });
  }
  messages.push(...toOpenAIMessages(request.messages));
  const params: OpenAICreateParams = {
    model: request.model,
    messages,
    max_tokens: request.maxTokens ?? DEFAULT_OPENAI_COMPAT_MAX_TOKENS,
    stream: false,
  };
  if (request.tools.length > 0) params.tools = toOpenAITools(request.tools);
  if (request.temperature !== undefined) params.temperature = request.temperature;
  if (request.toolChoice === 'auto' || request.toolChoice === 'none') {
    params.tool_choice = request.toolChoice;
  } else if (request.toolChoice === 'any') {
    params.tool_choice = 'required';
  }
  return params;
}

// ---- Translation: OpenAI → ours ----

function mapFinishReason(reason: OpenAIChoice['finish_reason']): StopReason {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'stop_sequence';
  return 'end_turn';
}

export function fromOpenAIResponse(response: OpenAIResponse): LLMResponse {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error('OpenAI-compat response had no choices');
  }
  const content: MessageContent[] = [];
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: unknown;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = tc.function.arguments;
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }
  return {
    content,
    stopReason: mapFinishReason(choice.finish_reason),
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
    model: response.model,
  };
}

// ---- Provider ----

export function createOpenAICompatProvider(config: OpenAICompatConfig): LLMProvider {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    name: 'openai-compat',
    async complete(request, signal): Promise<LLMResponse> {
      return withRetry(
        async () => {
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
            ...(config.headers ?? {}),
          };

          const response = await fetchImpl(`${config.baseURL}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(buildCreateParams(request)),
            signal,
          });
          if (!response.ok) {
            const body = await response.text().catch(() => '');
            const err = new Error(
              `OpenAI-compat ${response.status}: ${body || response.statusText}`,
            ) as Error & { status: number };
            err.status = response.status;
            throw err;
          }
          const body = (await response.json()) as OpenAIResponse;
          return fromOpenAIResponse(body);
        },
        config.retry,
        signal,
      );
    },
    async countTokens(_messages: Message[]): Promise<number> {
      return 0;
    },
  };
}

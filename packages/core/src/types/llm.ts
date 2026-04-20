import type { Message, MessageContent, StopReason, TokenUsage } from './messages.js';
import type { JSONSchema } from './tool.js';

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface LLMRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: LLMToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  toolChoice?: 'auto' | 'any' | 'none';
}

export type LLMStreamChunk =
  | { type: 'content_block_delta'; index: number; delta: MessageContent }
  | { type: 'content_block'; index: number; block: MessageContent }
  | { type: 'message_stop'; stopReason: StopReason; usage: TokenUsage };

export interface LLMResponse {
  content: MessageContent[];
  stopReason: StopReason;
  usage: TokenUsage;
  model: string;
}

export interface LLMProvider {
  name: string;
  complete(request: LLMRequest, signal: AbortSignal): Promise<LLMResponse>;
  stream?(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMStreamChunk>;
  countTokens(messages: Message[]): Promise<number>;
}

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError?: boolean;
    };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface MessageMeta {
  model?: string;
  stopReason?: StopReason;
  usage?: TokenUsage;
}

export interface Message {
  role: Role;
  content: MessageContent[];
  meta?: MessageMeta;
}

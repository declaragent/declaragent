import type { Message } from './messages.js';
import type { SessionHandle } from './session.js';

export type RunStopReason =
  | 'end_turn'
  | 'max_iterations'
  | 'aborted'
  | 'error'
  | 'permission_escalated';

export interface TurnContext {
  sessionId: string;
  turnId: string;
  depth: number;
  causedBy?: string;
}

export interface RunAgentInput {
  session: SessionHandle;
  userMessage: string;
  abortSignal?: AbortSignal;
  depth?: number;
  causedBy?: string;
}

export interface RunAgentResult {
  stopReason: RunStopReason;
  usage: { inputTokens: number; outputTokens: number };
  lastAssistantMessage?: Message;
  error?: Error;
}

export type RunAgent = (input: RunAgentInput) => Promise<RunAgentResult>;

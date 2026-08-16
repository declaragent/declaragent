import type { Message } from './messages.js';
import type { SessionHandle } from './session.js';

export type RunStopReason =
  | 'end_turn'
  | 'max_iterations'
  | 'aborted'
  | 'error'
  | 'permission_escalated'
  /**
   * The turn halted because the tenant's `dailyTokenUSD` spend cap was reached.
   * The dollar brake is fail-closed: no further LLM calls are made once the cap
   * trips. @since 0.7.6 — production-readiness WS8
   */
  | 'quota_exceeded';

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
  /**
   * WS8 — end-user subject this turn runs on behalf of (the channel principal's
   * `platformUserId`). Threaded into `ToolContext.subject` so subject-scoped
   * tools (long-term memory) isolate one end-user's data from another within
   * the same agent + tenant. Undefined for non-channel triggers (cron, webhook
   * without a user) → no subject partition.
   */
  subject?: string;
}

export interface RunAgentResult {
  stopReason: RunStopReason;
  usage: { inputTokens: number; outputTokens: number };
  lastAssistantMessage?: Message;
  error?: Error;
}

export type RunAgent = (input: RunAgentInput) => Promise<RunAgentResult>;

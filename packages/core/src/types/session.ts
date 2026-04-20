import type { Message } from './messages.js';

/** @since 1.0.0 */
export interface SessionLedger {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  estimatedCostUSD: number;
}

/**
 * Minimal AgentSpec stub. The full shape is defined in Phase 2+ when
 * the YAML loader lands; the engine loop only needs these fields.
 *
 * @since 1.0.0
 */
export interface AgentSpec {
  name: string;
  model: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  subagentDepthCap?: number;
}

/** @since 1.0.0 */
export type TurnStatus = 'ok' | 'error' | 'aborted';

/** @since 1.0.0 */
export interface SessionHandle {
  readonly id: string;
  readonly spec: AgentSpec;
  readonly transcript: ReadonlyArray<Message>;
  appendMessage(m: Message): Promise<void>;
  ledger(): SessionLedger;
  markTurn(turnId: string, status: TurnStatus): Promise<void>;
  /**
   * Patch the spec in place. Used for mid-session changes like swapping the
   * model or system prompt. The transcript is preserved.
   */
  updateSpec(patch: Partial<AgentSpec>): Promise<void>;
}

import type { RunAgentResult, TurnContext } from './agent.js';
import type { Message } from './messages.js';
import type { CompletedToolCall, PendingToolCall, ToolError } from './tool.js';

export interface ToolCallOverride {
  output?: unknown;
  error?: ToolError;
}

export interface LoopHooks {
  onTurnStart?: (ctx: TurnContext) => void | Promise<void>;
  onTurnEnd?: (ctx: TurnContext, result: RunAgentResult) => void | Promise<void>;
  onToolCallBefore?: (
    call: PendingToolCall,
  ) => ToolCallOverride | undefined | Promise<ToolCallOverride | undefined>;
  onToolCallAfter?: (call: CompletedToolCall) => void | Promise<void>;
  onCompactBefore?: (transcript: Message[]) => void | Promise<void>;
}

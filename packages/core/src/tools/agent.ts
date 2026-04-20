import type { Message } from '../types/messages.js';
import type { Tool } from '../types/tool.js';

export interface AgentInput {
  description: string;
  prompt: string;
}

export interface AgentOutput {
  result: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  depth: number;
}

function extractText(message: Message | undefined): string {
  if (!message) return '';
  return message.content
    .filter((c): c is Extract<Message['content'][number], { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export const Agent: Tool<AgentInput, AgentOutput> = {
  name: 'Agent',
  description:
    'Spawn a sub-agent with an isolated transcript. The sub-agent runs the given `prompt` to completion and returns its final assistant message. Sub-agents cannot recurse beyond the configured depth cap.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short label for this sub-agent invocation.',
      },
      prompt: {
        type: 'string',
        description: 'The task the sub-agent should complete.',
      },
    },
    required: ['description', 'prompt'],
  },
  permissionKey: ({ description }) => description,
  async *execute(input, ctx) {
    if (!ctx.createChildSession) {
      yield {
        type: 'error',
        error: {
          code: 'ENOSESSION',
          message: 'Engine did not supply createChildSession; cannot spawn sub-agent',
        },
      };
      return;
    }
    const childSession = ctx.createChildSession();
    const childDepth = ctx.depth + 1;
    ctx.logger.info('subagent.start', {
      description: input.description,
      depth: childDepth,
      childSessionId: childSession.id,
    });

    // Phase 6 slice-2 correlation-id audit: propagate the parent's
    // correlation id so the full causal chain (originating event →
    // parent session → sub-agent → grandchild) shares a single id. Fall
    // back to the parent session id when the parent turn wasn't triggered
    // by an event (REPL, direct runAgent call).
    const result = await ctx.runAgent({
      session: childSession,
      userMessage: input.prompt,
      depth: childDepth,
      abortSignal: ctx.abortSignal,
      causedBy: ctx.correlationId ?? ctx.session.id,
    });

    ctx.logger.info('subagent.end', {
      description: input.description,
      stopReason: result.stopReason,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });

    if (result.error) {
      yield {
        type: 'error',
        error: {
          code: 'ESUBAGENT',
          message: result.error.message,
          cause: result.error,
        },
      };
      return;
    }

    yield {
      type: 'result',
      output: {
        result: extractText(result.lastAssistantMessage),
        stopReason: result.stopReason,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        depth: childDepth,
      },
    };
  },
};

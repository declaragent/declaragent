import { createPermissionGate } from '../permission/gate.js';
import type { Logger } from '../types/logger.js';
import type { AgentSpec, SessionHandle } from '../types/session.js';
import type { ToolContext, ToolEvent } from '../types/tool.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

const STUB_SPEC: AgentSpec = {
  name: 'test-agent',
  model: 'claude-opus-4-6',
  systemPrompt: 'you are a test',
};

function stubSession(id = 'test-session'): SessionHandle {
  return {
    id,
    spec: STUB_SPEC,
    transcript: [],
    appendMessage: async () => {},
    ledger: () => ({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      turns: 0,
      estimatedCostUSD: 0,
    }),
    markTurn: async () => {},
    updateSpec: async () => {},
  };
}

export function makeToolContext(overrides?: Partial<ToolContext>): ToolContext {
  const abortController = new AbortController();
  return {
    session: overrides?.session ?? stubSession(),
    permissions: overrides?.permissions ?? createPermissionGate({ mode: 'bypass', rules: [] }),
    abortSignal: overrides?.abortSignal ?? abortController.signal,
    depth: overrides?.depth ?? 0,
    runAgent:
      overrides?.runAgent ??
      (async () => ({
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
    logger: overrides?.logger ?? NOOP_LOGGER,
  };
}

export async function collectToolEvents<O>(iter: AsyncIterable<ToolEvent<O>>): Promise<{
  progress: string[];
  result?: O;
  error?: { message: string; code?: string };
}> {
  const progress: string[] = [];
  let result: O | undefined;
  let error: { message: string; code?: string } | undefined;
  for await (const event of iter) {
    if (event.type === 'progress') progress.push(event.message);
    if (event.type === 'result') result = event.output;
    if (event.type === 'error') {
      error = { message: event.error.message };
      if (event.error.code !== undefined) error.code = event.error.code;
    }
  }
  const out: {
    progress: string[];
    result?: O;
    error?: { message: string; code?: string };
  } = { progress };
  if (result !== undefined) out.result = result;
  if (error !== undefined) out.error = error;
  return out;
}

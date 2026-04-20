/**
 * Test-only helpers. Not re-exported from the package entry point; tests
 * inside this package can import from `./test-helpers.js` but external
 * consumers must not.
 */

import type {
  AgentSpec,
  Logger,
  PermissionGate,
  SessionHandle,
  ToolContext,
  ToolEvent,
} from '@declaragent/core';

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

const STUB_PERMS: PermissionGate = {
  mode: 'bypass',
  check: async () => ({ outcome: 'allow' as const }),
  recordDenial() {},
  denialsInSession: () => 0,
  scope(): PermissionGate {
    return STUB_PERMS;
  },
};

export function makeStubSession(id = 'test-session'): SessionHandle {
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
  return {
    session: overrides?.session ?? makeStubSession(),
    permissions: overrides?.permissions ?? STUB_PERMS,
    abortSignal: overrides?.abortSignal ?? new AbortController().signal,
    depth: overrides?.depth ?? 0,
    runAgent:
      overrides?.runAgent ??
      (async () => ({
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      })),
    logger: overrides?.logger ?? NOOP_LOGGER,
    ...(overrides?.tenant !== undefined && { tenant: overrides.tenant }),
    ...(overrides?.correlationId !== undefined && { correlationId: overrides.correlationId }),
    ...(overrides?.respond !== undefined && { respond: overrides.respond }),
  };
}

export async function collectEvents<O>(iter: AsyncIterable<ToolEvent<O>>): Promise<{
  progress: string[];
  result?: O;
  error?: { message: string; code?: string };
}> {
  const out: {
    progress: string[];
    result?: O;
    error?: { message: string; code?: string };
  } = { progress: [] };
  for await (const ev of iter) {
    if (ev.type === 'progress') out.progress.push(ev.message);
    if (ev.type === 'result') out.result = ev.output;
    if (ev.type === 'error') {
      out.error = { message: ev.error.message };
      if (ev.error.code !== undefined) out.error.code = ev.error.code;
    }
  }
  return out;
}

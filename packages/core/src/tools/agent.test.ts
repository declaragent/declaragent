import { describe, expect, test } from 'bun:test';
import { createEngine } from '../engine/engine.js';
import { createPermissionGate } from '../permission/gate.js';
import { FakeProvider } from '../testing/fake-provider.js';
import { createMemorySession } from '../testing/memory-session.js';
import type { LLMResponse } from '../types/llm.js';
import { Agent } from './agent.js';

function textResponse(text: string): LLMResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 3 },
    model: 'claude-opus-4-6',
  };
}

function toolCall(id: string, name: string, input: unknown): LLMResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage: { inputTokens: 5, outputTokens: 5 },
    model: 'claude-opus-4-6',
  };
}

describe('Agent tool', () => {
  test('spawns a sub-agent, runs it, and returns the last assistant text', async () => {
    // Parent: calls Agent once, then wraps up.
    // Sub-agent: emits one text response.
    const provider = new FakeProvider([
      // depth 0 → calls Agent
      toolCall('a-1', 'Agent', {
        description: 'summarize',
        prompt: 'summarize this',
      }),
      // depth 1 → sub-agent responds
      textResponse('sub-agent says hi'),
      // depth 0 → final wrap-up after tool_result appended
      textResponse('parent done'),
    ]);
    const engine = createEngine({
      provider,
      tools: [Agent],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      createChildSession: () => createMemorySession({ id: 'child' }),
    });
    const session = createMemorySession({ id: 'parent' });

    const result = await engine.runAgent({ session, userMessage: 'go' });
    expect(result.stopReason).toBe('end_turn');

    // Tool result should contain "sub-agent says hi".
    const toolResultMsg = session.transcript[2];
    const block = toolResultMsg?.content[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type === 'tool_result') {
      expect(block.content).toContain('sub-agent says hi');
    }
  });

  test('enforces depth cap via engine', async () => {
    // Parent spawns Agent; sub-agent at depth=1 tries to spawn another Agent
    // (depth=2 — still ok with default cap of 2). Third level (depth=3)
    // should fail.
    // LLM calls fire in execution order (depth-first), not by-depth:
    const provider = new FakeProvider([
      // depth 0 → call Agent
      toolCall('a-1', 'Agent', { description: 'l1', prompt: 'go' }),
      // depth 1 → call Agent
      toolCall('a-2', 'Agent', { description: 'l2', prompt: 'go' }),
      // depth 2 → call Agent (tool attempts depth 3 → depth cap exceeded)
      toolCall('a-3', 'Agent', { description: 'l3', prompt: 'go' }),
      // depth 2 → after error tool_result, wrap up
      textResponse('l2 done'),
      // depth 1 → after sub-agent returns, wrap up
      textResponse('l1 done'),
      // depth 0 → after sub-agent returns, wrap up
      textResponse('root done'),
    ]);

    const engine = createEngine({
      provider,
      tools: [Agent],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      createChildSession: () => createMemorySession({ spec: { subagentDepthCap: 2 } }),
    });
    const session = createMemorySession({
      id: 'root',
      spec: { subagentDepthCap: 2 },
    });

    const result = await engine.runAgent({ session, userMessage: 'recurse' });
    expect(result.stopReason).toBe('end_turn');
    // All 6 responses consumed.
    expect(provider.callCount).toBe(6);
  });

  test('sub-agent inherits parent correlationId via causedBy (Phase 6 audit)', async () => {
    // When a parent turn was triggered with `causedBy: "evt-root"`, the
    // spawn should thread `causedBy: "evt-root"` to the child — not
    // re-root on the parent session id. That keeps the whole chain on a
    // single correlation id for tracing + audit.
    const capturedCausedBy: (string | undefined)[] = [];
    const provider = new FakeProvider([
      // depth 0: spawn sub-agent
      toolCall('a-1', 'Agent', { description: 'x', prompt: 'sub' }),
      // depth 1: sub-agent text response
      textResponse('child ok'),
      // depth 0: wrap-up
      textResponse('parent done'),
    ]);
    // Capture the causedBy the child turn sees by wrapping runAgent via a
    // custom provider spy. The child's first LLM call happens inside
    // runAgent(depth=1); its meta is the engine input's causedBy, which
    // we observe through a bus subscription.
    const { createEventBus } = await import('../events/bus.js');
    const bus = createEventBus();
    bus.subscribe('turn.started', (e) => {
      capturedCausedBy.push(e.meta?.causedBy);
    });
    const engine = createEngine({
      provider,
      tools: [Agent],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      createChildSession: () => createMemorySession({ id: 'child' }),
      bus,
    });
    const parentSession = createMemorySession({ id: 'parent' });
    await engine.runAgent({ session: parentSession, userMessage: 'go', causedBy: 'evt-root' });
    await bus.drained();

    // Two turn.started events — one for the parent (causedBy=evt-root),
    // one for the child (should also be evt-root after the audit fix).
    expect(capturedCausedBy).toHaveLength(2);
    expect(capturedCausedBy[0]).toBe('evt-root');
    expect(capturedCausedBy[1]).toBe('evt-root');
  });

  test('ENOSESSION when engine does not supply createChildSession', async () => {
    const provider = new FakeProvider([
      toolCall('a-1', 'Agent', { description: 'x', prompt: 'x' }),
      textResponse('recovered'),
    ]);
    const engine = createEngine({
      provider,
      tools: [Agent],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();
    await engine.runAgent({ session, userMessage: 'go' });
    const block = session.transcript[2]?.content[0];
    expect(block?.type === 'tool_result' && block.isError).toBe(true);
    expect(block?.type === 'tool_result' && block.content).toContain('ENOSESSION');
  });
});

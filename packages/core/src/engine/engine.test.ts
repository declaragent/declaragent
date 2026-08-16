import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createEventBus } from '../events/bus.js';
import { createMailbox } from '../events/mailbox.js';
import type { AgentEvent } from '../events/types.js';
import { createPrometheusRegistry } from '../observability/prometheus.js';
import { createPermissionGate } from '../permission/gate.js';
import { createQuotaTracker } from '../tenancy/quota.js';
import { FakeProvider } from '../testing/fake-provider.js';
import { createMemorySession } from '../testing/memory-session.js';
import { Read } from '../tools/read.js';
import type { LLMProvider, LLMResponse } from '../types/llm.js';
import type { Tool } from '../types/tool.js';
import type { AssistantFinalPayload, TurnStartedPayload } from './engine.js';
import { createEngine } from './engine.js';

function textResponse(text: string, usage = { inputTokens: 10, outputTokens: 5 }): LLMResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage,
    model: 'claude-opus-4-6',
  };
}

function toolCallResponse(
  id: string,
  name: string,
  input: unknown,
  usage = { inputTokens: 10, outputTokens: 15 },
): LLMResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage,
    model: 'claude-opus-4-6',
  };
}

describe('engine loop', () => {
  test('text-only turn: user → assistant → end_turn', async () => {
    const provider = new FakeProvider([textResponse('hello back')]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();

    const result = await engine.runAgent({ session, userMessage: 'hi' });

    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(provider.callCount).toBe(1);
    expect(session.transcript.length).toBe(2); // user + assistant
    expect(session.transcript[0]?.role).toBe('user');
    expect(session.transcript[1]?.role).toBe('assistant');
  });

  test('tool call: permission allowed, tool executes, result appended, loop continues', async () => {
    const provider = new FakeProvider([
      toolCallResponse('call-1', 'Read', { path: '/nonexistent' }),
      textResponse('done'),
    ]);
    const engine = createEngine({
      provider,
      tools: [Read],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();

    const result = await engine.runAgent({ session, userMessage: 'read it' });

    expect(result.stopReason).toBe('end_turn');
    expect(provider.callCount).toBe(2);
    expect(session.transcript.length).toBe(4); // user, assistant(tool_use), user(tool_result), assistant(text)
    const toolResultMsg = session.transcript[2];
    expect(toolResultMsg?.role).toBe('user');
    expect(toolResultMsg?.content[0]?.type).toBe('tool_result');
    // Read against a nonexistent path yields an error tool_result (ENOENT).
    expect(
      toolResultMsg?.content[0]?.type === 'tool_result' && toolResultMsg.content[0].isError,
    ).toBe(true);
  });

  test('unknown tool: synthetic ENOTOOL tool_result', async () => {
    const provider = new FakeProvider([
      toolCallResponse('call-1', 'NoSuchTool', {}),
      textResponse('recovered'),
    ]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();

    const result = await engine.runAgent({ session, userMessage: 'go' });
    expect(result.stopReason).toBe('end_turn');
    const toolResult = session.transcript[2]?.content[0];
    expect(toolResult?.type).toBe('tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toContain('ENOTOOL');
    }
  });

  test('permission deny: EPERM result, loop continues, denial counted', async () => {
    const provider = new FakeProvider([
      toolCallResponse('call-1', 'Read', { path: '/nope' }),
      textResponse('ok'),
    ]);
    const gate = createPermissionGate({
      mode: 'default',
      rules: [{ pattern: 'Read:/nope', decision: 'deny' }],
    });
    const engine = createEngine({ provider, tools: [Read], permissions: gate });
    const session = createMemorySession();

    const result = await engine.runAgent({ session, userMessage: 'try' });

    expect(result.stopReason).toBe('end_turn');
    expect(gate.denialsInSession()).toBe(1);
    const content = session.transcript[2]?.content[0];
    expect(content?.type === 'tool_result' && content.isError).toBe(true);
    expect(content?.type === 'tool_result' && content.content).toContain('EPERM');
  });

  test('3-denial escalation aborts the turn', async () => {
    const provider = new FakeProvider([
      toolCallResponse('call-1', 'Read', { path: '/a' }),
      toolCallResponse('call-2', 'Read', { path: '/b' }),
      toolCallResponse('call-3', 'Read', { path: '/c' }),
      textResponse('should not be reached'),
    ]);
    const gate = createPermissionGate({
      mode: 'default',
      rules: [{ pattern: 'Read:/**', decision: 'deny' }],
    });
    const engine = createEngine({ provider, tools: [Read], permissions: gate });
    const session = createMemorySession();

    const result = await engine.runAgent({ session, userMessage: 'try hard' });
    expect(result.stopReason).toBe('permission_escalated');
    expect(gate.denialsInSession()).toBe(3);
    expect(provider.callCount).toBe(3);
  });

  test('prompt outcome with allowing prompter → tool executes', async () => {
    const provider = new FakeProvider([
      toolCallResponse('call-1', 'Read', { path: '/nonexistent' }),
      textResponse('done'),
    ]);
    let prompted = false;
    const engine = createEngine({
      provider,
      tools: [Read],
      permissions: createPermissionGate({ mode: 'default', rules: [] }),
      prompter: async () => {
        prompted = true;
        return true;
      },
    });
    const session = createMemorySession();

    const result = await engine.runAgent({ session, userMessage: 'go' });
    expect(prompted).toBe(true);
    expect(result.stopReason).toBe('end_turn');
  });

  test('maxIterations cap halts runaway loops', async () => {
    const responses: LLMResponse[] = [];
    for (let i = 0; i < 10; i += 1) {
      responses.push(toolCallResponse(`c-${i}`, 'Read', { path: '/a' }));
    }
    const provider = new FakeProvider(responses);
    const engine = createEngine({
      provider,
      tools: [Read],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      maxIterations: 3,
    });
    const session = createMemorySession();
    const result = await engine.runAgent({ session, userMessage: 'loop' });
    expect(result.stopReason).toBe('max_iterations');
    expect(provider.callCount).toBe(3);
  });

  test('hook override short-circuits tool execution', async () => {
    const provider = new FakeProvider([
      toolCallResponse('call-1', 'Read', { path: '/x' }),
      textResponse('done'),
    ]);
    const engine = createEngine({
      provider,
      tools: [Read],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      hooks: {
        onToolCallBefore: async () => ({ output: 'stubbed' }),
      },
    });
    const session = createMemorySession();
    await engine.runAgent({ session, userMessage: 'go' });
    const toolResult = session.transcript[2]?.content[0];
    expect(toolResult?.type === 'tool_result' && toolResult.content).toBe('stubbed');
  });

  test('abort signal: mid-turn abort yields aborted', async () => {
    const ac = new AbortController();
    const provider = new FakeProvider([
      toolCallResponse('call-1', 'Read', { path: '/x' }),
      textResponse('should not be reached'),
    ]);
    let tripped = false;
    const slowTool: Tool<{ path: string }, string> = {
      name: 'Read',
      description: 'slow read',
      inputSchema: {},
      permissionKey: () => 'slow',
      async *execute() {
        ac.abort();
        tripped = true;
        yield { type: 'result', output: 'ok' };
      },
    };
    const engine = createEngine({
      provider,
      tools: [slowTool],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();
    const result = await engine.runAgent({
      session,
      userMessage: 'go',
      abortSignal: ac.signal,
    });
    expect(tripped).toBe(true);
    expect(result.stopReason).toBe('aborted');
  });

  test('sub-agent depth cap rejects at depth+1 over cap', async () => {
    const provider = new FakeProvider([]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession({ spec: { subagentDepthCap: 2 } });
    const result = await engine.runAgent({
      session,
      userMessage: 'go',
      depth: 3,
    });
    expect(result.stopReason).toBe('error');
    expect(result.error?.message).toContain('depth cap');
  });

  test('mailbox messages are drained into the transcript before the user message', async () => {
    const db = new Database(':memory:', { create: true });
    const mailbox = createMailbox({ db });
    await mailbox.send('target-agent', { note: 'from alice' }, 'alice');
    await mailbox.send('target-agent', { note: 'from carol' }, 'carol');

    const provider = new FakeProvider([textResponse('ack')]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      mailbox,
    });
    const session = createMemorySession({ spec: { name: 'target-agent' } });

    await engine.runAgent({ session, userMessage: 'hi' });

    // Transcript: [mailbox-1, mailbox-2, user "hi", assistant "ack"]
    expect(session.transcript).toHaveLength(4);
    const first = session.transcript[0]?.content[0];
    expect(first?.type).toBe('text');
    if (first?.type === 'text') {
      expect(first.text).toContain('<event ');
      expect(first.text).toContain('source="mailbox"');
      expect(first.text).toContain('from alice');
    }
    const third = session.transcript[2]?.content[0];
    expect(third?.type).toBe('text');
    if (third?.type === 'text') expect(third.text).toBe('hi');

    // Mailbox is empty now.
    expect(await mailbox.depth('target-agent')).toBe(0);
    db.close();
  });

  test('mailbox with no pending messages is a no-op', async () => {
    const db = new Database(':memory:', { create: true });
    const mailbox = createMailbox({ db });

    const provider = new FakeProvider([textResponse('ack')]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      mailbox,
    });
    const session = createMemorySession({ spec: { name: 'lonely-agent' } });

    await engine.runAgent({ session, userMessage: 'hi' });
    expect(session.transcript).toHaveLength(2); // user + assistant only
    db.close();
  });

  test('session ledger accumulates token usage', async () => {
    const provider = new FakeProvider([textResponse('a', { inputTokens: 100, outputTokens: 30 })]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();
    await engine.runAgent({ session, userMessage: 'hi' });
    const ledger = session.ledger();
    expect(ledger.inputTokens).toBe(100);
    expect(ledger.outputTokens).toBe(30);
    expect(ledger.turns).toBe(1);
  });

  test('publishes assistant.final to the bus when configured', async () => {
    const bus = createEventBus();
    const events: AgentEvent[] = [];
    bus.subscribe('assistant.final', (e) => {
      events.push(e);
    });

    const provider = new FakeProvider([textResponse('hello back')]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      bus,
    });
    const session = createMemorySession();
    await engine.runAgent({ session, userMessage: 'hi', causedBy: 'evt-42' });
    await bus.drained();

    expect(events).toHaveLength(1);
    const event = events[0];
    if (!event) throw new Error('expected assistant.final event');
    expect(event.kind).toBe('assistant.final');
    expect(event.source).toEqual({
      type: 'engine',
      sessionId: session.id,
      turnId: expect.any(String),
    });
    expect(event.meta?.correlationId).toBe('evt-42');
    expect(event.meta?.causedBy).toBe('evt-42');
    const payload = event.payload as AssistantFinalPayload;
    expect(payload.sessionId).toBe(session.id);
    expect(payload.stopReason).toBe('end_turn');
    expect(payload.content[0]).toEqual({ type: 'text', text: 'hello back' });
    expect(payload.usage.outputTokens).toBe(5);
  });

  test('does not publish assistant.final when no bus is supplied', async () => {
    const provider = new FakeProvider([textResponse('no emit')]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();
    await expect(engine.runAgent({ session, userMessage: 'hi' })).resolves.toBeDefined();
  });

  test('publishes turn.started before the first LLM call', async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.subscribe('turn.started', (e) => {
      order.push(`turn.started:${(e.payload as TurnStartedPayload).turnId}`);
    });
    bus.subscribe('assistant.final', (e) => {
      order.push(`assistant.final:${(e.payload as AssistantFinalPayload).turnId}`);
    });

    // Wrap FakeProvider so we can assert `turn.started` has been
    // published onto the bus before the first LLM call begins.
    const inner = new FakeProvider([textResponse('hello back')]);
    let seenTurnStartedBeforeLLM = false;
    let providerCalls = 0;
    const recordingProvider: LLMProvider = {
      name: inner.name,
      complete: async (req) => {
        providerCalls += 1;
        if (order.some((e) => e.startsWith('turn.started:'))) {
          seenTurnStartedBeforeLLM = true;
        }
        return inner.complete(req);
      },
      countTokens: (msgs) => inner.countTokens(msgs),
    };
    const engine = createEngine({
      provider: recordingProvider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      bus,
    });
    const session = createMemorySession();
    await engine.runAgent({ session, userMessage: 'hi', causedBy: 'evt-99' });
    await bus.drained();

    expect(providerCalls).toBe(1);
    expect(seenTurnStartedBeforeLLM).toBe(true);
    const started = order.find((e) => e.startsWith('turn.started:'));
    const final = order.find((e) => e.startsWith('assistant.final:'));
    expect(started).toBeDefined();
    expect(final).toBeDefined();
    // Same turn id on both events, and started precedes final.
    expect(started?.split(':')[1]).toBe(final?.split(':')[1]);
    expect(order.indexOf(started as string)).toBeLessThan(order.indexOf(final as string));
  });

  test('populates ToolContext.correlationId from input.causedBy (correlation-id audit)', async () => {
    // Phase 6 slice-2 audit: tools should see the correlation id of
    // the originating event so any bus events they emit stamp the same
    // id. The engine must thread `input.causedBy` → `ctx.correlationId`.
    let seenCorrelationId: string | undefined;
    const probeTool: Tool<Record<string, never>, { ok: true }> = {
      name: 'CorrelationProbe',
      description: 'Records ctx.correlationId for the audit test',
      inputSchema: { type: 'object', properties: {}, required: [] },
      permissionKey: () => 'probe:correlation',
      async *execute(_input, ctx) {
        seenCorrelationId = ctx.correlationId;
        yield { type: 'result', output: { ok: true as const } };
      },
    };
    const provider = new FakeProvider([
      toolCallResponse('probe-1', 'CorrelationProbe', {}),
      textResponse('done'),
    ]);
    const engine = createEngine({
      provider,
      tools: [probeTool],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    });
    const session = createMemorySession();
    await engine.runAgent({ session, userMessage: 'hi', causedBy: 'evt-correlate' });
    expect(seenCorrelationId).toBe('evt-correlate');
  });

  test('does not publish assistant.final when no assistant message was produced', async () => {
    // Depth-cap error returns before any assistant message — no event expected.
    const bus = createEventBus();
    const events: AgentEvent[] = [];
    bus.subscribe('assistant.final', (e) => {
      events.push(e);
    });
    const provider = new FakeProvider([]);
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      bus,
    });
    const session = createMemorySession();
    await engine.runAgent({ session, userMessage: 'hi', depth: 999 });
    await bus.drained();
    expect(events).toHaveLength(0);
  });
});

describe('engine — tenant quota wiring (slice 0.2)', () => {
  test('quota breach: tool result carries EQUOTA and the loop continues', async () => {
    const provider = new FakeProvider([
      toolCallResponse('c-1', 'Echo', { msg: 'one' }),
      textResponse('recovered'),
    ]);
    const Echo: Tool<{ msg: string }, string> = {
      name: 'Echo',
      description: 'Echo',
      inputSchema: { type: 'object' },
      readonly: true,
      permissionKey: () => 'Echo',
      async *execute(input, _ctx) {
        yield { type: 'result', output: input.msg };
      },
    };
    const { createQuotaTracker } = await import('../tenancy/quota.js');
    const quotas = createQuotaTracker({
      tenant: { id: 't', quotas: { maxConcurrentToolCalls: 1 } },
    });
    // Pre-hold the only slot so the engine's acquire breaches immediately.
    quotas.acquireToolCall();

    const engine = createEngine({
      provider,
      tools: [Echo],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      quotas,
    });
    const session = createMemorySession();

    const result = await engine.runAgent({ session, userMessage: 'please call a tool' });
    expect(result.stopReason).toBe('end_turn');

    const toolResultMsg = session.transcript[2];
    expect(toolResultMsg?.role).toBe('user');
    const block = toolResultMsg?.content[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type === 'tool_result') {
      expect(block.isError).toBe(true);
      expect(typeof block.content === 'string' && block.content.startsWith('[EQUOTA]')).toBe(true);
    }

    // The engine did NOT acquire a fresh slot because the pre-held one
    // already breached the limit — the counter is still at 1 until the
    // test explicitly releases.
    expect(quotas.snapshot().concurrentToolCalls).toBe(1);
    quotas.releaseToolCall();
  });

  test('quota allows the call: tool executes and slot is released', async () => {
    const provider = new FakeProvider([
      toolCallResponse('c-1', 'Echo', { msg: 'hi' }),
      textResponse('done'),
    ]);
    const Echo: Tool<{ msg: string }, string> = {
      name: 'Echo',
      description: 'Echo',
      inputSchema: { type: 'object' },
      readonly: true,
      permissionKey: () => 'Echo',
      async *execute(input, _ctx) {
        yield { type: 'result', output: input.msg };
      },
    };
    const { createQuotaTracker } = await import('../tenancy/quota.js');
    const quotas = createQuotaTracker({
      tenant: { id: 't', quotas: { maxConcurrentToolCalls: 10 } },
    });
    const engine = createEngine({
      provider,
      tools: [Echo],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      quotas,
    });
    const session = createMemorySession();
    const result = await engine.runAgent({ session, userMessage: 'go' });
    expect(result.stopReason).toBe('end_turn');
    expect(quotas.snapshot().concurrentToolCalls).toBe(0);
  });
});

describe('engine — multi-step observability (D2 / Item A step 3)', () => {
  // Helper: pull a single numeric sample line out of a Prometheus scrape,
  // ignoring labels. Returns undefined when the metric/line is absent.
  function sampleValue(scrape: string, lineStartsWith: string): number | undefined {
    for (const line of scrape.split('\n')) {
      if (line.startsWith('#')) continue;
      if (!line.startsWith(lineStartsWith)) continue;
      const value = line.slice(line.lastIndexOf(' ') + 1);
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  }

  test('(a) multi-tool-call turn records >1 iteration; text-only records 1', async () => {
    const metrics = createPrometheusRegistry();

    // Two tool_use rounds, then a final text turn → 3 LLM iterations.
    const multiProvider = new FakeProvider([
      toolCallResponse('c-1', 'Read', { path: '/nope-1' }),
      toolCallResponse('c-2', 'Read', { path: '/nope-2' }),
      textResponse('done'),
    ]);
    const multiEngine = createEngine({
      provider: multiProvider,
      tools: [Read],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      metrics,
    });
    const multiResult = await multiEngine.runAgent({
      session: createMemorySession(),
      userMessage: 'read twice',
    });
    expect(multiResult.stopReason).toBe('end_turn');
    expect(multiProvider.callCount).toBe(3);

    const afterMulti = metrics.scrape();
    // One observation recorded, summing to 3 steps.
    expect(sampleValue(afterMulti, 'declaragent_engine_turn_iterations_count')).toBe(1);
    expect(sampleValue(afterMulti, 'declaragent_engine_turn_iterations_sum')).toBe(3);
    // No cap was hit, so the counter must not appear.
    expect(afterMulti).not.toContain('declaragent_engine_turn_max_iterations_hit_total');

    // Contrast: a text-only turn records exactly 1 iteration.
    const textEngine = createEngine({
      provider: new FakeProvider([textResponse('hi')]),
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      metrics,
    });
    await textEngine.runAgent({ session: createMemorySession(), userMessage: 'hi' });

    const afterText = metrics.scrape();
    // Two observations now (3 + 1), summing to 4 across both turns.
    expect(sampleValue(afterText, 'declaragent_engine_turn_iterations_count')).toBe(2);
    expect(sampleValue(afterText, 'declaragent_engine_turn_iterations_sum')).toBe(4);
  });

  test('(WS7) provider golden signals: latency, requests, tokens, cost', async () => {
    const metrics = createPrometheusRegistry();
    const engine = createEngine({
      provider: new FakeProvider([textResponse('hi', { inputTokens: 1_000_000, outputTokens: 0 })]),
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      metrics,
    });
    await engine.runAgent({ session: createMemorySession(), userMessage: 'hi' });

    const scrape = metrics.scrape();
    expect(sampleValue(scrape, 'declaragent_provider_requests_total')).toBe(1);
    expect(sampleValue(scrape, 'declaragent_provider_input_tokens_total')).toBe(1_000_000);
    expect(sampleValue(scrape, 'declaragent_provider_request_duration_ms_count')).toBe(1);
    // 1M input tokens @ opus $15/1M = $15 cost recorded.
    expect(sampleValue(scrape, 'declaragent_provider_cost_usd_total')).toBeCloseTo(15, 1);
    // No errors on the happy path.
    expect(scrape).not.toContain('declaragent_provider_errors_total');
  });

  test('(WS7) provider error increments errors_total and rethrows', async () => {
    const metrics = createPrometheusRegistry();
    const engine = createEngine({
      provider: new FakeProvider([]), // out of responses → complete() throws
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      metrics,
    });
    const result = await engine.runAgent({ session: createMemorySession(), userMessage: 'hi' });
    // The engine surfaces the provider error as a failed turn.
    expect(result.stopReason).toBe('error');
    expect(sampleValue(metrics.scrape(), 'declaragent_provider_errors_total')).toBe(1);
  });

  test('(WS8) dailyTokenUSD spend cap halts the turn fail-closed (quota_exceeded)', async () => {
    const quotas = createQuotaTracker({ tenant: { id: 't1', quotas: { dailyTokenUSD: 0.0001 } } });
    const engine = createEngine({
      // 1M input tokens @ opus $15/1M = $15, far over the $0.0001 cap.
      provider: new FakeProvider([textResponse('hi', { inputTokens: 1_000_000, outputTokens: 0 })]),
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      quotas,
    });
    const result = await engine.runAgent({ session: createMemorySession(), userMessage: 'hi' });
    expect(result.stopReason).toBe('quota_exceeded');
  });

  test('(WS8) spend under the cap completes normally', async () => {
    const quotas = createQuotaTracker({ tenant: { id: 't1', quotas: { dailyTokenUSD: 1000 } } });
    const engine = createEngine({
      provider: new FakeProvider([textResponse('hi')]),
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      quotas,
    });
    const result = await engine.runAgent({ session: createMemorySession(), userMessage: 'hi' });
    expect(result.stopReason).toBe('end_turn');
  });

  test('(b) hitting the maxIterations cap increments the counter and records iterations==cap', async () => {
    const metrics = createPrometheusRegistry();
    const responses: LLMResponse[] = [];
    for (let i = 0; i < 10; i += 1) {
      responses.push(toolCallResponse(`c-${i}`, 'Read', { path: '/a' }));
    }
    const engine = createEngine({
      provider: new FakeProvider(responses),
      tools: [Read],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      maxIterations: 3,
      metrics,
    });
    const result = await engine.runAgent({
      session: createMemorySession(),
      userMessage: 'loop',
    });
    expect(result.stopReason).toBe('max_iterations');

    const scrape = metrics.scrape();
    // The cap-hit counter fired exactly once.
    expect(sampleValue(scrape, 'declaragent_engine_turn_max_iterations_hit_total')).toBe(1);
    // The histogram recorded the capped iteration count (3).
    expect(sampleValue(scrape, 'declaragent_engine_turn_iterations_count')).toBe(1);
    expect(sampleValue(scrape, 'declaragent_engine_turn_iterations_sum')).toBe(3);
  });

  test('(c) spec-level maxIterations override is honored (spec > config > default)', async () => {
    const responses: LLMResponse[] = [];
    for (let i = 0; i < 10; i += 1) {
      responses.push(toolCallResponse(`c-${i}`, 'Read', { path: '/a' }));
    }
    const provider = new FakeProvider(responses);
    const engine = createEngine({
      provider,
      tools: [Read],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      // No config.maxIterations: the spec override must drive the cap.
    });
    // Spec caps the loop at 2 iterations.
    const session = createMemorySession({ spec: { maxIterations: 2 } });
    const result = await engine.runAgent({ session, userMessage: 'loop' });

    expect(result.stopReason).toBe('max_iterations');
    expect(provider.callCount).toBe(2);
  });

  test('(c2) config.maxIterations still applies when the spec omits the override', async () => {
    const responses: LLMResponse[] = [];
    for (let i = 0; i < 10; i += 1) {
      responses.push(toolCallResponse(`c-${i}`, 'Read', { path: '/a' }));
    }
    const provider = new FakeProvider(responses);
    const engine = createEngine({
      provider,
      tools: [Read],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      maxIterations: 4,
    });
    // Spec has no maxIterations → falls back to config (4).
    const session = createMemorySession();
    const result = await engine.runAgent({ session, userMessage: 'loop' });

    expect(result.stopReason).toBe('max_iterations');
    expect(provider.callCount).toBe(4);
  });

  test('(c3) spec override wins over config when both are set', async () => {
    const responses: LLMResponse[] = [];
    for (let i = 0; i < 10; i += 1) {
      responses.push(toolCallResponse(`c-${i}`, 'Read', { path: '/a' }));
    }
    const provider = new FakeProvider(responses);
    const engine = createEngine({
      provider,
      tools: [Read],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      maxIterations: 5,
    });
    // Spec (2) takes precedence over the larger config cap (5).
    const session = createMemorySession({ spec: { maxIterations: 2 } });
    const result = await engine.runAgent({ session, userMessage: 'loop' });

    expect(result.stopReason).toBe('max_iterations');
    expect(provider.callCount).toBe(2);
  });
});

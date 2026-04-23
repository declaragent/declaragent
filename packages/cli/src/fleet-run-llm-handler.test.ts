import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRpcEnvelope,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LoadedAgentEntry,
  RpcRespondResult,
} from '@declaragent/core';
import { createSqliteSessionStore } from '@declaragent/core';
import { createLLMHandlerFactory } from './fleet-run-llm-handler.js';
import type { FleetAgentRequestContext } from './fleet-run.js';

// Minimal LLMProvider stub. Records every `complete` call so we can
// assert what the engine actually sent, and hands back scripted
// responses in FIFO order. Mirrors the shape of core's internal
// `FakeProvider` but colocated so the CLI test doesn't reach into
// core's private test helpers.
function scriptedProvider(responses: LLMResponse[]): LLMProvider & {
  requests: LLMRequest[];
} {
  let idx = 0;
  const requests: LLMRequest[] = [];
  return {
    name: 'scripted',
    requests,
    async complete(request: LLMRequest): Promise<LLMResponse> {
      requests.push(request);
      const next = responses[idx++];
      if (!next) throw new Error(`scriptedProvider exhausted after ${idx - 1} calls`);
      return next;
    },
    async countTokens(): Promise<number> {
      return 0;
    },
  };
}

function textResponse(text: string): LLMResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'test-model',
  };
}

function buildEnvelope(
  capability: string,
  payload: unknown,
  overrides: Partial<AgentRpcEnvelope> = {},
): AgentRpcEnvelope {
  return {
    version: 1,
    kind: 'request',
    messageId: 'msg-1',
    correlationId: 'corr-1',
    from: 'agent://caller',
    to: 'agent://pr-reviewer',
    capability,
    payload,
    ...overrides,
  } as AgentRpcEnvelope;
}

async function runHandler(
  handlerCtxCapability: string,
  payload: unknown,
  opts: {
    responses: LLMResponse[];
    agentDir: string;
  },
): Promise<{ result: RpcRespondResult; requests: LLMRequest[]; dbPath: string }> {
  const provider = scriptedProvider(opts.responses);
  const dbPath = join(mkdtempSync(join(tmpdir(), 'declara-fleet-llm-')), 'sessions.db');
  const store = createSqliteSessionStore({ path: dbPath });
  const factory = createLLMHandlerFactory({
    provider,
    sessionStore: store,
    defaultModel: 'claude-sonnet-4-5',
  });

  const agentEntry: LoadedAgentEntry = {
    id: 'pr-reviewer',
    path: opts.agentDir,
  } as LoadedAgentEntry;

  const handler = await factory(agentEntry, {
    selfAddress: 'agent://pr-reviewer',
    transports: new Map(),
  });

  let captured: RpcRespondResult | null = null;
  const ctx: FleetAgentRequestContext = {
    agentId: 'pr-reviewer',
    capability: handlerCtxCapability,
    envelope: buildEnvelope(handlerCtxCapability, payload),
    respond: async (result) => {
      captured = result;
    },
  };
  await handler(ctx);
  store.close();

  if (!captured) throw new Error('handler never called respond()');
  return { result: captured, requests: provider.requests, dbPath };
}

const AGENT_YAML = `name: pr-reviewer
systemPrompt: |
  You are a PR reviewer.
skills:
  - skills/review-pr.md
`;

const SKILL = `---
name: review-pr
description: Review a pull request.
---
Summarise the pull request at {{prUrl}}.
`;

describe('createLLMHandlerFactory', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'declara-fleet-agent-'));
    mkdirSync(join(agentDir, 'skills'), { recursive: true });
    writeFileSync(join(agentDir, 'agent.yaml'), AGENT_YAML);
    writeFileSync(join(agentDir, 'skills', 'review-pr.md'), SKILL);
  });
  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test('invokes the skill + responds with the assistant text', async () => {
    const { result, requests } = await runHandler(
      'review-pr',
      { prUrl: 'https://example.com/pr/1' },
      {
        responses: [textResponse('Looks good to me.')],
        agentDir,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const data = result.data as { text: string; stopReason: string };
    expect(data.text).toBe('Looks good to me.');
    expect(data.stopReason).toBe('end_turn');

    // The engine's first request should carry the skill body inlined
    // into the user message so the model sees the templated prompt.
    expect(requests.length).toBe(1);
    const lastMsg = requests[0]?.messages.at(-1);
    const textPart = lastMsg?.content.find((c) => c.type === 'text');
    expect(textPart?.type).toBe('text');
    if (textPart?.type !== 'text') throw new Error('expected text');
    expect(textPart.text).toContain('https://example.com/pr/1');
  });

  test('unknown capability → NO_CAPABILITY RPC error', async () => {
    const { result } = await runHandler(
      'no-such-skill',
      {},
      {
        responses: [],
        agentDir,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('EAGENTRPC_NO_CAPABILITY');
  });

  test('scalar payload gets wrapped so skills can reference {{payload}}', async () => {
    writeFileSync(
      join(agentDir, 'skills', 'review-pr.md'),
      `---
name: review-pr
description: Receive a scalar.
---
Process: {{payload}}
`,
    );
    const { requests } = await runHandler('review-pr', 'hello-scalar', {
      responses: [textResponse('ok')],
      agentDir,
    });
    const lastMsg = requests[0]?.messages.at(-1);
    const textPart = lastMsg?.content.find((c) => c.type === 'text');
    if (textPart?.type !== 'text') throw new Error('expected text');
    expect(textPart.text).toContain('hello-scalar');
  });

  test('falls back to defaultModel when agent.yaml omits `model`', async () => {
    const { requests } = await runHandler(
      'review-pr',
      { prUrl: 'x' },
      {
        responses: [textResponse('ok')],
        agentDir,
      },
    );
    // agent.yaml in this test has no model field → factory should
    // stamp defaultModel onto the spec, which flows into the LLM
    // request.
    expect(requests[0]?.model).toBe('claude-sonnet-4-5');
  });

  test('loadAgentFn override is honoured (post-enterprise backlog #43)', async () => {
    // When the caller threads a memoized `loadAgent` (which `fleetRun`
    // does — it shares one cache between the probe + the handler
    // factory), the factory MUST use it instead of hitting disk itself.
    const provider = scriptedProvider([textResponse('ok')]);
    const dbPath = join(mkdtempSync(join(tmpdir(), 'declara-fleet-memo-')), 'sessions.db');
    const store = createSqliteSessionStore({ path: dbPath });
    let calls = 0;
    const { loadAgent } = await import('@declaragent/core');
    const factory = createLLMHandlerFactory({
      provider,
      sessionStore: store,
      defaultModel: 'claude-sonnet-4-5',
      loadAgentFn: async (agent) => {
        calls += 1;
        return loadAgent({ agentDir: agent.path });
      },
    });
    const agentEntry: LoadedAgentEntry = {
      id: 'pr-reviewer',
      path: agentDir,
    } as LoadedAgentEntry;
    const handler = await factory(agentEntry, {
      selfAddress: 'agent://pr-reviewer',
      transports: new Map(),
    });
    expect(calls).toBe(1);
    // Second factory invocation (the same `agent` path) still hits the
    // injected function — memoization is the caller's concern, not the
    // factory's. The test asserts the override is routed, not that the
    // function caches.
    await factory(agentEntry, {
      selfAddress: 'agent://pr-reviewer',
      transports: new Map(),
    });
    expect(calls).toBe(2);
    // Sanity: the returned handler still works.
    let captured: RpcRespondResult | null = null;
    await handler({
      agentId: 'pr-reviewer',
      capability: 'review-pr',
      envelope: buildEnvelope('review-pr', { prUrl: 'https://example.com/pr/99' }),
      respond: async (r) => {
        captured = r;
      },
    });
    expect(captured).not.toBeNull();
    store.close();
  });
});

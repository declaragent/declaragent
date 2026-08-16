/**
 * WS9 — hermetic end-to-end test of the flagship path:
 *
 *   inbound event → bus → dispatcher → engine (FakeProvider) → assistant.final
 *   → ChannelOutboundBridge → mock channel send,  with the event store
 *   recording a `dispatched` outcome.
 *
 * Fully in-memory: a scripted provider (no real LLM), a mock channel (no real
 * Slack), an in-memory bus + SQLite store. This is the single test that proves
 * the source→dispatch→engine→channel→ledger spine works as a UNIT — the gap the
 * audit flagged ("no test composes the flagship webhook→skill→LLM→channel
 * path"). It runs in plain `bun test`, no broker/cluster/collector.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  type AgentEvent,
  type AgentSpec,
  type LLMProvider,
  type Logger,
  type Message,
  createChannelOutboundBridge,
  createChannelRegistry,
  createEngine,
  createEventBus,
  createEventDispatcher,
  createEventStore,
  createExtensionRegistry,
  createPermissionGate,
  createSessionChannelContextStore,
  createSqliteSessionStore,
} from '@declaragent/core';
import { createMockChannelInstance } from '../channels/mock-channel.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

/** Minimal scripted LLM provider — one fixed reply, no network. */
function scriptedProvider(text: string): LLMProvider & { calls: number } {
  const p = {
    calls: 0,
    name: 'scripted',
    async complete() {
      p.calls += 1;
      return {
        content: [{ type: 'text' as const, text }],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 12, outputTokens: 8 },
        model: 'claude-sonnet-4-5',
      };
    },
    async countTokens(_messages: Message[]) {
      return 0;
    },
  };
  return p;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('hermetic flagship E2E (WS9)', () => {
  test('inbound event → dispatch → LLM turn → channel reply → outcome recorded', async () => {
    const bus = createEventBus();
    const store = createEventStore({ db: new Database(':memory:', { create: true }) });

    // Mock channel registered + session pre-mapped to its conversation so the
    // outbound bridge knows where to deliver the assistant's reply.
    const channel = createMockChannelInstance({ id: 'slack-main' });
    await channel.start();
    const channels = createChannelRegistry();
    channels.register(channel);
    const sessionChannelContext = createSessionChannelContextStore();
    const spec: AgentSpec = {
      name: 'triage',
      model: 'claude-sonnet-4-5',
      systemPrompt: 'You triage support tickets.',
    };
    const sessionStore = createSqliteSessionStore({ path: ':memory:' });
    const session = sessionStore.create(spec, 'sess-e2e');
    sessionChannelContext.set('sess-e2e', {
      channelOrigin: { channelId: 'slack-main', conversationId: 'C-123' },
    });

    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger: NOOP_LOGGER,
    });
    bridge.start();

    // Engine wired to the bus so it emits assistant.final; FakeProvider scripts
    // the "LLM" reply. No tools needed for this path.
    const provider = scriptedProvider('Triaged: this is a P2 billing issue.');
    const engine = createEngine({
      provider,
      tools: [],
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      bus,
      createChildSession: () => sessionStore.create(spec),
    });

    const registry = createExtensionRegistry({
      logger: NOOP_LOGGER,
      permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
      configDir: '/tmp',
    });
    const dispatcher = createEventDispatcher({
      registry,
      runAgent: engine.runAgent,
      store,
      resolveSession: (id) => (id === 'sess-e2e' ? session : undefined),
    });
    const detach = dispatcher.attach(bus);

    // Simulate a webhook-sourced event targeting the agent's session.
    const event: AgentEvent = {
      id: 'evt-flagship-1',
      kind: 'webhook.received',
      source: { type: 'webhook', triggerId: 'support-intake' },
      target: { type: 'session', sessionId: 'sess-e2e', mode: 'inject' },
      timestamp: Date.now(),
      payload: { text: 'My invoice double-charged me' },
      auth: { kind: 'internal' },
    };

    await bus.publish(event);
    await bus.drained();
    await flush(); // let the bridge's assistant.final handler complete

    // 1. The LLM turn ran (provider was called).
    expect(provider.calls).toBe(1);
    // 2. The reply was delivered to the mock channel.
    expect(channel.calls.send).toHaveLength(1);
    expect(channel.calls.send[0]?.conversation).toEqual({
      channelId: 'slack-main',
      conversationId: 'C-123',
    });
    expect(JSON.stringify(channel.calls.send[0]?.content)).toContain('P2 billing issue');
    // 3. The event store recorded a terminal dispatched outcome.
    const recorded = await store.get('evt-flagship-1');
    expect(recorded?.outcome?.kind).toBe('dispatched');

    detach();
  });
});

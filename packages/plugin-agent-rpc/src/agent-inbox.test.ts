import { describe, expect, test } from 'bun:test';
import type { AgentEvent, AgentRpcEnvelope, SourceDependencies } from '@declaragent/core';
import { createEventBus } from '@declaragent/core';
import { createAgentInboxAdapter } from './agent-inbox.js';
import { createMemoryTransport } from './memory-transport.js';
import { createPendingRegistry } from './pending-registry.js';

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return noopLogger();
    },
  };
}

function requestEnvelope(overrides: Partial<AgentRpcEnvelope> = {}): AgentRpcEnvelope {
  return {
    version: 1,
    kind: 'request',
    messageId: 'm1',
    correlationId: 'c1',
    from: 'agent://concierge',
    to: 'agent://pr-reviewer',
    capability: 'review-pr',
    replyTo: 'memory://agents.concierge.responses',
    payload: { pr: 'x' },
    ...overrides,
  } as AgentRpcEnvelope;
}

function baseDeps(): SourceDependencies {
  const bus = createEventBus();
  return {
    bus,
    logger: noopLogger(),
    configDir: process.cwd(),
  };
}

describe('agent-inbox adapter', () => {
  test('start / stop lifecycle + subscribes to requests + responses', async () => {
    const transport = createMemoryTransport();
    const adapter = createAgentInboxAdapter({ transport });
    const instance = await adapter.create({ id: 'inbox', agentId: 'pr-reviewer' }, baseDeps());
    await instance.start();
    expect(transport.subscriberCount('agents.pr-reviewer.requests')).toBe(1);
    expect(transport.subscriberCount('agents.pr-reviewer.responses')).toBe(1);
    await instance.stop();
    expect(transport.subscriberCount('agents.pr-reviewer.requests')).toBe(0);
  });

  test('request envelope publishes an AgentEvent with target=skill', async () => {
    const transport = createMemoryTransport();
    const deps = baseDeps();
    const published: AgentEvent[] = [];
    deps.bus.subscribe('*', (ev) => {
      published.push(ev);
    });

    const instance = await createAgentInboxAdapter({ transport }).create(
      { id: 'inbox', agentId: 'pr-reviewer' },
      deps,
    );
    await instance.start();
    await transport.publish('agents.pr-reviewer.requests', requestEnvelope());

    expect(published).toHaveLength(1);
    const ev = published[0];
    expect(ev?.target).toEqual({
      type: 'skill',
      name: 'review-pr',
      inputs: { payload: { pr: 'x' } },
    });
    expect(ev?.meta?.correlationId).toBe('c1');
    await instance.stop();
  });

  test('response envelope wakes pending registry', async () => {
    const transport = createMemoryTransport();
    const pending = createPendingRegistry();
    const instance = await createAgentInboxAdapter({ transport, pending }).create(
      { id: 'inbox', agentId: 'concierge' },
      baseDeps(),
    );
    await instance.start();

    const waiter = pending.register({
      correlationId: 'c1',
      deadlineMs: Date.now() + 5000,
    });

    await transport.publish('agents.concierge.responses', {
      ...requestEnvelope(),
      kind: 'response',
      replyTo: undefined,
      payload: { ok: true, data: { reviewed: true } },
    } as unknown as AgentRpcEnvelope);

    const result = await waiter;
    expect(result).toEqual({ status: 'ok', data: { reviewed: true } });
    await instance.stop();
  });

  test('event envelope publishes broadcast on bus', async () => {
    const transport = createMemoryTransport();
    const deps = baseDeps();
    const received: AgentEvent[] = [];
    deps.bus.subscribe('*', (ev) => {
      received.push(ev);
    });

    const instance = await createAgentInboxAdapter({ transport }).create(
      { id: 'inbox', agentId: 'broadcaster', eventsTopic: 'agents.broadcaster.events' },
      deps,
    );
    await instance.start();
    await transport.publish('agents.broadcaster.events', {
      ...requestEnvelope(),
      kind: 'event',
      replyTo: undefined,
    } as unknown as AgentRpcEnvelope);
    expect(received).toHaveLength(1);
    expect(received[0]?.target).toEqual({ type: 'broadcast' });
    await instance.stop();
  });

  test('tenant mismatch is rejected + no event published', async () => {
    const transport = createMemoryTransport();
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('*', (ev) => {
      received.push(ev);
    });

    const instance = await createAgentInboxAdapter({ transport }).create(
      { id: 'inbox', agentId: 'pr-reviewer' },
      {
        bus,
        logger: noopLogger(),
        configDir: process.cwd(),
        tenant: { id: 'acme-prod', residency: 'us', quotas: {} },
      },
    );
    await instance.start();
    await transport.publish(
      'agents.pr-reviewer.requests',
      requestEnvelope({ tenantId: 'other-tenant' }),
    );
    expect(received).toHaveLength(0);
    const metrics = instance.metrics();
    expect(metrics.messagesReceived).toBe(1);
    expect(metrics.messagesProcessed).toBe(0);
    await instance.stop();
  });

  test('onRequest hook overrides default bus publish', async () => {
    const transport = createMemoryTransport();
    const seen: AgentRpcEnvelope[] = [];
    const instance = await createAgentInboxAdapter({
      transport,
      onRequest: (env) => {
        seen.push(env);
      },
    }).create({ id: 'inbox', agentId: 'pr-reviewer' }, baseDeps());
    await instance.start();
    await transport.publish('agents.pr-reviewer.requests', requestEnvelope());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.capability).toBe('review-pr');
    await instance.stop();
  });

  test('response with malformed payload does not throw, counted as stale', async () => {
    const transport = createMemoryTransport();
    const pending = createPendingRegistry();
    const instance = await createAgentInboxAdapter({ transport, pending }).create(
      { id: 'inbox', agentId: 'concierge' },
      baseDeps(),
    );
    await instance.start();
    await transport.publish('agents.concierge.responses', {
      ...requestEnvelope(),
      kind: 'response',
      replyTo: undefined,
      payload: 'not-an-object',
    } as unknown as AgentRpcEnvelope);
    await instance.stop();
  });
});

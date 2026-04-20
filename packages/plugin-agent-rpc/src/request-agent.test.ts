import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope, RpcTransport, RpcTransportKind } from '@declaragent/core';
import { parsePeersConfig } from '@declaragent/core';
import { createPendingRegistry } from './pending-registry.js';
import { createRequestAgentTool } from './request-agent.js';
import { collectEvents, makeToolContext } from './test-helpers.js';

function stubTransport(
  kind: RpcTransportKind = 'memory',
): RpcTransport & { published: Array<{ topic: string; envelope: AgentRpcEnvelope }> } {
  const published: Array<{ topic: string; envelope: AgentRpcEnvelope }> = [];
  return {
    kind,
    async publish(topic, envelope) {
      published.push({ topic, envelope });
    },
    subscribe() {
      return () => {};
    },
    async close() {},
    published,
  } as ReturnType<typeof stubTransport>;
}

function singlePeer() {
  return parsePeersConfig({
    version: 1,
    peers: [
      {
        agent: 'agent://pr-reviewer',
        transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
      },
    ],
  });
}

describe('createRequestAgentTool', () => {
  test('permissionKey is "<to>/<capability>"', () => {
    const pending = createPendingRegistry();
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', stubTransport()]]),
      pending,
    });
    expect(
      tool.permissionKey({
        to: 'agent://pr-reviewer',
        capability: 'review-pr',
        payload: {},
      }),
    ).toBe('agent://pr-reviewer/review-pr');
  });

  test('sync mode: publishes + awaits matching response', async () => {
    const transport = stubTransport();
    const pending = createPendingRegistry();
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending,
      replyTo: 'memory://agents.concierge.responses',
    });

    const run = collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: { prUrl: 'x' },
        },
        makeToolContext(),
      ),
    );

    // Wait a microtask for the publish to happen + pending to register.
    await Promise.resolve();
    expect(transport.published).toHaveLength(1);
    const publishedEnv = transport.published[0]?.envelope;
    expect(publishedEnv?.kind).toBe('request');
    expect(publishedEnv?.replyTo).toBe('memory://agents.concierge.responses');
    expect(publishedEnv?.from).toBe('agent://concierge');

    // Simulate response arrival via the registry.
    expect(publishedEnv).toBeDefined();
    pending.settle(publishedEnv?.correlationId ?? '', {
      status: 'ok',
      data: { reviewed: true },
    });

    const events = await run;
    expect(events.result?.status).toBe('ok');
    expect(events.result?.response).toEqual({ reviewed: true });
  });

  test('sync mode: returns status=timeout on deadline expiry', async () => {
    const transport = stubTransport();
    const pending = createPendingRegistry();
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending,
      replyTo: 'memory://agents.concierge.responses',
    });

    const events = await collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: {},
          timeoutMs: 5,
        },
        makeToolContext(),
      ),
    );
    expect(events.result?.status).toBe('timeout');
    expect(events.result?.error?.code).toBe('EAGENTRPC_TIMEOUT');
  });

  test('async mode: returns correlationId without awaiting', async () => {
    const transport = stubTransport();
    const pending = createPendingRegistry();
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending,
    });

    const events = await collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: {},
          mode: 'async',
        },
        makeToolContext(),
      ),
    );
    expect(events.result?.status).toBe('ok');
    expect(typeof events.result?.correlationId).toBe('string');
    // No pending registry entry since async mode doesn't await.
    expect(pending.size()).toBe(0);
  });

  test('fire-and-forget: kind=event, no replyTo on envelope', async () => {
    const transport = stubTransport();
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending: createPendingRegistry(),
      replyTo: 'memory://agents.concierge.responses',
    });

    await collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'broadcast-update',
          payload: { msg: 'hi' },
          mode: 'fire-and-forget',
        },
        makeToolContext(),
      ),
    );
    expect(transport.published).toHaveLength(1);
    const env = transport.published[0]?.envelope;
    expect(env?.kind).toBe('event');
    expect(env?.replyTo).toBeUndefined();
  });

  test('unknown peer returns EAGENTRPC_NO_PEER error', async () => {
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: parsePeersConfig({ version: 1, peers: [] }),
      transports: new Map([['memory', stubTransport()]]),
      pending: createPendingRegistry(),
    });
    const events = await collectEvents(
      tool.execute({ to: 'agent://missing', capability: 'x', payload: {} }, makeToolContext()),
    );
    expect(events.error?.code).toBe('EAGENTRPC_NO_PEER');
  });

  test('missing transport for kind returns EAGENTRPC_NO_TRANSPORT', async () => {
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map(), // none registered
      pending: createPendingRegistry(),
    });
    const events = await collectEvents(
      tool.execute({ to: 'agent://pr-reviewer', capability: 'x', payload: {} }, makeToolContext()),
    );
    expect(events.error?.code).toBe('EAGENTRPC_NO_TRANSPORT');
  });

  test('sync mode: overflow evicts oldest pending and publishes', async () => {
    const transport = stubTransport();
    const pending = createPendingRegistry({ capacity: 1 });
    // Fill the registry. Attach a catch so the subsequent eviction's
    // rejection does not become an unhandled-rejection error in Bun.
    const preExisting = pending.register({
      correlationId: 'pre-existing',
      deadlineMs: Date.now() + 60_000,
    });
    preExisting.catch(() => {});

    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending,
      replyTo: 'memory://agents.concierge.responses',
    });

    const run = collectEvents(
      tool.execute(
        { to: 'agent://pr-reviewer', capability: 'x', payload: {}, timeoutMs: 10 },
        makeToolContext(),
      ),
    );
    const events = await run;
    // The evicted pre-existing entry's promise rejected with RpcBusyError.
    await expect(preExisting).rejects.toThrow(/capacity/);
    // The new registration succeeded and published an envelope.
    expect(transport.published).toHaveLength(1);
    // The new registration's promise timed out (no response came).
    expect(events.result?.status).toBe('timeout');
  });

  test('stamps tenantId from ctx.tenant', async () => {
    const transport = stubTransport();
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending: createPendingRegistry(),
    });
    const events = collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: {},
          mode: 'async',
        },
        makeToolContext({
          tenant: {
            id: 'acme-prod',
            residency: 'us',
            quotas: {},
          },
        }),
      ),
    );
    await events;
    expect(transport.published[0]?.envelope.tenantId).toBe('acme-prod');
  });
});

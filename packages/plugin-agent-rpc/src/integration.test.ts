/**
 * End-to-end integration: a producer daemon issues a `RequestAgent` call
 * over a shared in-memory bus to a consumer daemon running `agent-inbox`.
 * The consumer's skill handler replies via `ctx.respond`; the producer's
 * own inbox routes the response back to the pending registry.
 */

import { describe, expect, test } from 'bun:test';
import type { SourceDependencies } from '@declaragent/core';
import { createEventBus, parsePeersConfig } from '@declaragent/core';
import { createAgentInboxAdapter } from './agent-inbox.js';
import { createMemoryBus, createMemoryTransport } from './memory-transport.js';
import { createPendingRegistry } from './pending-registry.js';
import { createRequestAgentTool } from './request-agent.js';
import { createRespondHook } from './respond.js';
import { collectEvents, makeToolContext } from './test-helpers.js';

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

function mkDeps(): SourceDependencies {
  return {
    bus: createEventBus(),
    logger: noopLogger(),
    configDir: process.cwd(),
  };
}

describe('agent-rpc end-to-end', () => {
  test('concierge → pr-reviewer sync request round-trips a response', async () => {
    // Shared in-memory broker: simulates a real Kafka/NATS cluster.
    const broker = createMemoryBus();
    const conciergeTransport = createMemoryTransport({ bus: broker });
    const reviewerTransport = createMemoryTransport({ bus: broker });

    const peers = parsePeersConfig({
      version: 1,
      peers: [
        {
          agent: 'agent://pr-reviewer',
          transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
        },
      ],
    });

    // Producer (concierge): has a pending registry + its own inbox on
    // the responses topic. The inbox routes responses into the registry.
    const conciergePending = createPendingRegistry();
    const conciergeInbox = await createAgentInboxAdapter({
      transport: conciergeTransport,
      pending: conciergePending,
    }).create({ id: 'inbox', agentId: 'concierge' }, mkDeps());
    await conciergeInbox.start();

    // Consumer (pr-reviewer): its inbox dispatches requests via onRequest.
    // The hook invokes the "skill" inline and ctx.respond's back.
    const reviewerInbox = await createAgentInboxAdapter({
      transport: reviewerTransport,
      onRequest: async (envelope) => {
        const respond = createRespondHook({
          request: envelope,
          transport: reviewerTransport,
          selfAgent: 'agent://pr-reviewer',
        });
        const payload = envelope.payload as { prUrl: string };
        await respond({
          ok: true,
          data: { reviewed: true, prUrl: payload.prUrl, findings: ['looks good'] },
        });
      },
    }).create({ id: 'inbox', agentId: 'pr-reviewer' }, mkDeps());
    await reviewerInbox.start();

    // Issue the request.
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers,
      transports: new Map([['memory', conciergeTransport]]),
      pending: conciergePending,
      replyTo: 'memory://agents.concierge.responses',
    });
    const events = await collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'review-pr',
          payload: { prUrl: 'https://github.com/acme/app/pull/1' },
          timeoutMs: 2000,
        },
        makeToolContext(),
      ),
    );

    expect(events.result?.status).toBe('ok');
    expect(events.result?.response).toEqual({
      reviewed: true,
      prUrl: 'https://github.com/acme/app/pull/1',
      findings: ['looks good'],
    });

    await conciergeInbox.stop();
    await reviewerInbox.stop();
  });

  test('correlationId threads from producer through response', async () => {
    const broker = createMemoryBus();
    const conciergeTransport = createMemoryTransport({ bus: broker });
    const reviewerTransport = createMemoryTransport({ bus: broker });
    const peers = parsePeersConfig({
      version: 1,
      peers: [
        {
          agent: 'agent://pr-reviewer',
          transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
        },
      ],
    });

    const conciergePending = createPendingRegistry();
    const conciergeInbox = await createAgentInboxAdapter({
      transport: conciergeTransport,
      pending: conciergePending,
    }).create({ id: 'inbox', agentId: 'concierge' }, mkDeps());
    await conciergeInbox.start();

    let observedCorrelationId: string | undefined;
    const reviewerInbox = await createAgentInboxAdapter({
      transport: reviewerTransport,
      onRequest: async (envelope) => {
        observedCorrelationId = envelope.correlationId;
        await createRespondHook({
          request: envelope,
          transport: reviewerTransport,
          selfAgent: 'agent://pr-reviewer',
        })({ ok: true, data: {} });
      },
    }).create({ id: 'inbox', agentId: 'pr-reviewer' }, mkDeps());
    await reviewerInbox.start();

    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers,
      transports: new Map([['memory', conciergeTransport]]),
      pending: conciergePending,
      replyTo: 'memory://agents.concierge.responses',
    });

    const events = await collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'noop',
          payload: {},
        },
        makeToolContext({ correlationId: 'upstream-trace' }),
      ),
    );
    expect(events.result?.correlationId).toBe('upstream-trace');
    expect(observedCorrelationId).toBe('upstream-trace');

    await conciergeInbox.stop();
    await reviewerInbox.stop();
  });
});

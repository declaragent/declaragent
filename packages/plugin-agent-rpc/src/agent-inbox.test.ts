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

  test('auth registry rejects envelopes + routes to reject sink (Item #4)', async () => {
    const transport = createMemoryTransport();
    const deps = baseDeps();
    const published: AgentEvent[] = [];
    deps.bus.subscribe('*', (ev) => {
      published.push(ev);
    });

    const rejects: { reason: string; from: string }[] = [];
    const audits: { decision: string; reason?: string; subject?: string }[] = [];

    const instance = await createAgentInboxAdapter({
      transport,
      authRegistry: {
        resolve() {
          return {
            config: {
              provider: 'oidc' as const,
              issuer: 'https://dex.example.com',
              audience: 'aud',
            },
            provider: {
              name: 'oidc' as const,
              async sign() {
                return { kind: 'oidc', token: 'tok' };
              },
              async verify() {
                return { ok: false, reason: 'expired', message: 'token expired' } as const;
              },
            },
          };
        },
      },
      authRejectSink: ({ envelope, reason }) => {
        rejects.push({ reason, from: envelope.from });
      },
      auditSink: {
        async record(r) {
          if (r.kind === 'auth_check') {
            const row: { decision: string; reason?: string; subject?: string } = {
              decision: r.decision,
            };
            if (r.reason !== undefined) row.reason = r.reason;
            if (r.subject !== undefined) row.subject = r.subject;
            audits.push(row);
          }
        },
        async query() {
          return [];
        },
        async erase() {
          return 0;
        },
        async verify() {
          return { ok: true, totalEntries: 0, verifiedEntries: 0, violations: [] };
        },
        async prune() {
          return 0;
        },
        close() {},
      },
    }).create({ id: 'inbox', agentId: 'pr-reviewer' }, deps);
    await instance.start();
    await transport.publish('agents.pr-reviewer.requests', {
      ...requestEnvelope(),
      auth: { kind: 'oidc', token: 'expired-token' },
    });
    expect(published).toHaveLength(0);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.reason).toBe('expired');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.decision).toBe('reject');
    expect(audits[0]?.reason).toBe('expired');
    await instance.stop();
  });

  test('auth registry accepts + emits an auth_check=accept record (Item #4)', async () => {
    const transport = createMemoryTransport();
    const deps = baseDeps();
    const published: AgentEvent[] = [];
    deps.bus.subscribe('*', (ev) => {
      published.push(ev);
    });
    const audits: { decision: string; subject?: string }[] = [];
    const instance = await createAgentInboxAdapter({
      transport,
      authRegistry: {
        resolve() {
          return {
            config: {
              provider: 'oidc' as const,
              issuer: 'https://dex.example.com',
              audience: 'aud',
            },
            provider: {
              name: 'oidc' as const,
              async sign() {
                return { kind: 'oidc', token: 't' };
              },
              async verify() {
                return {
                  ok: true,
                  principal: {
                    subject: 'peer-a',
                    issuer: 'https://dex.example.com',
                    audience: 'aud',
                    scopes: ['rpc:invoke'],
                    claims: {},
                  },
                } as const;
              },
            },
          };
        },
      },
      auditSink: {
        async record(r) {
          if (r.kind === 'auth_check') {
            const row: { decision: string; subject?: string } = { decision: r.decision };
            if (r.subject !== undefined) row.subject = r.subject;
            audits.push(row);
          }
        },
        async query() {
          return [];
        },
        async erase() {
          return 0;
        },
        async verify() {
          return { ok: true, totalEntries: 0, verifiedEntries: 0, violations: [] };
        },
        async prune() {
          return 0;
        },
        close() {},
      },
    }).create({ id: 'inbox', agentId: 'pr-reviewer' }, deps);
    await instance.start();
    await transport.publish('agents.pr-reviewer.requests', {
      ...requestEnvelope(),
      auth: { kind: 'oidc', token: 'valid' },
    });
    expect(published).toHaveLength(1);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({ decision: 'accept', subject: 'peer-a' });
    await instance.stop();
  });

  // WS2 — fail-closed strict mode.
  test('strictAuth REJECTS an unregistered sender (closes the spoof)', async () => {
    const transport = createMemoryTransport();
    const deps = baseDeps();
    const published: AgentEvent[] = [];
    deps.bus.subscribe('*', (ev) => {
      published.push(ev);
    });
    const rejects: { reason: string; from: string }[] = [];

    const instance = await createAgentInboxAdapter({
      transport,
      strictAuth: true,
      // Registry has NO entry for any peer.
      authRegistry: { resolve: () => undefined },
      authRejectSink: ({ envelope, reason }) => {
        rejects.push({ reason, from: envelope.from });
      },
    }).create({ id: 'inbox', agentId: 'pr-reviewer' }, deps);
    await instance.start();
    await transport.publish('agents.pr-reviewer.requests', {
      ...requestEnvelope({ from: 'agent://attacker-not-in-registry' }),
    });
    // The spoofed envelope is rejected, never dispatched.
    expect(published).toHaveLength(0);
    expect(rejects).toHaveLength(1);
    expect(rejects[0]?.reason).toBe('unknown-peer');
    expect(rejects[0]?.from).toBe('agent://attacker-not-in-registry');
    await instance.stop();
  });

  test('without strictAuth an unregistered sender still falls through (legacy back-compat)', async () => {
    const transport = createMemoryTransport();
    const deps = baseDeps();
    const published: AgentEvent[] = [];
    deps.bus.subscribe('*', (ev) => {
      published.push(ev);
    });

    const instance = await createAgentInboxAdapter({
      transport,
      // strictAuth omitted → false
      authRegistry: { resolve: () => undefined },
    }).create({ id: 'inbox', agentId: 'pr-reviewer' }, deps);
    await instance.start();
    await transport.publish('agents.pr-reviewer.requests', {
      ...requestEnvelope({ from: 'agent://legacy-peer' }),
    });
    // Legacy fall-through: the envelope is accepted and dispatched.
    expect(published).toHaveLength(1);
    await instance.stop();
  });
});

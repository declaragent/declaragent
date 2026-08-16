import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope, RpcTransport, RpcTransportKind } from '@declaragent/core';
import {
  createCapabilityValidatorRegistry,
  parseCapabilitiesConfig,
  parsePeersConfig,
} from '@declaragent/core';
import { createHmacAuthProvider } from './auth/hmac.js';
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

  test('(WS2) signOutbound signs the envelope so the HMAC verifier accepts it', async () => {
    const transport = stubTransport();
    const signer = createHmacAuthProvider({ secret: 'shared', keyId: 'k1' });
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending: createPendingRegistry(),
      replyTo: 'memory://agents.concierge.responses',
      signOutbound: (env) => signer.sign(env),
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
    const env = transport.published[0]?.envelope;
    if (!env) throw new Error('expected a published envelope');
    // Outbound envelope is HMAC-signed, not the legacy internal kind.
    expect(env.auth?.kind).toBe('hmac');
    // The receiver's verifier (same secret) accepts it end-to-end.
    const verifier = createHmacAuthProvider({ secret: 'shared', keyId: 'k1' });
    const result = await verifier.verify(env, { provider: 'hmac', keyId: 'k1' });
    expect(result.ok).toBe(true);
    // A verifier with a different secret rejects it.
    const wrong = createHmacAuthProvider({ secret: 'other', keyId: 'k1' });
    expect((await wrong.verify(env, { provider: 'hmac', keyId: 'k1' })).ok).toBe(false);
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

  test('schema-violation on request short-circuits before publish (acceptance #1)', async () => {
    const transport = stubTransport();
    const caps = parseCapabilitiesConfig({
      version: 1,
      agent: 'agent://pr-reviewer',
      transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
      capabilities: [
        {
          name: 'review',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              severity: { enum: ['low', 'med', 'high'] },
            },
            required: ['title', 'severity'],
          },
        },
      ],
    });
    const violations: Array<{ side: string; count: number }> = [];
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending: createPendingRegistry(),
      peerCapabilities: new Map([['agent://pr-reviewer', caps]]),
      validators: createCapabilityValidatorRegistry(),
      onSchemaViolation: ({ side, violations: v }) => {
        violations.push({ side, count: v.length });
      },
    });
    const events = await collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'review',
          payload: { title: 'bad sev', severity: 'critical' },
        },
        makeToolContext(),
      ),
    );
    expect(events.result?.status).toBe('schema-violation');
    expect(events.result?.schemaSide).toBe('request');
    expect(events.result?.error?.code).toBe('EAGENTRPC_SCHEMA_VIOLATION');
    // Nothing went on the wire.
    expect(transport.published).toHaveLength(0);
    // Audit hook fired exactly once.
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({ side: 'request', count: 1 });
  });

  // POST_ENTERPRISE_BACKLOG.md #9 — audit cardinality decision.
  //
  // Decision: emit exactly ONE `onSchemaViolation` callback per failing
  // envelope, carrying the full `violations[]` array — NEVER one callback
  // per violation entry. This keeps SIEM volume bounded when a bad-actor
  // or misconfigured caller publishes an envelope that trips every field
  // in a large schema (without the cap, mass-rejection scenarios could
  // multiply audit rows by the schema's field count).
  //
  // The `CapabilitySchemaViolationEmitter` JSDoc documents this contract;
  // this test pins it. If you find yourself wanting to invoke the callback
  // N times for N violations, update the JSDoc + the backlog row first.
  test('schema-violation emits ONE callback per envelope with all violations batched (#9)', async () => {
    const transport = stubTransport();
    // Schema with multiple required-plus-enum fields so a single bad
    // payload trips multiple violations at once.
    const caps = parseCapabilitiesConfig({
      version: 1,
      agent: 'agent://pr-reviewer',
      transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
      capabilities: [
        {
          name: 'review',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              severity: { enum: ['low', 'med', 'high'] },
              priority: { enum: ['p0', 'p1', 'p2'] },
            },
            required: ['title', 'severity', 'priority'],
          },
        },
      ],
    });
    const calls: Array<{
      side: string;
      violationCount: number;
      paths: readonly string[];
    }> = [];
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending: createPendingRegistry(),
      peerCapabilities: new Map([['agent://pr-reviewer', caps]]),
      validators: createCapabilityValidatorRegistry(),
      onSchemaViolation: ({ side, violations: v }) => {
        calls.push({
          side,
          violationCount: v.length,
          paths: v.map((entry) => entry.path),
        });
      },
    });
    const events = await collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'review',
          // Bad severity, bad priority, missing title — three violations
          // across the payload. Emitter must still fire exactly once.
          payload: { severity: 'critical', priority: 'urgent' },
        },
        makeToolContext(),
      ),
    );
    expect(events.result?.status).toBe('schema-violation');
    expect(events.result?.schemaSide).toBe('request');
    // The result carries the full violation list.
    expect((events.result?.violations ?? []).length).toBeGreaterThanOrEqual(2);
    // Cardinality: the emitter was invoked once per envelope, not once
    // per violation entry — this is the load-bearing assertion.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.side).toBe('request');
    // And the single call received every violation the validator flagged.
    expect(calls[0]?.violationCount).toBe((events.result?.violations ?? []).length);
  });

  test('valid request passes through + validates response on return', async () => {
    const transport = stubTransport();
    const pending = createPendingRegistry();
    const caps = parseCapabilitiesConfig({
      version: 1,
      agent: 'agent://pr-reviewer',
      transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
      capabilities: [
        {
          name: 'review',
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
          outputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
      ],
    });
    const hits: Array<{ side: string }> = [];
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending,
      replyTo: 'memory://agents.concierge.responses',
      peerCapabilities: new Map([['agent://pr-reviewer', caps]]),
      validators: createCapabilityValidatorRegistry(),
      onSchemaViolation: ({ side }) => {
        hits.push({ side });
      },
    });
    const run = collectEvents(
      tool.execute(
        { to: 'agent://pr-reviewer', capability: 'review', payload: { title: 'ok' } },
        makeToolContext(),
      ),
    );
    await Promise.resolve();
    expect(transport.published).toHaveLength(1);
    const env = transport.published[0]?.envelope;
    pending.settle(env?.correlationId ?? '', {
      status: 'ok',
      // Malformed response: missing `ok` field.
      data: { notOk: true },
    });
    const events = await run;
    expect(events.result?.status).toBe('schema-violation');
    expect(events.result?.schemaSide).toBe('response');
    expect(hits).toEqual([{ side: 'response' }]);
  });

  test('back-compat: capabilities without schemas behave exactly like pre-1.2', async () => {
    const transport = stubTransport();
    const pending = createPendingRegistry();
    // capabilities.yaml that declares no inputSchema / outputSchema at all.
    const caps = parseCapabilitiesConfig({
      version: 1,
      agent: 'agent://pr-reviewer',
      transports: [{ kind: 'memory', topics: { requests: 'agents.pr-reviewer.requests' } }],
      capabilities: [{ name: 'review' }],
    });
    const tool = createRequestAgentTool({
      selfAgent: 'agent://concierge',
      peers: singlePeer(),
      transports: new Map([['memory', transport]]),
      pending,
      replyTo: 'memory://agents.concierge.responses',
      peerCapabilities: new Map([['agent://pr-reviewer', caps]]),
      validators: createCapabilityValidatorRegistry(),
    });
    const run = collectEvents(
      tool.execute(
        {
          to: 'agent://pr-reviewer',
          capability: 'review',
          // Totally arbitrary payload — no schema means no validation.
          payload: { anything: { goes: [1, 2, 3] } },
        },
        makeToolContext(),
      ),
    );
    await Promise.resolve();
    expect(transport.published).toHaveLength(1);
    const env = transport.published[0]?.envelope;
    pending.settle(env?.correlationId ?? '', {
      status: 'ok',
      data: { whatever: true },
    });
    const events = await run;
    expect(events.result?.status).toBe('ok');
    expect(events.result?.response).toEqual({ whatever: true });
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

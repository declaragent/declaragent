/**
 * Fleet-over-real-broker integration test — JetStream edition.
 *
 * Mirrors `nats-rpc.test.ts` / `kafka-rpc.test.ts` but exercises
 * `createJetStreamTransport` (post-enterprise backlog item #23). Proves
 * that at-least-once + replay semantics work end-to-end against a live
 * `nats-server` running with JetStream enabled.
 *
 * ## What this covers (in scope)
 * - `publish` is server-acked (no silent drops on a full broker).
 * - Round-trip request/response traverses the durable consumer
 *   surface within 5s.
 * - A handler that throws on first delivery does NOT lose the message —
 *   JetStream redelivers after `ackWaitMs` and the second attempt acks
 *   normally.
 *
 * ## What's deliberately NOT here (out of scope)
 * - JetStream stream provisioning (deploy-time concern via terraform /
 *   k8s manifests). This test creates the stream up-front with minimal
 *   config and tears it down.
 * - Quarantine / max-deliver exhaustion — covered by the unit-level
 *   nak-then-retry assertion in `jetstream-transport.test.ts`.
 *
 * ## How to run
 *
 * ```sh
 * cd packages/source-nats
 * docker compose -f test/fixtures/docker-compose.yml up -d
 * cd ../..
 * FLEET_INTEGRATION=1 NATS_INTEGRATION=1 NATS_SERVERS=nats://localhost:4222 bun test \
 *   packages/testkit/src/fleet-integration/jetstream-rpc.test.ts
 * ```
 *
 * Note the docker-compose used by `source-nats` already boots nats-server
 * with `-js`. If you're using a plain `nats:latest` image you'll need to
 * pass `-js` yourself.
 *
 * @since 0.7.x — post-enterprise backlog item #23.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import { createJetStreamTransport } from '@declaragent/plugin-agent-rpc';

const ENABLED = process.env.FLEET_INTEGRATION === '1' && process.env.NATS_INTEGRATION === '1';
const SERVERS = (process.env.NATS_SERVERS ?? 'nats://localhost:4222').split(',');

const describeIntegration = ENABLED ? describe : describe.skip;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitFor<T>(
  pred: () => T | undefined,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = pred();
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

describeIntegration('fleet RPC round-trip over JetStream', () => {
  const suffix = uniqueSuffix();
  const streamName = `DECLARAGENT_TEST_${suffix.replace(/[^A-Za-z0-9_]/g, '_')}`;
  const reqSubject = `declaragent-test-${suffix}.beta.requests`;
  const respSubject = `declaragent-test-${suffix}.alpha.responses`;

  let alpha: Awaited<ReturnType<typeof createJetStreamTransport>>;
  let beta: Awaited<ReturnType<typeof createJetStreamTransport>>;
  // Hold a raw `nats` connection so we can provision + teardown the
  // stream around the test. The transport itself doesn't own stream
  // lifecycle — that's a deploy concern.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic `nats` lib typing is loose enough to keep `any` here and avoid adding a hard dep on its types.
  let rawConn: any;

  beforeAll(async () => {
    const specifier = 'nats';
    const nats = (await import(/* @vite-ignore */ specifier)) as {
      connect: (o: { servers: string[] }) => Promise<unknown>;
    };
    rawConn = (await nats.connect({ servers: SERVERS })) as {
      jetstreamManager: () => Promise<{
        streams: {
          add: (cfg: unknown) => Promise<unknown>;
          delete: (name: string) => Promise<unknown>;
        };
      }>;
      drain: () => Promise<void>;
    };
    const jsm = await rawConn.jetstreamManager();
    await jsm.streams.add({
      name: streamName,
      subjects: [`declaragent-test-${suffix}.*.*`],
      retention: 'limits',
      storage: 'memory',
      max_age: 5 * 60 * 1_000_000_000, // 5min in ns — plenty for the test
    });

    alpha = await createJetStreamTransport({
      servers: SERVERS,
      stream: streamName,
      durableName: 'alpha-worker',
      clientName: 'declaragent-integration-alpha',
      ackWaitMs: 2_000,
      maxDeliver: 3,
    });
    beta = await createJetStreamTransport({
      servers: SERVERS,
      stream: streamName,
      durableName: 'beta-worker',
      clientName: 'declaragent-integration-beta',
      ackWaitMs: 2_000,
      maxDeliver: 3,
    });
  });

  afterAll(async () => {
    await Promise.allSettled([alpha?.close(), beta?.close()]);
    try {
      const jsm = await rawConn.jetstreamManager();
      await jsm.streams.delete(streamName);
    } catch {
      // best-effort
    }
    try {
      await rawConn.drain();
    } catch {
      // best-effort
    }
  });

  test('request/response pair traverses a real JetStream broker within 5s', async () => {
    let betaReceived: AgentRpcEnvelope | null = null;
    beta.subscribe(reqSubject, async (env) => {
      betaReceived = env;
      await beta.publish(respSubject, {
        version: 1,
        kind: 'response',
        messageId: `resp-${env.messageId}`,
        correlationId: env.correlationId,
        from: env.to,
        to: env.from,
        capability: env.capability,
        payload: { reply: 'pong' },
      });
    });

    let alphaReceived: AgentRpcEnvelope | null = null;
    alpha.subscribe(respSubject, async (env) => {
      alphaReceived = env;
    });

    // Give the consumers a tick to upsert + hydrate.
    await new Promise((r) => setTimeout(r, 300));

    const started = Date.now();
    await alpha.publish(reqSubject, {
      version: 1,
      kind: 'request',
      messageId: 'alpha-req-1',
      correlationId: 'corr-1',
      from: 'agent://alpha',
      to: 'agent://beta',
      capability: 'beta.ping',
      payload: { hello: 'world' },
    });

    const response = await waitFor(() => alphaReceived ?? undefined, 10_000);
    const elapsed = Date.now() - started;

    expect(betaReceived).not.toBeNull();
    expect(response.kind).toBe('response');
    expect(response.correlationId).toBe('corr-1');
    expect((response.payload as { reply: string }).reply).toBe('pong');
    expect(elapsed).toBeLessThan(5_000);
  });

  test('handler that throws on first delivery survives JetStream redelivery', async () => {
    const subject = `declaragent-test-${suffix}.beta.retry`;
    let attempts = 0;
    beta.subscribe(subject, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('simulated first-attempt failure');
      }
    });
    await new Promise((r) => setTimeout(r, 300));

    await alpha.publish(subject, {
      version: 1,
      kind: 'event',
      messageId: 'retry-1',
      correlationId: 'retry-corr',
      from: 'agent://alpha',
      to: 'agent://beta',
      capability: 'beta.event',
      payload: {},
    });

    // First attempt fails → JetStream nak → redelivery after ackWait
    // (2s). Second attempt succeeds. Budget 10s total.
    await waitFor(() => (attempts >= 2 ? attempts : undefined), 10_000);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});

if (!ENABLED) {
  describe('fleet RPC round-trip over JetStream (skipped)', () => {
    test('set FLEET_INTEGRATION=1 + NATS_INTEGRATION=1 + NATS_SERVERS to run', () => {
      expect(ENABLED).toBe(false);
    });
  });
}

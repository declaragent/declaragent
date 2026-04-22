/**
 * Fleet-over-real-broker integration test — NATS edition.
 *
 * Mirrors `kafka-rpc.test.ts` for the NATS RPC transport (Item #2 of
 * the Enterprise Production Plan). Proves that `createNatsTransport`
 * carries a request/response pair across two transport instances via
 * a live `nats-server`.
 *
 * ## What this covers (in scope)
 * - Request envelope published to `agents.beta.requests` reaches the
 *   beta-side subscriber.
 * - Response envelope published to `agents.alpha.responses` reaches
 *   the alpha-side subscriber.
 * - Round-trip completes within 2s (NATS is typically sub-10ms on
 *   localhost; the 2s ceiling mirrors the Kafka budget).
 *
 * ## What's deliberately NOT here (out of scope)
 * - Full `declaragent fleet run` boot with real LLM handlers. Same
 *   rationale as the Kafka variant — belongs to a dedicated
 *   skill-level harness once that stabilises.
 * - JetStream durable-consumer semantics. The transport is a core-NATS
 *   pub/sub shim; JetStream is owned by `source-nats`.
 * - Failure-mode tests (server restart, slow-consumer drop) — future.
 *
 * ## How to run
 *
 * ```sh
 * cd packages/source-nats
 * docker compose -f test/fixtures/docker-compose.yml up -d
 * cd ../..
 * NATS_INTEGRATION=1 NATS_SERVERS=nats://localhost:4222 bun test \
 *   packages/testkit/src/fleet-integration/nats-rpc.test.ts
 * ```
 *
 * In CI this is driven by `.github/workflows/nightly-integration.yml`,
 * which boots `nats:latest` as a service container + sets the env
 * vars automatically.
 *
 * @since 0.6.x
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import { createNatsTransport } from '@declaragent/plugin-agent-rpc';

const ENABLED = process.env.NATS_INTEGRATION === '1';
const SERVERS = (process.env.NATS_SERVERS ?? 'nats://localhost:4222').split(',');

const describeIntegration = ENABLED ? describe : describe.skip;

function uniqueSubject(prefix: string): string {
  // Fresh subject per test run avoids cross-run interference if the
  // broker container is reused. NATS subjects are hierarchical dots;
  // we keep the same structure as the Kafka topic naming so the
  // declaragent `agents.<id>.<channel>` convention carries over.
  return `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

async function waitFor<T>(
  pred: () => T | undefined,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = pred();
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

describeIntegration('fleet RPC round-trip over NATS', () => {
  const requestSubject = uniqueSubject('declaragent-rpc-beta-requests');
  const responseSubject = uniqueSubject('declaragent-rpc-alpha-responses');

  // One transport per "agent" — matches the real deployment where each
  // up-process gets its own NATS client.
  let alpha: Awaited<ReturnType<typeof createNatsTransport>>;
  let beta: Awaited<ReturnType<typeof createNatsTransport>>;

  beforeAll(async () => {
    alpha = await createNatsTransport({
      servers: SERVERS,
      clientName: 'declaragent-integration-alpha',
    });
    beta = await createNatsTransport({
      servers: SERVERS,
      clientName: 'declaragent-integration-beta',
    });
  });

  afterAll(async () => {
    await Promise.allSettled([alpha?.close(), beta?.close()]);
  });

  test('request/response pair traverses a real broker in under 2s', async () => {
    // Beta subscribes to incoming requests + echoes a response back.
    let betaReceived: AgentRpcEnvelope | null = null;
    beta.subscribe(requestSubject, async (env) => {
      betaReceived = env;
      await beta.publish(responseSubject, {
        version: 1,
        kind: 'response',
        messageId: `resp-${env.messageId}`,
        correlationId: env.correlationId,
        from: env.to,
        to: env.from,
        capability: env.capability,
        payload: { reply: 'pong', echoed: env.payload },
      });
    });

    let alphaReceived: AgentRpcEnvelope | null = null;
    alpha.subscribe(responseSubject, async (env) => {
      alphaReceived = env;
    });

    // NATS subscriptions are effective immediately but flush ensures
    // the SUB frames made it to the server before we PUB.
    await new Promise((r) => setTimeout(r, 100));

    const requestStart = Date.now();
    await alpha.publish(requestSubject, {
      version: 1,
      kind: 'request',
      messageId: 'alpha-req-1',
      correlationId: 'corr-1',
      from: 'agent://alpha',
      to: 'agent://beta',
      capability: 'beta.ping',
      payload: { hello: 'world' },
    });

    const response = await waitFor(() => alphaReceived ?? undefined, 5_000);
    const elapsed = Date.now() - requestStart;

    expect(betaReceived).not.toBeNull();
    expect(response.kind).toBe('response');
    expect(response.correlationId).toBe('corr-1');
    expect((response.payload as { reply: string }).reply).toBe('pong');
    expect(elapsed).toBeLessThan(2_000);
  });

  test('multi-subscription isolation: two handlers on one subject both receive', async () => {
    const subject = uniqueSubject('fanout');
    const hits: number[] = [];
    beta.subscribe(subject, async () => {
      hits.push(1);
    });
    beta.subscribe(subject, async () => {
      hits.push(2);
    });
    await new Promise((r) => setTimeout(r, 100));
    await alpha.publish(subject, {
      version: 1,
      kind: 'event',
      messageId: 'fanout-1',
      correlationId: 'corr-f1',
      from: 'agent://alpha',
      to: 'agent://beta',
      capability: 'beta.event',
      payload: {},
    });
    await waitFor(() => (hits.length >= 2 ? hits : undefined), 5_000);
    expect(hits.sort()).toEqual([1, 2]);
  });
});

// When disabled, surface a single test that documents how to run — so
// the file doesn't look empty in `bun test` output.
if (!ENABLED) {
  describe('fleet RPC round-trip over NATS (skipped)', () => {
    test('set NATS_INTEGRATION=1 + NATS_SERVERS to run', () => {
      expect(ENABLED).toBe(false);
    });
  });
}

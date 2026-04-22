/**
 * Fleet-over-real-broker integration test (Slice 7 of 0.6.0).
 *
 * Proves that `createKafkaTransport` carries a request/response pair
 * across two processes via a live Redpanda. This is the test that flips
 * AGENTS.md §3 "Multi-agent-over-real-broker integration test" out of
 * its ❌ status — the infrastructure works end-to-end.
 *
 * ## What this covers (in scope)
 * - Request envelope published to `agents.beta.requests` reaches the
 *   beta-side consumer.
 * - Response envelope published to `agents.alpha.responses` reaches the
 *   alpha-side consumer.
 * - Round-trip completes within 2s.
 *
 * ## What's deliberately NOT here (out of scope)
 * - Full `declaragent fleet run` boot with real LLM handlers. That
 *   needs a mocked provider + scaffolded fleet manifest; shipped as a
 *   follow-up once the skill-level harness stabilises.
 * - Failure-mode tests (broker crash, partition rebalance) — next
 *   vertical slice.
 *
 * ## How to run
 *
 * ```sh
 * cd packages/source-kafka
 * docker compose -f test/fixtures/docker-compose.yml up -d
 * cd ../..
 * FLEET_INTEGRATION=1 KAFKA_BROKERS=localhost:19092 bun test \
 *   packages/testkit/src/fleet-integration/kafka-rpc.test.ts
 * ```
 *
 * In CI this is driven by `.github/workflows/nightly-integration.yml`,
 * which boots Redpanda as a service container + sets the env vars
 * automatically.
 *
 * @since 0.6.0-slice.7
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import { createKafkaTransport } from '@declaragent/plugin-agent-rpc';

const ENABLED = process.env.FLEET_INTEGRATION === '1';
const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');

const describeIntegration = ENABLED ? describe : describe.skip;

function uniqueTopic(prefix: string): string {
  // Fresh topic per test run avoids cross-run dirty state in a reused
  // Redpanda container. Kafka auto-creates topics on first publish
  // when the cluster is configured for it (Redpanda default: on).
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

describeIntegration('fleet RPC round-trip over Kafka', () => {
  const requestTopic = uniqueTopic('declaragent-rpc-beta-requests');
  const responseTopic = uniqueTopic('declaragent-rpc-alpha-responses');

  // One transport per "agent" — matches the real deployment where each
  // up-process gets its own Kafka client.
  let alpha: Awaited<ReturnType<typeof createKafkaTransport>>;
  let beta: Awaited<ReturnType<typeof createKafkaTransport>>;

  beforeAll(async () => {
    alpha = await createKafkaTransport({
      brokers: BROKERS,
      clientId: 'declaragent-integration-alpha',
    });
    beta = await createKafkaTransport({
      brokers: BROKERS,
      clientId: 'declaragent-integration-beta',
    });
  });

  afterAll(async () => {
    await Promise.allSettled([alpha?.close(), beta?.close()]);
  });

  test('request/response pair traverses a real broker in under 2s', async () => {
    // Beta subscribes to incoming requests + echoes a response back.
    let betaReceived: AgentRpcEnvelope | null = null;
    beta.subscribe(requestTopic, async (env) => {
      betaReceived = env;
      await beta.publish(responseTopic, {
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
    alpha.subscribe(responseTopic, async (env) => {
      alphaReceived = env;
    });

    // Kafka consumer join is eventual — give it a moment before we
    // publish so the subscription is fully attached.
    await new Promise((r) => setTimeout(r, 1_000));

    const requestStart = Date.now();
    await alpha.publish(requestTopic, {
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

  test('multi-subscription isolation: two handlers on one topic both receive', async () => {
    const topic = uniqueTopic('fanout');
    const hits: number[] = [];
    beta.subscribe(topic, async () => {
      hits.push(1);
    });
    beta.subscribe(topic, async () => {
      hits.push(2);
    });
    await new Promise((r) => setTimeout(r, 1_000));
    await alpha.publish(topic, {
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
  describe('fleet RPC round-trip over Kafka (skipped)', () => {
    test('set FLEET_INTEGRATION=1 + KAFKA_BROKERS to run', () => {
      expect(ENABLED).toBe(false);
    });
  });
}

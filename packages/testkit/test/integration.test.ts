import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Logger } from '@declaragent/core';
import { createKafkaAdapter } from '@declaragent/source-kafka';
import type { KafkaTriggerConfig } from '@declaragent/source-kafka';
import { Kafka } from 'kafkajs';
import { evaluateAcceptance, runAcceptance } from '../src/load/harness.js';

/**
 * Env-gated acceptance test against a real Redpanda (`LOAD_INTEGRATION=1`).
 *
 * Defaults: 500 messages at 500 msg/sec (a 1-second smoke test),
 * p99 < 5000ms, zero missing. Override via env for a bigger run:
 *
 *   LOAD_INTEGRATION=1 \
 *   LOAD_BROKERS=localhost:19092 \
 *   LOAD_TOTAL=600000 \
 *   LOAD_RATE=1000 \
 *   LOAD_P99_MS=5000 \
 *   LOAD_CONTAINER=declaragent-testkit-redpanda \
 *   LOAD_BROKER_RESTART=1 \
 *   bun test test/integration.test.ts
 *
 * The full acceptance bar (1K/sec × 10min with broker restart) is:
 *   LOAD_TOTAL=600000  LOAD_RATE=1000  LOAD_BROKER_RESTART=1  LOAD_BROKER_AFTER=30000
 */

const ENABLED = process.env.LOAD_INTEGRATION === '1';
const BROKERS = (process.env.LOAD_BROKERS ?? 'localhost:19092').split(',');
const TOTAL = Number(process.env.LOAD_TOTAL ?? 500);
const RATE = Number(process.env.LOAD_RATE ?? 500);
const P99_MS = Number(process.env.LOAD_P99_MS ?? 5000);
const DRAIN_MS = Number(process.env.LOAD_DRAIN_MS ?? 60_000);

const describeIntegration = ENABLED ? describe : describe.skip;

const NOOP_LOGGER: Logger = {
  debug() {},
  info: (msg, meta) => console.log('[acc]', msg, meta ?? ''),
  warn: (msg, meta) => console.warn('[acc]', msg, meta ?? ''),
  error: (msg, meta) => console.error('[acc]', msg, meta ?? ''),
  child: () => NOOP_LOGGER,
};

describeIntegration('Kafka acceptance harness', () => {
  const runId = Math.random().toString(36).slice(2, 10);
  const topic = `declaragent-acc-${runId}`;
  const consumerGroup = `declaragent-acc-${runId}`;

  const adminKafka = new Kafka({ brokers: BROKERS, clientId: `acc-admin-${runId}` });
  const admin = adminKafka.admin();

  beforeAll(async () => {
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
      waitForLeaders: true,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await admin.deleteTopics({ topics: [topic] });
    } catch {
      // best-effort
    }
    await admin.disconnect();
  });

  test(
    'produces + consumes + measures p99',
    async () => {
      const config: KafkaTriggerConfig = {
        id: `acc-${runId}`,
        transport: {
          brokers: BROKERS,
          consumerGroup,
          topics: [topic],
          fromBeginning: true,
        },
        routing: {
          format: 'json',
          kindSelector: { const: 'trigger.fire' },
          targetSelector: { type: 'broadcast' },
        },
        delivery: {
          mode: 'at-least-once',
          ackStrategy: 'after-publish',
          maxRetries: 1,
          retryBackoff: { initialMs: 10, maxMs: 100, jitter: false },
          idempotency: { strategy: 'transport-natural', ttlMs: 60_000, store: 'memory' },
        },
        limits: { concurrency: 8, maxInflight: 1000 },
      };

      const adapter = createKafkaAdapter();
      const result = await runAcceptance({
        adapter,
        sourceConfig: config,
        totalMessages: TOTAL,
        ratePerSec: RATE,
        producerBrokers: BROKERS,
        topic,
        drainTimeoutMs: DRAIN_MS,
        logger: NOOP_LOGGER,
        ...(process.env.LOAD_BROKER_RESTART === '1' && {
          brokerRestart: {
            container: process.env.LOAD_CONTAINER ?? 'declaragent-testkit-redpanda',
            afterMs: Number(process.env.LOAD_BROKER_AFTER ?? 15_000),
            mode: 'kill-then-start',
            downMs: Number(process.env.LOAD_BROKER_DOWN_MS ?? 15_000),
          },
        }),
      });

      console.log('acceptance result:', {
        produced: result.produced,
        unique: result.tracker.unique,
        missing: result.tracker.missing,
        duplicates: result.tracker.duplicates,
        p99: result.tracker.latency.p99,
        p50: result.tracker.latency.p50,
        rate: result.producerActualRatePerSec,
      });

      const verdict = evaluateAcceptance(result, { p99LatencyMs: P99_MS, missing: 0 });
      if (!verdict.passed) {
        console.error('acceptance failed:', verdict.failures);
      }
      expect(result.tracker.missing).toBe(0);
      expect(result.tracker.unique).toBe(TOTAL);
      expect(verdict.passed).toBe(true);
    },
    // Overall test timeout = drain timeout + plenty of slack for 600K msgs.
    (DRAIN_MS + TOTAL / Math.max(1, RATE)) * 1000 + 120_000,
  );
});

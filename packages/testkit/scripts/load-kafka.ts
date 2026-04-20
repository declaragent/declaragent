#!/usr/bin/env bun
/**
 * `bun run load:kafka` — runnable Kafka acceptance scenario.
 *
 * Defaults match slice-16's acceptance bar (1K msg/sec for 10 minutes,
 * p99 < 5 s, zero messages unaccounted). Override via flags:
 *
 *   bun run load:kafka \
 *     --brokers localhost:19092 \
 *     --topic declaragent-acc \
 *     --total 600000 \
 *     --rate 1000 \
 *     --p99 5000 \
 *     --restart-container declaragent-testkit-redpanda \
 *     --restart-after-ms 30000
 *
 * Exits 0 on pass, 1 on any acceptance threshold violation. Use in CI
 * nightly or as a release gate.
 */

import type { Logger } from '@declaragent/core';
import { createKafkaAdapter } from '@declaragent/source-kafka';
import type { KafkaTriggerConfig } from '@declaragent/source-kafka';
import { Kafka } from 'kafkajs';
import { evaluateAcceptance, runAcceptance } from '../src/load/harness.js';

interface Flags {
  brokers: string[];
  topic: string;
  total: number;
  rate: number;
  p99Ms: number;
  drainMs: number;
  restartContainer?: string;
  restartAfterMs?: number;
  restartDownMs?: number;
  consumerGroup: string;
  createTopic: boolean;
  deleteTopic: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  const out: Flags = {
    brokers: ['localhost:19092'],
    topic: `declaragent-acc-${Date.now()}`,
    total: 600_000,
    rate: 1000,
    p99Ms: 5000,
    drainMs: 60_000,
    consumerGroup: `declaragent-acc-${Date.now()}`,
    createTopic: true,
    deleteTopic: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const v = argv[i + 1];
    if (flag === '--brokers' && v) {
      out.brokers = v.split(',');
      i += 1;
    } else if (flag === '--topic' && v) {
      out.topic = v;
      i += 1;
    } else if (flag === '--total' && v) {
      out.total = Number(v);
      i += 1;
    } else if (flag === '--rate' && v) {
      out.rate = Number(v);
      i += 1;
    } else if (flag === '--p99' && v) {
      out.p99Ms = Number(v);
      i += 1;
    } else if (flag === '--drain-ms' && v) {
      out.drainMs = Number(v);
      i += 1;
    } else if (flag === '--restart-container' && v) {
      out.restartContainer = v;
      i += 1;
    } else if (flag === '--restart-after-ms' && v) {
      out.restartAfterMs = Number(v);
      i += 1;
    } else if (flag === '--restart-down-ms' && v) {
      out.restartDownMs = Number(v);
      i += 1;
    } else if (flag === '--consumer-group' && v) {
      out.consumerGroup = v;
      i += 1;
    } else if (flag === '--keep-topic') {
      out.deleteTopic = false;
    } else if (flag === '--no-create-topic') {
      out.createTopic = false;
    }
  }
  return out;
}

const LOGGER: Logger = {
  debug() {},
  info: (msg, meta) => console.log(`[acc] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`[acc] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`[acc] ${msg}`, meta ?? ''),
  child: () => LOGGER,
};

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  console.log('running kafka acceptance with:', flags);

  const kafka = new Kafka({ brokers: flags.brokers, clientId: 'acc-admin' });
  const admin = kafka.admin();
  await admin.connect();
  if (flags.createTopic) {
    try {
      await admin.createTopics({
        topics: [{ topic: flags.topic, numPartitions: 1, replicationFactor: 1 }],
        waitForLeaders: true,
      });
    } catch (err) {
      console.warn('createTopics failed (may already exist):', err);
    }
  }

  try {
    const config: KafkaTriggerConfig = {
      id: 'acc',
      transport: {
        brokers: flags.brokers,
        consumerGroup: flags.consumerGroup,
        topics: [flags.topic],
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
      totalMessages: flags.total,
      ratePerSec: flags.rate,
      producerBrokers: flags.brokers,
      topic: flags.topic,
      drainTimeoutMs: flags.drainMs,
      logger: LOGGER,
      ...(flags.restartContainer && flags.restartAfterMs !== undefined
        ? {
            brokerRestart: {
              container: flags.restartContainer,
              afterMs: flags.restartAfterMs,
              mode: 'kill-then-start' as const,
              ...(flags.restartDownMs !== undefined && { downMs: flags.restartDownMs }),
            },
          }
        : {}),
    });

    const verdict = evaluateAcceptance(result, { p99LatencyMs: flags.p99Ms, missing: 0 });
    console.log('\n=== ACCEPTANCE RESULT ===');
    console.log(`produced: ${result.produced}`);
    console.log(`unique:   ${result.tracker.unique}`);
    console.log(`missing:  ${result.tracker.missing}`);
    console.log(`duplicates: ${result.tracker.duplicates}`);
    console.log(
      `rate:     target=${flags.rate} actual=${result.producerActualRatePerSec.toFixed(1)} msg/sec`,
    );
    console.log(
      `latency:  p50=${result.tracker.latency.p50.toFixed(0)}ms p95=${result.tracker.latency.p95.toFixed(0)}ms p99=${result.tracker.latency.p99.toFixed(0)}ms max=${result.tracker.latency.max.toFixed(0)}ms`,
    );
    if (result.brokerRestartedAt !== null) {
      console.log(`broker restart: ${new Date(result.brokerRestartedAt).toISOString()}`);
    }
    if (verdict.passed) {
      console.log('\n✓ PASS');
      return 0;
    }
    console.error('\n✗ FAIL');
    for (const f of verdict.failures) console.error(`  - ${f}`);
    return 1;
  } finally {
    if (flags.deleteTopic) {
      try {
        await admin.deleteTopics({ topics: [flags.topic] });
      } catch {
        // best-effort
      }
    }
    await admin.disconnect();
  }
}

void main().then((code) => process.exit(code));

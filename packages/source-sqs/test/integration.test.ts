import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import {
  type AgentEvent,
  type DeliveryConfig,
  type LimitsConfig,
  type Logger,
  type MessageNormalizer,
  type RawMessage,
  type RoutingConfig,
  type SourceDependencies,
  createEventBus,
} from '@declaragent/core';
import { createSqsAdapter } from '../src/adapter.js';
import type { SqsTriggerConfig } from '../src/config.js';

/**
 * Env-gated integration test. Set `SQS_INTEGRATION=1` to run; otherwise
 * everything is skipped so CI stays green without LocalStack.
 *
 * Boot LocalStack first:
 *   docker compose -f test/fixtures/docker-compose.yml up -d
 *   SQS_INTEGRATION=1 bun test test/integration.test.ts
 */

const ENABLED = process.env.SQS_INTEGRATION === '1';
const ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
const REGION = process.env.SQS_REGION ?? 'us-east-1';

const describeIntegration = ENABLED ? describe : describe.skip;

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function passthroughNormalizer(): MessageNormalizer {
  return {
    async normalize(raw: RawMessage): Promise<AgentEvent | null> {
      const text = typeof raw.value === 'string' ? raw.value : new TextDecoder().decode(raw.value);
      return {
        id: `evt-${raw.meta?.messageId ?? text}`,
        kind: 'trigger.fire',
        source: { type: 'self', reason: 'wakeup' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: text,
        auth: { kind: 'internal' },
      };
    },
  };
}

const DELIVERY: DeliveryConfig = {
  mode: 'at-least-once',
  ackStrategy: 'after-publish',
  maxRetries: 2,
  retryBackoff: { initialMs: 10, maxMs: 100, jitter: false },
  idempotency: { strategy: 'transport-natural', ttlMs: 60_000, store: 'memory' },
};

const LIMITS: LimitsConfig = { concurrency: 2, maxInflight: 50 };

const ROUTING: RoutingConfig = {
  format: 'json',
  kindSelector: { const: 'trigger.fire' },
  targetSelector: { type: 'broadcast' },
};

function waitFor(pred: () => boolean, timeoutMs = 15_000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor: timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describeIntegration('SqsSourceInstance (LocalStack)', () => {
  const runId = Math.random().toString(36).slice(2, 10);
  const queueName = `declaragent-it-${runId}`;
  let queueUrl = '';

  const awsClient = new SQSClient({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  beforeAll(async () => {
    const out = await awsClient.send(new CreateQueueCommand({ QueueName: queueName }));
    queueUrl = out.QueueUrl ?? '';
    if (!queueUrl) {
      // Fallback to lookup if CreateQueue didn't return the URL.
      const found = await awsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
      queueUrl = found.QueueUrl ?? '';
    }
    if (!queueUrl) throw new Error('failed to provision integration queue');
  }, 30_000);

  afterAll(async () => {
    if (queueUrl) {
      try {
        await awsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      } catch {
        // best effort
      }
    }
    awsClient.destroy();
  });

  test('consumes messages + publishes to the bus', async () => {
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      received.push(e);
    });

    const deps: SourceDependencies = {
      bus,
      logger: NOOP_LOGGER,
      configDir: '/tmp',
      normalizer: passthroughNormalizer(),
    };
    const config: SqsTriggerConfig = {
      id: `it-${runId}`,
      transport: {
        queueUrl,
        region: REGION,
        endpoint: ENDPOINT,
        accessKeyId: 'test',
        secretAccessKey: 'test',
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 10,
        visibilityRenewalMs: 0,
        maxMessages: 10,
      },
      routing: ROUTING,
      delivery: DELIVERY,
      limits: LIMITS,
    };

    const adapter = createSqsAdapter();
    const instance = await adapter.create(config, deps);
    await instance.start();

    try {
      await awsClient.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: 'hello' }));
      await awsClient.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: 'world' }));

      await waitFor(() => received.length >= 2);
      const payloads = received.map((e) => e.payload).sort();
      expect(payloads).toEqual(['hello', 'world']);
      expect(instance.metrics().messagesProcessed).toBeGreaterThanOrEqual(2);
    } finally {
      await instance.stop('integration-test-end');
    }
  }, 60_000);
});

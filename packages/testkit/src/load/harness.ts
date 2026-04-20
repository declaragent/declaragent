/**
 * Top-level acceptance harness for the Kafka adapter.
 *
 * Orchestrates:
 *   1. Create topic (admin)
 *   2. Start a `KafkaSourceInstance` pointed at the topic
 *   3. Start the `LoadTracker` on the bus
 *   4. Kick off the `runKafkaLoadProducer`
 *   5. Optionally schedule broker restart
 *   6. Wait for (produced - drops) events to arrive, or a timeout
 *   7. Produce a `LoadReport` with all the acceptance numbers
 *
 * Callers supply the adapter + deps so the harness can run against a
 * stubbed client (unit tests) or a real Redpanda container
 * (integration).
 */

import {
  type AgentEvent,
  type DeliveryConfig,
  type EventSourceAdapter,
  type EventSourceInstance,
  type LimitsConfig,
  type Logger,
  type MessageNormalizer,
  type RawMessage,
  type RoutingConfig,
  type SourceDependencies,
  createEventBus,
} from '@declaragent/core';
import { type DockerControl, createDockerControl } from './broker-control.js';
import { runKafkaLoadProducer } from './kafka-producer.js';
import { LoadTracker, type LoadTrackerReport } from './tracker.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

/** Passthrough normalizer preserves headers + value on event.payload. */
export function passthroughNormalizer(): MessageNormalizer {
  return {
    async normalize(raw: RawMessage): Promise<AgentEvent | null> {
      return {
        id: `evt-${raw.meta?.messageId ?? Math.random()}`,
        kind: 'trigger.fire',
        source: { type: 'self', reason: 'wakeup' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: {
          headers: raw.headers ?? {},
          value: raw.value,
        },
        auth: { kind: 'internal' },
      };
    },
  };
}

export interface BrokerRestartPlan {
  /** Container name (e.g. `declaragent-kafka-redpanda`). */
  container: string;
  /** Delay before the restart (ms from harness start). */
  afterMs: number;
  /** How to perform the restart. Default: SIGKILL then `docker start`. */
  mode?: 'kill-then-start' | 'restart';
  /**
   * For `kill-then-start`, how long to stay down before restart.
   * Default: 15_000.
   */
  downMs?: number;
  /**
   * Injected `DockerControl` for tests that don't have docker available.
   * Default: `createDockerControl({})`.
   */
  control?: DockerControl;
}

export interface AcceptanceConfig {
  adapter: EventSourceAdapter<unknown>;
  sourceConfig: unknown;
  /** How many messages to produce. */
  totalMessages: number;
  /** Target msg/sec on the producer side. */
  ratePerSec: number;
  /** Brokers list (passed to kafkajs for the load producer). */
  producerBrokers: readonly string[];
  /** Destination topic. Must match `sourceConfig.transport.topics[0]`. */
  topic: string;
  /** Ack strategy the adapter runs with. Default `after-publish`. */
  delivery?: Partial<DeliveryConfig>;
  limits?: Partial<LimitsConfig>;
  routing?: Partial<RoutingConfig>;
  /**
   * Max wait (ms) for unique count to reach `totalMessages` after the
   * producer is done. Default: 60_000.
   */
  drainTimeoutMs?: number;
  /**
   * Broker restart plan, if any. Omit for a straight load test.
   */
  brokerRestart?: BrokerRestartPlan;
  /** Custom logger. Default noop. */
  logger?: Logger;
  /** Forwarded to the source. Default: an injected `passthroughNormalizer`. */
  normalizer?: MessageNormalizer;
}

export interface AcceptanceResult {
  produced: number;
  producerElapsedMs: number;
  producerActualRatePerSec: number;
  producerSendErrors: number;
  waitElapsedMs: number;
  tracker: LoadTrackerReport;
  brokerRestartedAt: number | null;
}

const DEFAULT_DELIVERY: DeliveryConfig = {
  mode: 'at-least-once',
  ackStrategy: 'after-publish',
  maxRetries: 2,
  retryBackoff: { initialMs: 10, maxMs: 100, jitter: false },
  idempotency: { strategy: 'transport-natural', ttlMs: 60_000, store: 'memory' },
};

const DEFAULT_LIMITS: LimitsConfig = { concurrency: 8, maxInflight: 1000 };

const DEFAULT_ROUTING: RoutingConfig = {
  format: 'json',
  kindSelector: { const: 'trigger.fire' },
  targetSelector: { type: 'broadcast' },
};

/**
 * Run one acceptance scenario against a prepared Kafka (or stub)
 * environment. The adapter + sourceConfig are caller-controlled so the
 * same harness works for Kafka, SQS, or test stubs.
 */
export async function runAcceptance(config: AcceptanceConfig): Promise<AcceptanceResult> {
  const logger = config.logger ?? NOOP_LOGGER;
  const bus = createEventBus({ logger });
  const normalizer = config.normalizer ?? passthroughNormalizer();

  const effectiveDelivery: DeliveryConfig = { ...DEFAULT_DELIVERY, ...(config.delivery ?? {}) };
  // Thread adapter-specific overrides through a cheap cast — the harness
  // doesn't need to know the exact shape.
  const baseConfig = config.sourceConfig as Record<string, unknown>;
  const mergedConfig = {
    ...baseConfig,
    routing: {
      ...DEFAULT_ROUTING,
      ...(baseConfig.routing as object | undefined),
      ...(config.routing ?? {}),
    },
    delivery: effectiveDelivery,
    limits: {
      ...DEFAULT_LIMITS,
      ...(baseConfig.limits as object | undefined),
      ...(config.limits ?? {}),
    },
  };

  const deps: SourceDependencies = {
    bus,
    logger,
    configDir: '/tmp',
    normalizer,
  };
  config.adapter.validateConfig(mergedConfig);
  const instance: EventSourceInstance = await config.adapter.create(mergedConfig, deps);

  const tracker = new LoadTracker({ bus, expected: config.totalMessages });
  tracker.start();
  await instance.start();

  const harnessStart = Date.now();
  let brokerRestartedAt: number | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  // Schedule broker restart if requested.
  if (config.brokerRestart) {
    const plan = config.brokerRestart;
    const control = plan.control ?? createDockerControl({ logCommand: (s) => logger.info(s) });
    restartTimer = setTimeout(() => {
      void (async () => {
        brokerRestartedAt = Date.now();
        try {
          if (plan.mode === 'restart') {
            await control.restart(plan.container);
          } else {
            await control.kill(plan.container, 'SIGKILL');
            await new Promise((r) => setTimeout(r, plan.downMs ?? 15_000));
            await control.start(plan.container);
          }
          logger.info('broker restarted', { at: brokerRestartedAt });
        } catch (err) {
          logger.error('broker-restart.error', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, plan.afterMs);
  }

  try {
    const producerResult = await runKafkaLoadProducer({
      brokers: config.producerBrokers,
      topic: config.topic,
      ratePerSec: config.ratePerSec,
      totalMessages: config.totalMessages,
      logLabel: 'acceptance',
    });

    // Wait for the tracker to see `totalMessages` unique sequences, or
    // the drain timeout — whichever comes first.
    const drainTimeoutMs = config.drainTimeoutMs ?? 60_000;
    const waitStart = Date.now();
    while (
      tracker.uniqueCount() < config.totalMessages &&
      Date.now() - waitStart < drainTimeoutMs
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const waitElapsedMs = Date.now() - waitStart;
    const report = tracker.report();

    return {
      produced: producerResult.produced,
      producerElapsedMs: producerResult.elapsedMs,
      producerActualRatePerSec: producerResult.actualRatePerSec,
      producerSendErrors: producerResult.sendErrors,
      waitElapsedMs,
      tracker: report,
      brokerRestartedAt,
    };
  } finally {
    if (restartTimer) clearTimeout(restartTimer);
    tracker.stop();
    await instance.stop('acceptance-end');
    void harnessStart; // keep the reference for readability; unused by the return
  }
}

export interface AcceptanceThresholds {
  /** Maximum allowed p99 latency in ms. Default: 5000 (1K msg/sec / p99 < 5s). */
  p99LatencyMs?: number;
  /** Max missing count. Default: 0. */
  missing?: number;
  /** Max duplicate count. Default: Infinity (at-least-once — dups are allowed unless the caller cares). */
  duplicates?: number;
  /** Max send errors on the producer side. Default: 0. */
  sendErrors?: number;
}

export interface AcceptanceVerdict {
  passed: boolean;
  failures: readonly string[];
}

/**
 * Apply the acceptance thresholds to a `runAcceptance` result. Returns
 * a `{ passed, failures[] }` record so callers can decide whether to
 * exit non-zero.
 */
export function evaluateAcceptance(
  result: AcceptanceResult,
  thresholds: AcceptanceThresholds = {},
): AcceptanceVerdict {
  const failures: string[] = [];
  const p99Limit = thresholds.p99LatencyMs ?? 5000;
  const missingLimit = thresholds.missing ?? 0;
  const dupsLimit = thresholds.duplicates ?? Number.POSITIVE_INFINITY;
  const sendErrorsLimit = thresholds.sendErrors ?? 0;

  if (result.tracker.latency.p99 > p99Limit) {
    failures.push(
      `p99 latency ${result.tracker.latency.p99.toFixed(0)}ms exceeds limit ${p99Limit}ms`,
    );
  }
  if (result.tracker.missing > missingLimit) {
    failures.push(`missing ${result.tracker.missing} messages (limit ${missingLimit})`);
  }
  if (result.tracker.duplicates > dupsLimit) {
    failures.push(`duplicates ${result.tracker.duplicates} exceeds limit ${dupsLimit}`);
  }
  if (result.producerSendErrors > sendErrorsLimit) {
    failures.push(`producer send errors ${result.producerSendErrors} (limit ${sendErrorsLimit})`);
  }
  return { passed: failures.length === 0, failures };
}

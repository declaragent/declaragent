import type { DeliveryConfig, LimitsConfig, RoutingConfig } from '@declaragent/core';

/**
 * SQS adapter configuration. The queue URL is the authority — region is
 * derived if not supplied (AWS URLs embed the region as a subdomain).
 */
export interface SqsTriggerConfig {
  id: string;
  transport: {
    queueUrl: string;
    /** Required for LocalStack + custom endpoints; default inferred from queueUrl. */
    region?: string;
    /** LocalStack / test-double endpoint override. */
    endpoint?: string;
    /**
     * Long-poll wait time (seconds). Clamped to `[0, 20]` by SQS. Defaults
     * to 20 — the maximum — so an idle consumer makes roughly 3 API calls
     * per minute.
     */
    waitTimeSeconds?: number;
    /** Per-receive visibility timeout override. Defaults to the queue's setting. */
    visibilityTimeoutSeconds?: number;
    /** Max messages per poll. SQS caps at 10. Defaults to 10. */
    maxMessages?: number;
    /**
     * Renew the visibility timeout this many ms before it expires while a
     * handler is still running. Defaults to half the visibility timeout.
     * Set `0` to disable renewal.
     */
    visibilityRenewalMs?: number;
    /**
     * Static credentials. Only use when the default chain isn't viable.
     * Prefer IAM role / instance profile / env vars.
     */
    accessKeyId?: string;
    /** Paired with `accessKeyId`. */
    secretAccessKey?: string;
    /** Paired with `accessKeyId` (optional — for STS temporary creds). */
    sessionToken?: string;
  };
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
}

const AWS_QUEUE_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/?$/;
const AWS_REGION_FROM_URL = /sqs\.([a-z0-9-]+)\.amazonaws\.com/;

/** Best-effort region extraction from a standard SQS URL. Returns `undefined` otherwise. */
export function regionFromQueueUrl(url: string): string | undefined {
  const m = AWS_REGION_FROM_URL.exec(url);
  return m?.[1];
}

export function assertSqsConfig(config: unknown): asserts config is SqsTriggerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('sqs trigger config must be an object');
  }
  const c = config as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('sqs config requires non-empty "id"');
  }

  // transport
  if (!c.transport || typeof c.transport !== 'object') {
    throw new Error('sqs config requires "transport"');
  }
  const t = c.transport as Record<string, unknown>;
  if (typeof t.queueUrl !== 'string' || t.queueUrl.length === 0) {
    throw new Error('sqs config requires "transport.queueUrl"');
  }
  // Region must be explicit unless the URL encodes it (AWS standard) or
  // an `endpoint` override is given (LocalStack).
  if (t.region === undefined && t.endpoint === undefined) {
    if (!AWS_QUEUE_URL.test(t.queueUrl) || regionFromQueueUrl(t.queueUrl) === undefined) {
      throw new Error(
        'sqs config: cannot infer region from queueUrl. Set "transport.region" or "transport.endpoint".',
      );
    }
  }

  if (t.waitTimeSeconds !== undefined) {
    const v = Number(t.waitTimeSeconds);
    if (!Number.isFinite(v) || v < 0 || v > 20) {
      throw new Error('sqs transport.waitTimeSeconds must be between 0 and 20');
    }
  }
  if (t.maxMessages !== undefined) {
    const v = Number(t.maxMessages);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      throw new Error('sqs transport.maxMessages must be an integer between 1 and 10');
    }
  }
  if (t.visibilityTimeoutSeconds !== undefined) {
    const v = Number(t.visibilityTimeoutSeconds);
    if (!Number.isInteger(v) || v < 0 || v > 43_200) {
      throw new Error(
        'sqs transport.visibilityTimeoutSeconds must be an integer between 0 and 43200',
      );
    }
  }

  if ((t.accessKeyId !== undefined) !== (t.secretAccessKey !== undefined)) {
    throw new Error('sqs transport.accessKeyId and secretAccessKey must be set together');
  }

  // routing / delivery / limits — downstream validators handle their own
  // fields; just fail fast on wholly-missing sections.
  if (!c.routing || typeof c.routing !== 'object') {
    throw new Error('sqs config requires "routing"');
  }
  if (!c.delivery || typeof c.delivery !== 'object') {
    throw new Error('sqs config requires "delivery"');
  }
  if (!c.limits || typeof c.limits !== 'object') {
    throw new Error('sqs config requires "limits"');
  }
}

export function isFifoQueue(queueUrl: string): boolean {
  return queueUrl.endsWith('.fifo');
}

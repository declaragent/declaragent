import {
  type AckContext,
  BaseSourceInstance,
  type EventSourceTag,
  type NormalizeContext,
  type RawMessage,
  type SourceDependencies,
} from '@declaragent/core';
import type { AmqpChannel, AmqpClient, AmqpIncomingMessage } from './client.js';
import type { AmqpTriggerConfig } from './config.js';

const DELIVERY_COUNT_HEADER = 'x-declaragent-delivery-count';
const DEFAULT_DLX_EXCHANGE_TYPE = 'topic';

interface XDeathEntry {
  count: number;
  queue: string;
  exchange: string;
  reason: string;
  'routing-keys'?: string[];
}

/**
 * AMQP (RabbitMQ) source instance. Subclasses `BaseSourceInstance` for
 * retry / DLQ / metrics / concurrency; this class wires the `amqplib`
 * lifecycle + prefetch + publisher confirms for DLX.
 *
 * DLQ strategy: publish to the configured DLX exchange with publisher
 * confirms. Retry within the adapter's `maxRetries` budget first; on
 * exhaustion, `sendToDLQ` publishes to the DLX and the base class acks.
 * If no DLQ is configured, `sendToDLQ` logs and the base class still
 * acks (drop-on-exhaustion) to avoid poison-message loops.
 *
 * Delivery-count tracking is a best-effort composite: the adapter
 * honors RabbitMQ's native `x-death` header (populated when a dead-
 * letter exchange re-delivers a message), an explicit
 * `x-declaragent-delivery-count` header (set by upstream publishers),
 * and a local per-`messageId`/per-`deliveryTag` counter. The highest of
 * the three wins.
 */
export class AmqpSourceInstance extends BaseSourceInstance {
  private readonly amqpConfig: AmqpTriggerConfig;
  private readonly client: AmqpClient;

  private channel: AmqpChannel | null = null;
  private consumerTag: string | null = null;
  private connected = false;
  private resolvedPrefetch = 0;

  /**
   * Best-effort local attempt counter. Keyed by `properties.messageId`
   * when available, falling back to the current `deliveryTag`. Neither
   * key survives a connection drop; base-class retry budgeting is
   * deliberately conservative under that failure mode.
   */
  private readonly attemptCounts = new Map<string, number>();

  constructor(config: AmqpTriggerConfig, deps: SourceDependencies, client: AmqpClient) {
    super({
      type: 'amqp',
      config: {
        id: config.id,
        routing: config.routing,
        delivery: config.delivery,
        limits: config.limits,
      },
      deps,
    });
    this.amqpConfig = config;
    this.client = client;
  }

  // ── BaseSourceInstance lifecycle ───────────────────────────────────────

  protected async doStart(): Promise<void> {
    try {
      await this.client.connect();
    } catch (err) {
      this.recordConnectionError();
      throw err;
    }
    this.connected = true;

    try {
      this.channel = await this.client.createConfirmChannel();
    } catch (err) {
      this.recordConnectionError();
      // Best-effort close of the underlying connection; ignore secondary errors.
      await this.client.close().catch(() => {});
      this.connected = false;
      throw err;
    }

    const transport = this.amqpConfig.transport;

    // Compute prefetch: explicit override > limits.maxInflight. We also
    // clamp at `limits.maxInflight` so the broker never hands us more
    // than the adapter can handle in-flight.
    const requested = transport.prefetch ?? this.amqpConfig.limits.maxInflight;
    this.resolvedPrefetch = Math.min(
      Math.max(1, Math.floor(requested)),
      this.amqpConfig.limits.maxInflight,
    );

    // Declare source exchange + queue + bindings. Order matters: the
    // bindings fail fast if either side is missing.
    if (transport.exchange !== undefined) {
      await this.channel.assertExchange(transport.exchange, 'topic', { durable: true });
    }
    await this.channel.assertQueue(transport.queue, {
      durable: transport.durable ?? true,
      autoDelete: transport.autoDelete ?? false,
    });
    if (transport.exchange !== undefined && transport.bindingPatterns) {
      for (const pattern of transport.bindingPatterns) {
        await this.channel.bindQueue(transport.queue, transport.exchange, pattern);
      }
    }

    // DLX declaration. Default is `declare: true` so operators can set
    // DLQ targets by name alone; opt out by setting `declare: false` when
    // the exchange is already managed elsewhere.
    const dlq = this.amqpConfig.dlq;
    if (dlq && dlq.declare !== false) {
      await this.channel.assertExchange(
        dlq.exchange,
        dlq.exchangeType ?? DEFAULT_DLX_EXCHANGE_TYPE,
        {
          durable: true,
        },
      );
    }

    await this.channel.prefetch(this.resolvedPrefetch, false);

    const reply = await this.channel.consume(transport.queue, (msg) => this.onAmqpMessage(msg));
    this.consumerTag = reply.consumerTag;
    this.markConnected();
  }

  protected async doStop(_reason?: string): Promise<void> {
    if (this.channel) {
      if (this.consumerTag) {
        try {
          await this.channel.cancel(this.consumerTag);
        } catch (err) {
          this.deps.logger.warn('amqp.consumer.cancel.error', {
            id: this.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        this.consumerTag = null;
      }
      try {
        await this.channel.close();
      } catch (err) {
        this.deps.logger.warn('amqp.channel.close.error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.channel = null;
    }
    if (this.connected) {
      try {
        await this.client.close();
      } catch (err) {
        this.deps.logger.warn('amqp.client.close.error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.connected = false;
    }
    this.attemptCounts.clear();
  }

  protected async doPause(): Promise<void> {
    if (!this.channel || !this.consumerTag) return;
    try {
      await this.channel.cancel(this.consumerTag);
    } catch (err) {
      this.deps.logger.warn('amqp.pause.cancel.error', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    this.consumerTag = null;
  }

  protected async doResume(): Promise<void> {
    if (!this.channel) return;
    if (this.consumerTag) return; // already consuming
    const reply = await this.channel.consume(this.amqpConfig.transport.queue, (msg) =>
      this.onAmqpMessage(msg),
    );
    this.consumerTag = reply.consumerTag;
  }

  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {
      url: this.amqpConfig.transport.url,
      queue: this.amqpConfig.transport.queue,
      prefetch: this.resolvedPrefetch,
      connected: this.connected,
      pendingRetries: this.attemptCounts.size,
    };
  }

  protected async sendToDLQ(raw: RawMessage, err: Error): Promise<void> {
    const dlq = this.amqpConfig.dlq;
    if (!dlq || !this.channel) {
      this.deps.logger.warn('amqp.dlq.not-configured', {
        id: this.id,
        messageId: raw.meta?.messageId,
        routingKey: raw.routingKey,
      });
      return;
    }

    // Fallback: when dlq.routingKey is omitted, re-use the original
    // message's routing key so DLX consumers can apply the same topology.
    const routingKey = dlq.routingKey ?? raw.routingKey ?? '';
    const content = this.toBuffer(raw.value);
    const headers: Record<string, unknown> = {
      'x-declaragent-dlq-reason': err.message,
      'x-declaragent-origin-queue': this.amqpConfig.transport.queue,
      'x-declaragent-origin-routing-key': String(raw.routingKey ?? ''),
      ...(raw.meta?.messageId !== undefined && {
        'x-declaragent-origin-message-id': String(raw.meta.messageId),
      }),
    };

    await this.channel.publish(dlq.exchange, routingKey, content, {
      headers,
      persistent: true,
      ...(raw.meta?.messageId !== undefined && { messageId: String(raw.meta.messageId) }),
    });
  }

  // ── Message pipeline ───────────────────────────────────────────────────

  private async onAmqpMessage(msg: AmqpIncomingMessage): Promise<void> {
    const deliveryTag = msg.fields.deliveryTag;
    const tagKey = this.tagKey(msg);
    const localAttempts = this.attemptCounts.get(tagKey) ?? 0;

    // Headers: keep the original property bag under `raw.headers` so
    // downstream consumers can inspect app-level headers verbatim.
    const headers: Record<string, unknown> = {};
    if (msg.properties.headers) {
      for (const [k, v] of Object.entries(msg.properties.headers)) {
        headers[k] = v;
      }
    }

    // Compose delivery count from the best-available source:
    //   1. RabbitMQ's native `x-death` header (set after DLX redelivery).
    //   2. An app-supplied `x-declaragent-delivery-count` header.
    //   3. Our own local counter.
    // Also bump to at least 1 when `msg.fields.redelivered === true` so
    // the very first redelivery isn't silently treated as attempt 0.
    const xDeath = extractXDeathCount(msg.properties.headers);
    const headerAttempt = headers[DELIVERY_COUNT_HEADER];
    const headerCount = typeof headerAttempt === 'number' ? headerAttempt : Number(headerAttempt);
    const redeliveredFloor = msg.fields.redelivered ? 1 : 0;
    const deliveryCount = Math.max(
      localAttempts,
      Number.isFinite(headerCount) ? headerCount : 0,
      xDeath,
      redeliveredFloor,
    );

    const meta: Record<string, unknown> = {
      messageId: msg.properties.messageId ?? `${tagKey}`,
      deliveryTag,
      redelivered: msg.fields.redelivered,
      deliveryCount,
      consumerTag: msg.fields.consumerTag,
      exchange: msg.fields.exchange,
      ...(msg.properties.correlationId !== undefined && {
        correlationId: msg.properties.correlationId,
      }),
    };

    const raw: RawMessage = {
      value: msg.content,
      routingKey: msg.fields.routingKey,
      headers,
      ...(msg.properties.timestamp !== undefined && { timestamp: msg.properties.timestamp }),
      meta,
    };

    const ack = this.buildAckContext(deliveryTag, tagKey, meta.messageId as string);
    await this.handleMessage(raw, ack);
  }

  private buildAckContext(deliveryTag: number, tagKey: string, messageId: string): AckContext {
    return {
      messageId,
      ack: async () => {
        if (!this.channel) return;
        this.channel.ack(deliveryTag, false);
        this.attemptCounts.delete(tagKey);
      },
      nack: async () => {
        if (!this.channel) return;
        // Bump local counter before asking the broker to redeliver.
        const next = (this.attemptCounts.get(tagKey) ?? 0) + 1;
        this.attemptCounts.set(tagKey, next);
        // requeue=true — RabbitMQ will redeliver to any consumer on the
        // queue (possibly this one). For adapter-managed DLQ on retry
        // exhaustion, `sendToDLQ` publishes to DLX and the base class
        // then ack()s to remove the message from the source queue.
        this.channel.nack(deliveryTag, false, true);
      },
    };
  }

  private tagKey(msg: AmqpIncomingMessage): string {
    // Prefer `messageId` because it survives requeue; fall back to the
    // delivery tag (unique per channel, per unacked message).
    if (msg.properties.messageId !== undefined && msg.properties.messageId !== '') {
      return `mid:${msg.properties.messageId}`;
    }
    return `tag:${msg.fields.deliveryTag}`;
  }

  private toBuffer(value: string | Uint8Array): Uint8Array {
    return typeof value === 'string' ? new TextEncoder().encode(value) : value;
  }

  protected override buildNormalizeContext(raw: RawMessage): NormalizeContext {
    const meta = raw.meta ?? {};
    const source: EventSourceTag = {
      type: 'amqp',
      triggerId: this.id,
      exchange: String(meta.exchange ?? ''),
      routingKey: String(raw.routingKey ?? ''),
      queue: this.amqpConfig.transport.queue,
      deliveryTag: Number(meta.deliveryTag ?? 0),
    };
    return { source, auth: { kind: 'trigger', triggerId: this.id } };
  }
}

/** Sum of `count` across `x-death` entries, if present. */
function extractXDeathCount(headers: Record<string, unknown> | undefined): number {
  if (!headers) return 0;
  const xDeath = headers['x-death'];
  if (!Array.isArray(xDeath)) return 0;
  let total = 0;
  for (const entry of xDeath as XDeathEntry[]) {
    const count = Number(entry?.count);
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

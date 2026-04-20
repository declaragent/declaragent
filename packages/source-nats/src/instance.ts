import {
  type AckContext,
  BaseSourceInstance,
  type EventSourceTag,
  type NormalizeContext,
  type RawMessage,
  type SeekPosition,
  type SourceDependencies,
} from '@declaragent/core';
import type {
  ConsumeOptions,
  NatsAckHandle,
  NatsClient,
  NatsConsumerHandle,
  NatsIncomingMessage,
} from './client.js';
import type { NatsTriggerConfig } from './config.js';

/**
 * NATS + JetStream source instance. Subclasses `BaseSourceInstance` so
 * all retry / DLQ / metrics / span / concurrency logic is inherited —
 * this class just wires the JetStream consumer lifecycle and translates
 * `JsMsg` into `RawMessage` + `AckContext`.
 *
 * JetStream has native per-message redelivery counts (via
 * `msg.info.redeliveryCount`), so unlike Kafka we don't maintain a local
 * attempt-count map. `BaseSourceInstance.handleFailure` reads
 * `raw.meta.deliveryCount` directly from that.
 */
export class NatsSourceInstance extends BaseSourceInstance {
  private readonly natsConfig: NatsTriggerConfig;
  private readonly client: NatsClient;

  private consumer: NatsConsumerHandle | null = null;
  /**
   * Current effective consume options. Tracked so `seek()` can rebuild
   * the consumer with `startSequence` / deliverPolicy tweaks without
   * losing config the user supplied up front.
   */
  private consumeOpts: ConsumeOptions;

  constructor(config: NatsTriggerConfig, deps: SourceDependencies, client: NatsClient) {
    super({
      type: 'nats',
      config: {
        id: config.id,
        routing: config.routing,
        delivery: config.delivery,
        limits: config.limits,
      },
      deps,
    });
    this.natsConfig = config;
    this.client = client;
    this.consumeOpts = this.buildConsumeOpts();
  }

  // ── BaseSourceInstance lifecycle ───────────────────────────────────────

  protected async doStart(): Promise<void> {
    try {
      this.consumer = await this.client.consume(
        this.consumeOpts,
        (msg, ack) => this.onNatsMessage(msg, ack),
        (err) => {
          this.recordConnectionError();
          this.deps.logger.error('nats.consume.error', {
            id: this.id,
            err: err.message,
          });
        },
      );
      this.markConnected();
    } catch (err) {
      this.recordConnectionError();
      throw err;
    }
  }

  protected async doStop(_reason?: string): Promise<void> {
    if (this.consumer) {
      try {
        await this.consumer.stop();
      } catch (err) {
        this.deps.logger.warn('nats.consumer.stop.error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.consumer = null;
    }
    try {
      await this.client.close();
    } catch (err) {
      this.deps.logger.warn('nats.client.close.error', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  protected async doPause(): Promise<void> {
    // Cancel the consume iterator — JetStream redelivers unacked messages
    // once ackWait elapses, so pausing is safe.
    if (this.consumer) {
      try {
        await this.consumer.stop();
      } catch (err) {
        this.deps.logger.warn('nats.consumer.pause.error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.consumer = null;
    }
  }

  protected async doResume(): Promise<void> {
    if (this.consumer) return;
    this.consumer = await this.client.consume(
      this.consumeOpts,
      (msg, ack) => this.onNatsMessage(msg, ack),
      (err) => {
        this.recordConnectionError();
        this.deps.logger.error('nats.consume.error', {
          id: this.id,
          err: err.message,
        });
      },
    );
  }

  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {
      servers: this.natsConfig.transport.servers,
      stream: this.natsConfig.transport.stream,
      ...(this.natsConfig.transport.durableConsumer !== undefined && {
        durableConsumer: this.natsConfig.transport.durableConsumer,
      }),
      ...(this.natsConfig.transport.subjectFilters !== undefined && {
        subjectFilters: this.natsConfig.transport.subjectFilters,
      }),
      connected: this.client.isConnected(),
    };
  }

  protected async sendToDLQ(raw: RawMessage, err: Error): Promise<void> {
    if (!this.natsConfig.dlq) {
      this.deps.logger.warn('nats.dlq.not-configured', {
        id: this.id,
        subject: raw.topic,
        streamSequence: raw.meta?.streamSequence,
      });
      return;
    }
    const data = typeof raw.value === 'string' ? new TextEncoder().encode(raw.value) : raw.value;
    await this.client.publish(this.natsConfig.dlq.subject, data, {
      'x-declaragent-dlq-reason': err.message,
      'x-declaragent-origin-subject': String(raw.topic ?? ''),
      'x-declaragent-origin-stream': this.natsConfig.transport.stream,
      ...(raw.meta?.streamSequence !== undefined && {
        'x-declaragent-origin-seq': String(raw.meta.streamSequence),
      }),
    });
  }

  // ── Message pipeline ───────────────────────────────────────────────────

  private async onNatsMessage(m: NatsIncomingMessage, ack: NatsAckHandle): Promise<void> {
    const messageId = `${this.natsConfig.transport.stream}:${m.streamSequence}`;
    const headers: Record<string, unknown> = {};
    if (m.headers) {
      for (const [k, v] of Object.entries(m.headers)) {
        headers[k] = v;
      }
    }

    const raw: RawMessage = {
      value: m.data,
      topic: m.subject,
      routingKey: m.subject,
      offset: String(m.streamSequence),
      headers,
      ...(m.timestampMs !== undefined && { timestamp: m.timestampMs }),
      meta: {
        messageId,
        streamSequence: m.streamSequence,
        deliverySequence: m.deliverySequence,
        // JetStream stamps 1 on first delivery; `BaseSourceInstance.handleFailure`
        // compares against maxRetries, so we pass it through as-is minus 1
        // to align semantics (deliveryCount=0 = not yet retried).
        deliveryCount: Math.max(m.redeliveryCount - 1, 0),
        stream: this.natsConfig.transport.stream,
      },
    };

    const ackCtx: AckContext = {
      messageId,
      ack: async () => {
        await ack.ack();
      },
      nack: async () => {
        // Default nak — JetStream will redeliver per its ackWait. Passing
        // 0ms would cause immediate redelivery; we let the server pick.
        await ack.nak();
      },
    };
    await this.handleMessage(raw, ackCtx);
  }

  protected override buildNormalizeContext(raw: RawMessage): NormalizeContext {
    const meta = raw.meta ?? {};
    const source: EventSourceTag = {
      type: 'nats',
      triggerId: this.id,
      stream: this.natsConfig.transport.stream,
      subject: String(raw.topic ?? raw.routingKey ?? ''),
      streamSequence: Number(meta.streamSequence ?? 0),
    };
    return { source, auth: { kind: 'trigger', triggerId: this.id } };
  }

  // ── Optional EventSourceInstance methods ──────────────────────────────

  async seek(position: SeekPosition): Promise<void> {
    // Seeking in JetStream == recreate the consumer with a different
    // `deliver_policy`. We stop the current consume loop, rebuild the
    // consume opts, and resume.
    switch (position.kind) {
      case 'offset': {
        this.consumeOpts = {
          ...this.buildConsumeOpts(),
          startSequence: Number(position.offset),
        };
        break;
      }
      case 'beginning': {
        this.consumeOpts = {
          ...this.buildConsumeOpts(),
          startSequence: 1,
        };
        break;
      }
      case 'end': {
        this.consumeOpts = {
          ...this.buildConsumeOpts(),
          deliverPolicy: 'new',
        };
        break;
      }
      case 'timestamp': {
        // JetStream's `deliver_policy: 'by_start_time'` + `opt_start_time`
        // (ISO-8601 string) delivers the first message whose stream
        // timestamp is `>= opt_start_time`. Mirror the 'offset' branch
        // but supply `startTime` instead.
        this.consumeOpts = {
          ...this.buildConsumeOpts(),
          startTime: new Date(position.timestampMs).toISOString(),
        };
        break;
      }
    }
    if (this.consumer) {
      await this.consumer.stop();
      this.consumer = null;
    }
    await this.doResume();
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private buildConsumeOpts(): ConsumeOptions {
    const t = this.natsConfig.transport;
    return {
      stream: t.stream,
      ...(t.durableConsumer !== undefined && { durableName: t.durableConsumer }),
      ...(t.subjectFilters !== undefined && { filterSubjects: t.subjectFilters }),
      ...(t.startSequence !== undefined && { startSequence: t.startSequence }),
      ...(t.startTime !== undefined && { startTime: t.startTime }),
      ...(t.ackWaitSeconds !== undefined && { ackWaitMs: t.ackWaitSeconds * 1000 }),
      ...(t.maxDeliver !== undefined && { maxDeliver: t.maxDeliver }),
    };
  }
}

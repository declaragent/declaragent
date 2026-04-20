import {
  type AckContext,
  BaseSourceInstance,
  type EventSourceTag,
  type NormalizeContext,
  type RawMessage,
  type SourceDependencies,
} from '@declaragent/core';
import type { MqttClient, MqttIncomingMessage, MqttSubscription } from './client.js';
import type { MqttTriggerConfig } from './config.js';

/**
 * MQTT source instance. Subclasses `BaseSourceInstance` so all the retry /
 * DLQ / metrics / span logic is inherited — this class just wires MQTT.js
 * lifecycle, subscription management, and DLQ publishing.
 *
 * MQTT ack semantics differ from Kafka/SQS:
 * - QoS 0: fire-and-forget. There is no ack/nack wire — redelivery never
 *   happens, so nack is a no-op and retries are pointless.
 * - QoS 1/2: MQTT.js auto-acks after the `message` handler resolves. We
 *   can't force per-message requeue — the only way to trigger a
 *   redelivery is to throw out of the handler so mqtt.js re-delivers from
 *   its in-flight queue (QoS 1) or via the broker's session state on
 *   reconnect (QoS 2). Because MQTT's DUP flag only fires on the
 *   redelivery, we also keep a local attempt counter keyed by
 *   `topic:messageId` so `deliveryCount` is accurate from the first retry.
 *
 * On reconnect, the broker may re-deliver messages from the durable
 * session that we already retried locally. Clearing the attempt map on
 * reconnect is the MQTT equivalent of Kafka's rebalance reset — it avoids
 * prematurely DLQ'ing messages whose retry history was already exhausted
 * in a previous connection.
 */
export class MqttSourceInstance extends BaseSourceInstance {
  private readonly mqttConfig: MqttTriggerConfig;
  private readonly client: MqttClient;
  private readonly subscriptions: readonly MqttSubscription[];

  private detachMessageHandler: (() => void) | null = null;

  /**
   * `(topic:messageId) → attempt count`. MQTT's DUP flag only gets set on
   * the retry (not the first delivery), so we stamp `raw.meta.deliveryCount`
   * from this map for `BaseSourceInstance.handleFailure` to budget
   * against. Cleared on ack + reconnect.
   */
  private readonly attemptCounts = new Map<string, number>();

  constructor(config: MqttTriggerConfig, deps: SourceDependencies, client: MqttClient) {
    super({
      type: 'mqtt',
      config: {
        id: config.id,
        routing: config.routing,
        delivery: config.delivery,
        limits: config.limits,
      },
      deps,
    });
    this.mqttConfig = config;
    this.client = client;
    this.subscriptions = config.transport.subscriptions.map((s) => ({
      topic: s.topic,
      qos: s.qos,
    }));
  }

  // ── BaseSourceInstance lifecycle ─────────────────────────────────────────

  protected async doStart(): Promise<void> {
    try {
      await this.client.connect();
    } catch (err) {
      this.recordConnectionError();
      throw err;
    }
    this.detachMessageHandler = this.client.onMessage((msg) => this.onMqttMessage(msg));
    await this.client.subscribe(this.subscriptions);
  }

  protected async doStop(_reason?: string): Promise<void> {
    if (this.detachMessageHandler) {
      this.detachMessageHandler();
      this.detachMessageHandler = null;
    }
    try {
      await this.client.disconnect();
    } catch (err) {
      this.deps.logger.warn('mqtt.client.disconnect.error', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    this.attemptCounts.clear();
  }

  protected async doPause(): Promise<void> {
    // Unsubscribe from all topics — in-flight handlers drain naturally.
    // Broker stops pushing new messages for a durable session only for
    // the filters we unsubscribe from; QoS 1/2 already-queued messages
    // still arrive once we resubscribe with clean=false.
    const topics = this.subscriptions.map((s) => s.topic);
    if (topics.length === 0) return;
    try {
      await this.client.unsubscribe(topics);
    } catch (err) {
      this.deps.logger.warn('mqtt.pause.unsubscribe.error', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  protected async doResume(): Promise<void> {
    if (this.subscriptions.length === 0) return;
    await this.client.subscribe(this.subscriptions);
  }

  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {
      brokerUrl: this.mqttConfig.transport.brokerUrl,
      subscriptions: this.subscriptions,
      pendingRetries: this.attemptCounts.size,
      connected: this.client.isConnected(),
    };
  }

  protected async sendToDLQ(raw: RawMessage, err: Error): Promise<void> {
    if (!this.mqttConfig.dlq) {
      this.deps.logger.warn('mqtt.dlq.not-configured', {
        id: this.id,
        topic: raw.topic,
        messageId: raw.meta?.messageId,
      });
      return;
    }
    const body = typeof raw.value === 'string' ? raw.value : raw.value;
    await this.client.publish(this.mqttConfig.dlq.topic, body, {
      // Publish DLQ at QoS 1 so the DLQ topic gets reliable delivery
      // regardless of the source subscription's QoS.
      qos: 1,
      userProperties: {
        'x-declaragent-dlq-reason': err.message,
        'x-declaragent-origin-topic': String(raw.topic ?? ''),
        ...(raw.meta?.messageId !== undefined && {
          'x-declaragent-origin-message-id': String(raw.meta.messageId),
        }),
      },
    });
  }

  // ── Message pipeline ─────────────────────────────────────────────────────

  private async onMqttMessage(m: MqttIncomingMessage): Promise<void> {
    const messageKey = this.messageKey(m);
    const attempt = this.attemptCounts.get(messageKey) ?? 0;

    const headers: Record<string, unknown> = { ...m.userProperties };
    // Surface MQTT transport metadata on the header map too — these are
    // not user-properties per se but callers often want them for audit.
    headers['x-mqtt-qos'] = String(m.qos);
    headers['x-mqtt-retain'] = String(m.retain);
    if (m.dup) headers['x-mqtt-dup'] = 'true';

    const raw: RawMessage = {
      value: m.payload,
      topic: m.topic,
      headers,
      meta: {
        messageId: messageKey,
        deliveryCount: attempt,
        qos: m.qos,
        retain: m.retain,
        dup: m.dup,
        ...(m.messageId !== undefined && { mqttPacketId: m.messageId }),
      },
    };

    const ack = this.buildAckContext(m, messageKey);
    await this.handleMessage(raw, ack);
  }

  private buildAckContext(m: MqttIncomingMessage, messageKey: string): AckContext {
    return {
      messageId: messageKey,
      ack: async () => {
        // QoS 0: no-op. QoS 1/2: MQTT.js already auto-acks when our
        // message handler resolves without throwing, so our only job is
        // to clear the local retry counter.
        this.attemptCounts.delete(messageKey);
      },
      nack: async () => {
        // QoS 0: no redelivery is possible per MQTT spec; drop silently
        // so the base class doesn't think we're asking for retries that
        // will never happen. Clear the counter too.
        if (m.qos === 0) {
          this.attemptCounts.delete(messageKey);
          return;
        }
        // QoS 1/2: bump the local counter and throw so MQTT.js doesn't
        // auto-ack. The broker will redeliver (with DUP=1) and we'll
        // observe the bumped `deliveryCount` on the next attempt.
        const next = (this.attemptCounts.get(messageKey) ?? 0) + 1;
        this.attemptCounts.set(messageKey, next);
        throw new Error(`mqtt retry scheduled (attempt ${next}, qos ${m.qos})`);
      },
    };
  }

  private messageKey(m: MqttIncomingMessage): string {
    // QoS 0 has no packet id, so fall back to topic-only + a monotonic
    // nonce. This means two QoS-0 messages on the same topic get distinct
    // keys — important for the attemptCounts map.
    if (m.messageId !== undefined) {
      return `${m.topic}:${m.messageId}`;
    }
    return `${m.topic}:qos0:${nextQos0Seq()}`;
  }

  protected override buildNormalizeContext(raw: RawMessage): NormalizeContext {
    const meta = raw.meta ?? {};
    const qos = Number(meta.qos ?? 0);
    const source: EventSourceTag = {
      type: 'mqtt',
      triggerId: this.id,
      topic: String(raw.topic ?? raw.routingKey ?? ''),
      qos: (qos === 1 || qos === 2 ? qos : 0) as 0 | 1 | 2,
    };
    return { source, auth: { kind: 'trigger', triggerId: this.id } };
  }
}

// Module-scoped counter for QoS 0 message-key generation. Keeps each
// QoS-0 RawMessage unique even when a burst arrives on the same topic.
let qos0Counter = 0;
function nextQos0Seq(): string {
  qos0Counter = (qos0Counter + 1) | 0;
  return `${Date.now().toString(36)}-${qos0Counter.toString(36)}`;
}

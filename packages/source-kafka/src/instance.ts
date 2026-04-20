import {
  type AckContext,
  BaseSourceInstance,
  type DLQEntry,
  type DLQListParams,
  type EventSourceTag,
  type NormalizeContext,
  type RawMessage,
  type ReplayParams,
  type SeekPosition,
  type SourceDependencies,
} from '@declaragent/core';
import type { AgentEvent } from '@declaragent/core';
import type {
  KafkaAdminHandle,
  KafkaClient,
  KafkaConsumerHandle,
  KafkaIncomingMessage,
  KafkaProducerHandle,
} from './client.js';
import type { KafkaTriggerConfig } from './config.js';

const DELIVERY_COUNT_HEADER = 'x-declaragent-delivery-count';

/**
 * Kafka source instance. Subclasses `BaseSourceInstance` so all the
 * retry / DLQ / metrics / span logic is inherited — this class just
 * wires kafkajs lifecycle + offset commits + DLQ producer.
 */
export class KafkaSourceInstance extends BaseSourceInstance {
  private readonly kafkaConfig: KafkaTriggerConfig;
  private readonly client: KafkaClient;

  private consumer: KafkaConsumerHandle | null = null;
  private producer: KafkaProducerHandle | null = null;
  private admin: KafkaAdminHandle | null = null;

  /**
   * `(topic:partition:offset) → attempt count`. Kafka doesn't track
   * per-message retry counts natively, so we stamp
   * `raw.meta.deliveryCount` from this map for `BaseSourceInstance.handleFailure`
   * to budget against. Reset on rebalance + on successful ack.
   */
  private readonly attemptCounts = new Map<string, number>();

  /** Subscribed assignments, for pause/resume. */
  private readonly subscribed: string[];

  constructor(config: KafkaTriggerConfig, deps: SourceDependencies, client: KafkaClient) {
    super({
      type: 'kafka',
      config: {
        id: config.id,
        routing: config.routing,
        delivery: config.delivery,
        limits: config.limits,
      },
      deps,
    });
    this.kafkaConfig = config;
    this.client = client;
    this.subscribed = [...config.transport.topics];
  }

  // ── BaseSourceInstance lifecycle ───────────────────────────────────────

  protected async doStart(): Promise<void> {
    const consumer = this.client.createConsumer(this.kafkaConfig.transport.consumerGroup, {
      ...(this.kafkaConfig.transport.sessionTimeoutMs !== undefined && {
        sessionTimeoutMs: this.kafkaConfig.transport.sessionTimeoutMs,
      }),
      ...(this.kafkaConfig.transport.heartbeatIntervalMs !== undefined && {
        heartbeatIntervalMs: this.kafkaConfig.transport.heartbeatIntervalMs,
      }),
    });
    try {
      await consumer.connect();
    } catch (err) {
      this.recordConnectionError();
      throw err;
    }
    this.consumer = consumer;

    // Reset per-message retry counters on rebalance — the new assignment
    // may re-deliver partitions we thought were settled.
    consumer.onRebalance(() => {
      this.attemptCounts.clear();
    });

    await consumer.subscribe(this.subscribed, this.kafkaConfig.transport.fromBeginning);
    await consumer.run((msg) => this.onKafkaMessage(msg));

    // Producer only when we have a DLQ target. Connecting lazily avoids
    // the broker roundtrip for adapters that log-and-drop on terminal
    // failure.
    if (this.kafkaConfig.dlq) {
      this.producer = this.client.createProducer();
      await this.producer.connect();
    }
  }

  protected async doStop(_reason?: string): Promise<void> {
    if (this.consumer) {
      try {
        await this.consumer.disconnect();
      } catch (err) {
        this.deps.logger.warn('kafka.consumer.disconnect.error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.consumer = null;
    }
    if (this.producer) {
      try {
        await this.producer.disconnect();
      } catch (err) {
        this.deps.logger.warn('kafka.producer.disconnect.error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.producer = null;
    }
    if (this.admin) {
      try {
        await this.admin.disconnect();
      } catch {
        // best effort
      }
      this.admin = null;
    }
    this.attemptCounts.clear();
  }

  protected async doPause(): Promise<void> {
    this.consumer?.pause(this.subscribed.map((topic) => ({ topic })));
  }

  protected async doResume(): Promise<void> {
    this.consumer?.resume(this.subscribed.map((topic) => ({ topic })));
  }

  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {
      brokers: this.kafkaConfig.transport.brokers,
      consumerGroup: this.kafkaConfig.transport.consumerGroup,
      topics: this.subscribed,
      pendingRetries: this.attemptCounts.size,
    };
  }

  protected async sendToDLQ(raw: RawMessage, err: Error): Promise<void> {
    if (!this.kafkaConfig.dlq || !this.producer) {
      this.deps.logger.warn('kafka.dlq.not-configured', {
        id: this.id,
        topic: raw.topic,
        partition: raw.partition,
        offset: raw.offset,
      });
      return;
    }
    const value = typeof raw.value === 'string' ? raw.value : raw.value;
    await this.producer.send(this.kafkaConfig.dlq.topic, [
      {
        ...(raw.key !== undefined && raw.key !== null && { key: raw.key }),
        value,
        headers: {
          'x-declaragent-dlq-reason': err.message,
          'x-declaragent-origin-topic': String(raw.topic ?? ''),
          'x-declaragent-origin-partition': String(raw.partition ?? ''),
          'x-declaragent-origin-offset': String(raw.offset ?? ''),
        },
      },
    ]);
  }

  // ── Message pipeline ───────────────────────────────────────────────────

  private async onKafkaMessage(m: KafkaIncomingMessage): Promise<void> {
    const messageId = this.messageId(m);
    const attempt = this.attemptCounts.get(messageId) ?? 0;

    const headers: Record<string, unknown> = {};
    if (m.headers) {
      for (const [k, v] of Object.entries(m.headers)) {
        if (v === undefined) continue;
        headers[k] = v instanceof Uint8Array ? new TextDecoder().decode(v) : v;
      }
    }
    // Also honor a wire-encoded delivery-count header if the producer set one.
    const headerAttempt = headers[DELIVERY_COUNT_HEADER];
    const deliveryCount = Math.max(attempt, headerAttempt ? Number(headerAttempt) : 0);

    const raw: RawMessage = {
      value: m.value,
      topic: m.topic,
      partition: m.partition,
      offset: m.offset,
      ...(m.key !== undefined && m.key !== null && { key: m.key }),
      ...(m.timestamp !== undefined && { timestamp: m.timestamp }),
      headers,
      meta: {
        messageId,
        deliveryCount,
      },
    };

    const ack = this.buildAckContext(m, messageId);
    await this.handleMessage(raw, ack);
  }

  private buildAckContext(m: KafkaIncomingMessage, messageId: string): AckContext {
    return {
      messageId,
      ack: async () => {
        await this.consumer?.commitOffset(m.topic, m.partition, nextOffset(m.offset));
        this.attemptCounts.delete(messageId);
      },
      nack: async () => {
        // Kafka can't per-message requeue. Bump the local counter and
        // throw so kafkajs redelivers on its own retry cycle.
        const next = (this.attemptCounts.get(messageId) ?? 0) + 1;
        this.attemptCounts.set(messageId, next);
        throw new Error(`kafka retry scheduled (attempt ${next})`);
      },
    };
  }

  private messageId(m: KafkaIncomingMessage): string {
    return `${m.topic}:${m.partition}:${m.offset}`;
  }

  protected override buildNormalizeContext(raw: RawMessage): NormalizeContext {
    const source: EventSourceTag = {
      type: 'kafka',
      triggerId: this.id,
      topic: String(raw.topic ?? this.subscribed[0] ?? ''),
      partition: Number(raw.partition ?? 0),
      offset: String(raw.offset ?? ''),
    };
    return { source, auth: { kind: 'trigger', triggerId: this.id } };
  }

  // ── Optional EventSourceInstance methods ──────────────────────────────

  async seek(position: SeekPosition): Promise<void> {
    if (!this.consumer) throw new Error('kafka consumer is not started');
    const topics = this.subscribed;
    if (topics.length === 0) throw new Error('no topics subscribed');
    switch (position.kind) {
      case 'offset': {
        const topic = position.topic ?? topics[0];
        const partition = position.partition ?? 0;
        if (typeof topic !== 'string') throw new Error('seek: topic is required');
        await this.consumer.seek(topic, partition, String(position.offset));
        return;
      }
      case 'beginning': {
        for (const topic of topics) {
          await this.consumer.seek(topic, 0, '0');
        }
        return;
      }
      case 'end': {
        const admin = await this.ensureAdmin();
        for (const topic of topics) {
          const offsets = await admin.fetchTopicEndOffsets(topic);
          for (const o of offsets) {
            await this.consumer.seek(topic, o.partition, o.offset);
          }
        }
        return;
      }
      case 'timestamp': {
        const admin = await this.ensureAdmin();
        for (const topic of topics) {
          const offsets = await admin.fetchTopicOffsetsByTimestamp(topic, position.timestampMs);
          for (const o of offsets) {
            await this.consumer.seek(topic, o.partition, o.offset);
          }
        }
        return;
      }
    }
  }

  /**
   * Replay events from the configured topics across the timestamp range
   * `[fromMs, toMs]` (or `[fromMs, ∞)` if `toMs` is omitted). Uses a
   * transient consumer in a fresh consumer group so the live ingestion
   * loop is unaffected. Yields normalized `AgentEvent`s with fresh
   * `id`s (prefixed `replay:`) and `causedBy` pointing at the origin
   * topic/partition/offset so downstream audit can reconcile.
   */
  async *replay(params: ReplayParams): AsyncGenerator<AgentEvent> {
    const normalizer = this.deps.normalizer;
    if (!normalizer) {
      throw new Error('kafka replay requires SourceDependencies.normalizer');
    }
    const limit = params.limit ?? Number.POSITIVE_INFINITY;
    if (limit <= 0) return;

    const admin = await this.ensureAdmin();

    type PartitionRange = { topic: string; partition: number; start: bigint; end: bigint };
    const ranges: PartitionRange[] = [];
    for (const topic of this.subscribed) {
      const startOffsets = await admin.fetchTopicOffsetsByTimestamp(topic, params.fromMs);
      const endOffsets = await admin.fetchTopicEndOffsets(topic);
      const endByPartition = new Map<number, string>();
      for (const eo of endOffsets) endByPartition.set(eo.partition, eo.offset);
      for (const so of startOffsets) {
        const endStr = endByPartition.get(so.partition);
        if (endStr === undefined) continue;
        const start = BigInt(so.offset);
        const end = BigInt(endStr);
        if (end <= start) continue; // partition has no records >= fromMs
        ranges.push({ topic, partition: so.partition, start, end });
      }
    }
    if (ranges.length === 0) return;

    const groupId = `declaragent-replay-${this.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const replayConsumer = this.client.createConsumer(groupId);
    await replayConsumer.connect();

    type QueueItem = { kind: 'msg'; msg: KafkaIncomingMessage } | { kind: 'error'; err: unknown };
    const buffer: QueueItem[] = [];
    let waiter: { resolve: (v: QueueItem) => void } | null = null;
    const push = (item: QueueItem): void => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.resolve(item);
      } else {
        buffer.push(item);
      }
    };
    const pull = (): Promise<QueueItem> => {
      const next = buffer.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve) => {
        waiter = { resolve };
      });
    };

    try {
      await replayConsumer.subscribe(this.subscribed, true);
      await replayConsumer.run(async (msg) => {
        push({ kind: 'msg', msg });
      });
      // Seek each partition to its computed start offset.
      for (const r of ranges) {
        await replayConsumer.seek(r.topic, r.partition, r.start.toString());
      }

      const remainingByKey = new Map<string, bigint>();
      for (const r of ranges) {
        remainingByKey.set(`${r.topic}:${r.partition}`, r.end - r.start);
      }
      let yielded = 0;
      while (yielded < limit) {
        const item = await pull();
        if (item.kind === 'error') throw item.err;
        const m = item.msg;
        const key = `${m.topic}:${m.partition}`;
        const remaining = remainingByKey.get(key);
        if (remaining !== undefined) {
          const left = remaining - 1n;
          if (left <= 0n) remainingByKey.delete(key);
          else remainingByKey.set(key, left);
        }

        // Time filter. SQL "at-or-after" is guaranteed by the start-offset
        // lookup, but `toMs` requires a per-message check.
        if (m.timestamp !== undefined && params.toMs !== undefined && m.timestamp > params.toMs) {
          if (remainingByKey.size === 0) break;
          continue;
        }

        const headers: Record<string, unknown> = {};
        if (m.headers) {
          for (const [k, v] of Object.entries(m.headers)) {
            if (v === undefined) continue;
            headers[k] = v instanceof Uint8Array ? new TextDecoder().decode(v) : v;
          }
        }
        const raw: RawMessage = {
          value: m.value,
          topic: m.topic,
          partition: m.partition,
          offset: m.offset,
          ...(m.key !== undefined && m.key !== null && { key: m.key }),
          ...(m.timestamp !== undefined && { timestamp: m.timestamp }),
          headers,
          meta: { messageId: `${m.topic}:${m.partition}:${m.offset}`, deliveryCount: 0 },
        };
        const event = await normalizer.normalize(
          raw,
          this.config.routing,
          this.buildNormalizeContext(raw),
        );
        if (!event) {
          if (remainingByKey.size === 0) break;
          continue;
        }
        if (params.filter && !params.filter(event)) {
          if (remainingByKey.size === 0) break;
          continue;
        }
        // Rewrite the event so the dispatcher doesn't dedupe against the
        // original, and a downstream auditor can trace it back.
        const replayEvent: AgentEvent = {
          ...event,
          id: `replay:${event.id}:${yielded}`,
          meta: {
            ...(event.meta ?? {}),
            causedBy: event.id,
          },
        };
        yielded += 1;
        yield replayEvent;

        if (remainingByKey.size === 0) break;
      }
    } finally {
      try {
        await replayConsumer.disconnect();
      } catch {
        // best-effort cleanup
      }
    }
  }

  // ── DLQ inspection ────────────────────────────────────────────────────

  async listDLQ(params: DLQListParams = {}): Promise<readonly DLQEntry[]> {
    const dlq = this.kafkaConfig.dlq;
    if (!dlq) return [];
    const admin = await this.ensureAdmin();
    const endOffsets = await admin.fetchTopicEndOffsets(dlq.topic);
    // Earliest offsets from the beginning-of-topic isn't exposed by the
    // narrow admin facade; consume from 'earliest' via a transient consumer
    // and stop once we've hit the end-of-topic snapshot or the caller's limit.
    const target = Math.max(...endOffsets.map((e) => Number(e.offset)), 0);
    if (target === 0) return [];

    const limit = Math.min(params.limit ?? 200, 10_000);
    const sinceMs = params.sinceMs;
    const entries: DLQEntry[] = [];
    const inspector = await this.openDLQInspector(dlq.topic, target);
    try {
      while (entries.length < limit) {
        const msg = await inspector.next();
        if (!msg) break;
        if (sinceMs !== undefined && (msg.timestamp ?? 0) < sinceMs) continue;
        entries.push(dlqEntryFromKafka(msg));
      }
    } finally {
      await inspector.close();
    }
    return entries;
  }

  async showDLQ(id: string): Promise<DLQEntry | undefined> {
    const dlq = this.kafkaConfig.dlq;
    if (!dlq) return undefined;
    // DLQ ids are `topic:partition:offset`. Use the admin to fetch the
    // end offset, then scan from 0 until we find the target — Kafka has
    // no random-access read by offset without a seek on a live consumer.
    const parts = id.split(':');
    if (parts.length !== 3) throw new Error(`kafka dlq: invalid id "${id}"`);
    const [topic, partitionStr, offsetStr] = parts as [string, string, string];
    if (topic !== dlq.topic) {
      throw new Error(
        `kafka dlq: id topic "${topic}" does not match configured DLQ "${dlq.topic}"`,
      );
    }
    const partition = Number(partitionStr);
    const admin = await this.ensureAdmin();
    const endOffsets = await admin.fetchTopicEndOffsets(dlq.topic);
    const endForPartition = endOffsets.find((e) => e.partition === partition);
    if (!endForPartition) return undefined;
    if (BigInt(offsetStr) >= BigInt(endForPartition.offset)) return undefined;

    const groupId = `declaragent-dlq-show-${this.id}-${Date.now()}`;
    const consumer = this.client.createConsumer(groupId);
    await consumer.connect();
    try {
      await consumer.subscribe([dlq.topic], true);
      let found: KafkaIncomingMessage | null = null;
      let resolveDone: () => void;
      const done = new Promise<void>((r) => {
        resolveDone = r;
      });
      await consumer.run(async (msg) => {
        if (found) return;
        if (msg.partition !== partition) return;
        if (msg.offset !== offsetStr) return;
        found = msg;
        resolveDone();
      });
      await consumer.seek(dlq.topic, partition, offsetStr);
      // Give kafkajs up to ~5s to deliver; otherwise assume missing.
      const timeout = new Promise<void>((r) => setTimeout(r, 5000));
      await Promise.race([done, timeout]);
      return found ? dlqEntryFromKafka(found) : undefined;
    } finally {
      try {
        await consumer.disconnect();
      } catch {
        // best-effort
      }
    }
  }

  async redriveDLQ(id: string): Promise<void> {
    const dlq = this.kafkaConfig.dlq;
    if (!dlq) throw new Error('kafka redrive: no DLQ configured');
    const entry = await this.showDLQ(id);
    if (!entry) throw new Error(`kafka redrive: DLQ entry "${id}" not found`);
    // Prefer the original (pre-DLQ) topic from the adapter's own stamp.
    const originTopic = entry.headers['x-declaragent-origin-topic'];
    const destTopic =
      originTopic && originTopic.length > 0 && originTopic !== dlq.topic
        ? originTopic
        : (this.subscribed[0] ?? dlq.topic);
    if (!this.producer) {
      this.producer = this.client.createProducer();
      await this.producer.connect();
    }
    await this.producer.send(destTopic, [
      {
        ...(entry.headers.key && { key: entry.headers.key }),
        value: entry.body,
        headers: {
          ...entry.headers,
          'x-declaragent-redriven-from': id,
          'x-declaragent-redriven-at': String(Date.now()),
        },
      },
    ]);
  }

  /**
   * Create a short-lived consumer that reads the DLQ topic from the
   * earliest offset, emits messages one at a time via `next()`, and stops
   * once the snapshot tail is reached. Used by `listDLQ`.
   */
  private async openDLQInspector(
    topic: string,
    endBoundary: number,
  ): Promise<{ next(): Promise<KafkaIncomingMessage | null>; close(): Promise<void> }> {
    const groupId = `declaragent-dlq-list-${this.id}-${Date.now()}`;
    const consumer = this.client.createConsumer(groupId);
    await consumer.connect();
    await consumer.subscribe([topic], true);

    type Item = { kind: 'msg'; msg: KafkaIncomingMessage } | { kind: 'err'; err: unknown };
    const buffer: Item[] = [];
    let waiter: ((item: Item) => void) | null = null;
    let consumed = 0;

    await consumer.run(async (msg) => {
      const item: Item = { kind: 'msg', msg };
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(item);
      } else {
        buffer.push(item);
      }
    });

    return {
      async next() {
        if (consumed >= endBoundary) return null;
        const item =
          buffer.shift() ??
          (await new Promise<Item>((resolve) => {
            waiter = resolve;
            // Timeout safeguard — if the broker goes silent past 3s, bail
            // so callers don't hang forever on an empty DLQ.
            setTimeout(() => {
              if (waiter === resolve) {
                waiter = null;
                resolve({ kind: 'msg', msg: null as unknown as KafkaIncomingMessage });
              }
            }, 3000);
          }));
        if (item.kind === 'err') throw item.err;
        if (item.msg === null) return null;
        consumed += 1;
        return item.msg;
      },
      async close() {
        try {
          await consumer.disconnect();
        } catch {
          // best-effort
        }
      },
    };
  }

  async lag(): Promise<Record<string, number>> {
    const admin = await this.ensureAdmin();
    const out: Record<string, number> = {};
    for (const topic of this.subscribed) {
      const endOffsets = await admin.fetchTopicEndOffsets(topic);
      for (const eo of endOffsets) {
        out[`${topic}:${eo.partition}`] = Number(eo.offset);
      }
    }
    return out;
  }

  private async ensureAdmin(): Promise<KafkaAdminHandle> {
    if (this.admin) return this.admin;
    this.admin = this.client.createAdmin();
    await this.admin.connect();
    return this.admin;
  }
}

/** kafkajs commits "next offset to consume", so we commit `offset + 1`. */
function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
}

/**
 * Flatten an incoming Kafka message into the normalized `DLQEntry` shape
 * the CLI expects. Binary values are surfaced as UTF-8 strings — DLQ
 * messages produced by our adapter always have a string value, so this
 * is lossless in practice; users who pushed raw bytes into a DLQ topic
 * directly will see the UTF-8 decode.
 */
function dlqEntryFromKafka(m: KafkaIncomingMessage): DLQEntry {
  const headers: Record<string, string> = {};
  if (m.headers) {
    for (const [k, v] of Object.entries(m.headers)) {
      if (v === undefined) continue;
      headers[k] = v instanceof Uint8Array ? new TextDecoder().decode(v) : v;
    }
  }
  const body = typeof m.value === 'string' ? m.value : new TextDecoder().decode(m.value);
  const entry: DLQEntry = {
    id: `${m.topic}:${m.partition}:${m.offset}`,
    body,
    headers,
    meta: {
      topic: m.topic,
      partition: m.partition,
      offset: m.offset,
    },
  };
  if (headers['x-declaragent-dlq-reason']) entry.reason = headers['x-declaragent-dlq-reason'];
  if (m.timestamp !== undefined) entry.insertedAtMs = m.timestamp;
  return entry;
}

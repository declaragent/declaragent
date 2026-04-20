/**
 * Thin facade over the kafkajs surface the adapter uses. Keeping this
 * interface narrow lets unit tests stub Kafka completely — `kafkajs`
 * itself only appears in `createKafkajsClient` (the default factory).
 */

export type SaslMechanism = 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512' | 'OAUTHBEARER';

export interface KafkaSaslConfig {
  mechanism: SaslMechanism;
  username?: string;
  password?: string;
}

export interface KafkaTlsConfig {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface KafkaClientOptions {
  brokers: readonly string[];
  clientId?: string;
  sasl?: KafkaSaslConfig;
  ssl?: KafkaTlsConfig | boolean;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface KafkaIncomingMessage {
  topic: string;
  partition: number;
  offset: string;
  timestamp?: number;
  key?: string | null;
  value: Uint8Array;
  headers?: Record<string, Uint8Array | string | undefined>;
}

export type KafkaEachMessage = (msg: KafkaIncomingMessage) => Promise<void>;

export interface KafkaConsumerHandle {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topics: readonly string[], fromBeginning?: boolean): Promise<void>;
  /** Starts consumption. Resolves when the consumer's internal loop is running. */
  run(handler: KafkaEachMessage): Promise<void>;
  commitOffset(topic: string, partition: number, offsetToCommit: string): Promise<void>;
  seek(topic: string, partition: number, offset: string): Promise<void>;
  pause(assignments: readonly { topic: string; partitions?: readonly number[] }[]): void;
  resume(assignments: readonly { topic: string; partitions?: readonly number[] }[]): void;
  /** Called on the consumer-group rebalance. */
  onRebalance(
    handler: (event: { memberId: string; topics: readonly string[] }) => void,
  ): () => void;
  /** Current committed offset per topic:partition. */
  fetchCommittedOffsets(topic: string): Promise<Array<{ partition: number; offset: string }>>;
}

export interface KafkaProducerHandle {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(
    topic: string,
    messages: readonly {
      key?: string | null;
      value: Uint8Array | string;
      headers?: Record<string, string | Uint8Array>;
    }[],
  ): Promise<void>;
}

export interface KafkaAdminHandle {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Latest offset per partition for the given topic. */
  fetchTopicEndOffsets(topic: string): Promise<Array<{ partition: number; offset: string }>>;
  /**
   * Earliest (per-partition) offset whose record timestamp is `>= timestamp`.
   * Returned offsets point at the first record at-or-after the timestamp.
   * Used by `seek({kind:'timestamp'})` and `replay({fromMs})`.
   */
  fetchTopicOffsetsByTimestamp(
    topic: string,
    timestampMs: number,
  ): Promise<Array<{ partition: number; offset: string }>>;
}

export interface KafkaClient {
  createConsumer(
    groupId: string,
    options?: {
      sessionTimeoutMs?: number;
      heartbeatIntervalMs?: number;
      maxWaitTimeMs?: number;
    },
  ): KafkaConsumerHandle;
  createProducer(): KafkaProducerHandle;
  createAdmin(): KafkaAdminHandle;
  disconnect(): Promise<void>;
}

// ─── Default impl: real kafkajs ─────────────────────────────────────────

import type {
  EachMessagePayload,
  Consumer as KafkajsConsumer,
  KafkaConfig as KafkajsKafkaConfig,
  SASLOptions,
} from 'kafkajs';
import { Kafka, logLevel } from 'kafkajs';

export function createKafkajsClient(options: KafkaClientOptions): KafkaClient {
  const kafkaConfig: KafkajsKafkaConfig = {
    brokers: [...options.brokers],
    ...(options.clientId !== undefined && { clientId: options.clientId }),
    ...(options.connectionTimeoutMs !== undefined && {
      connectionTimeout: options.connectionTimeoutMs,
    }),
    ...(options.requestTimeoutMs !== undefined && { requestTimeout: options.requestTimeoutMs }),
    // Keep kafkajs quiet — the adapter logs through the host logger.
    logLevel: logLevel.NOTHING,
  };
  if (options.sasl) {
    kafkaConfig.sasl = toKafkajsSasl(options.sasl);
  }
  if (options.ssl !== undefined) {
    kafkaConfig.ssl = typeof options.ssl === 'boolean' ? options.ssl : { ...options.ssl };
  }
  const kafka = new Kafka(kafkaConfig);

  return {
    createConsumer(groupId, opts) {
      const consumer = kafka.consumer({
        groupId,
        ...(opts?.sessionTimeoutMs !== undefined && { sessionTimeout: opts.sessionTimeoutMs }),
        ...(opts?.heartbeatIntervalMs !== undefined && {
          heartbeatInterval: opts.heartbeatIntervalMs,
        }),
        ...(opts?.maxWaitTimeMs !== undefined && { maxWaitTimeInMs: opts.maxWaitTimeMs }),
      });
      return wrapConsumer(consumer);
    },
    createProducer() {
      const producer = kafka.producer();
      return {
        async connect() {
          await producer.connect();
        },
        async disconnect() {
          await producer.disconnect();
        },
        async send(topic, messages) {
          await producer.send({
            topic,
            messages: messages.map((m) => {
              const headers: Record<string, string | Buffer> = {};
              if (m.headers) {
                for (const [k, v] of Object.entries(m.headers)) {
                  headers[k] = typeof v === 'string' ? v : Buffer.from(v);
                }
              }
              return {
                ...(m.key !== undefined && m.key !== null && { key: m.key }),
                value: typeof m.value === 'string' ? m.value : Buffer.from(m.value),
                ...(m.headers !== undefined && { headers }),
              };
            }),
          });
        },
      };
    },
    createAdmin() {
      const admin = kafka.admin();
      return {
        async connect() {
          await admin.connect();
        },
        async disconnect() {
          await admin.disconnect();
        },
        async fetchTopicEndOffsets(topic) {
          const rows = await admin.fetchTopicOffsets(topic);
          return rows.map((r) => ({ partition: r.partition, offset: r.offset }));
        },
        async fetchTopicOffsetsByTimestamp(topic, timestampMs) {
          const rows = await admin.fetchTopicOffsetsByTimestamp(topic, timestampMs);
          return rows.map((r) => ({ partition: r.partition, offset: r.offset }));
        },
      };
    },
    async disconnect() {
      // kafkajs doesn't have a global shutdown — consumers/producers/admins
      // are individually disconnected by the adapter.
    },
  };
}

function toKafkajsSasl(sasl: KafkaSaslConfig): SASLOptions {
  switch (sasl.mechanism) {
    case 'PLAIN':
      return {
        mechanism: 'plain',
        username: sasl.username ?? '',
        password: sasl.password ?? '',
      };
    case 'SCRAM-SHA-256':
      return {
        mechanism: 'scram-sha-256',
        username: sasl.username ?? '',
        password: sasl.password ?? '',
      };
    case 'SCRAM-SHA-512':
      return {
        mechanism: 'scram-sha-512',
        username: sasl.username ?? '',
        password: sasl.password ?? '',
      };
    case 'OAUTHBEARER':
      // Stub per Phase-4 plan. Real OAuth2 flow (token refresh, audience
      // resolution, etc.) lands in a follow-up once a user needs it.
      return {
        mechanism: 'oauthbearer',
        oauthBearerProvider: async () => ({
          value: sasl.password ?? '',
        }),
      };
  }
}

function wrapConsumer(consumer: KafkajsConsumer): KafkaConsumerHandle {
  const rebalanceHandlers = new Set<
    (event: { memberId: string; topics: readonly string[] }) => void
  >();
  consumer.on(consumer.events.GROUP_JOIN, (event) => {
    for (const h of rebalanceHandlers) {
      h({
        memberId: event.payload.memberId,
        topics: event.payload.memberAssignment ? Object.keys(event.payload.memberAssignment) : [],
      });
    }
  });
  return {
    async connect() {
      await consumer.connect();
    },
    async disconnect() {
      await consumer.disconnect();
    },
    async subscribe(topics, fromBeginning) {
      for (const topic of topics) {
        await consumer.subscribe({ topic, ...(fromBeginning !== undefined && { fromBeginning }) });
      }
    },
    async run(handler) {
      await consumer.run({
        autoCommit: false,
        eachMessage: async (payload: EachMessagePayload) => {
          const m = payload.message;
          const headers: Record<string, Uint8Array | string | undefined> = {};
          if (m.headers) {
            for (const [k, v] of Object.entries(m.headers)) {
              headers[k] =
                v == null
                  ? undefined
                  : v instanceof Uint8Array
                    ? v
                    : Buffer.isBuffer(v)
                      ? new Uint8Array(v)
                      : String(v);
            }
          }
          await handler({
            topic: payload.topic,
            partition: payload.partition,
            offset: m.offset,
            ...(m.timestamp !== undefined && { timestamp: Number(m.timestamp) }),
            ...(m.key !== undefined && { key: m.key === null ? null : m.key.toString() }),
            value: m.value ? new Uint8Array(m.value) : new Uint8Array(0),
            headers,
          });
        },
      });
    },
    async commitOffset(topic, partition, offsetToCommit) {
      await consumer.commitOffsets([{ topic, partition, offset: offsetToCommit }]);
    },
    async seek(topic, partition, offset) {
      await consumer.seek({ topic, partition, offset });
    },
    pause(assignments) {
      consumer.pause(
        assignments.map((a) => ({
          topic: a.topic,
          ...(a.partitions !== undefined && { partitions: [...a.partitions] }),
        })),
      );
    },
    resume(assignments) {
      consumer.resume(
        assignments.map((a) => ({
          topic: a.topic,
          ...(a.partitions !== undefined && { partitions: [...a.partitions] }),
        })),
      );
    },
    onRebalance(handler) {
      rebalanceHandlers.add(handler);
      return () => rebalanceHandlers.delete(handler);
    },
    async fetchCommittedOffsets(_topic) {
      // kafkajs exposes this via admin, not consumer. Return empty for
      // default client; tests + the adapter's `lag()` flow use the admin
      // handle for end offsets and maintain committed state internally.
      return [];
    },
  };
}

# Pluggable Event Sources at Scale

Companion to `EVENT_DRIVEN_AGENT.md`. That doc treated event sources (user, cron, webhook, file-watch) as hand-wired modules. This doc makes them **pluggable**: Kafka, MQTT, AMQP, NATS, SQS, Redis Streams, Kinesis, WebSocket, gRPC, Pulsar, Google Pub/Sub, S3 notifications, database CDC — registered declaratively, managed uniformly, scaled horizontally.

Read the earlier docs first. This one assumes the bus, dispatcher, and event model are in place.

---

## Table of Contents

1. [Why This Must Be Pluggable](#1-why-this-must-be-pluggable)
2. [The EventSource Contract](#2-the-eventsource-contract)
3. [The Source Registry](#3-the-source-registry)
4. [Transport Families & Their Quirks](#4-transport-families)
5. [Adapter Implementations](#5-adapter-implementations)
6. [The Message Normalizer](#6-the-message-normalizer)
7. [Delivery Semantics](#7-delivery-semantics)
8. [Connection Management at Scale](#8-connection-management)
9. [Concurrency, Partitioning, Backpressure](#9-concurrency-partitioning-backpressure)
10. [Observability](#10-observability)
11. [Security at Scale](#11-security-at-scale)
12. [Declarative Configuration](#12-declarative-configuration)
13. [Worked Examples at Scale](#13-worked-examples-at-scale)
14. [Build Order](#14-build-order)
15. [Pitfalls](#15-pitfalls)

---

## 1. Why This Must Be Pluggable

Baking Kafka into your core agent is the same mistake as baking GitHub into it. Users have:

- **Kafka shops** — financial services, ad-tech, logistics
- **MQTT shops** — IoT, industrial, connected vehicles
- **AMQP shops** — enterprise integration, RabbitMQ-heavy
- **Cloud-native shops** — SQS/SNS (AWS), Pub/Sub (GCP), Service Bus (Azure)
- **Real-time shops** — WebSocket, gRPC streams, SSE
- **Polling shops** — legacy DBs via CDC, IMAP, FTP drops

No agent should ship all of them. And no agent should ship just one. The answer is **the same pattern as plugins and MCP**: a uniform `EventSource` contract, a registry, and per-transport adapters distributed as packages.

### The mental model

```
┌──────────────────────────────────────────────────────────┐
│                    EventSourceRegistry                    │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐  │
│  │ kafka  │ │  mqtt  │ │  amqp  │ │  nats  │ │  sqs   │  │
│  │adapter │ │adapter │ │adapter │ │adapter │ │adapter │  │
│  └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘  │
└──────┼──────────┼──────────┼──────────┼──────────┼───────┘
       │          │          │          │          │
   ┌───▼──┐   ┌───▼──┐   ┌───▼──┐   ┌───▼──┐   ┌───▼──┐
   │Kafka │   │ MQTT │   │ AMQP │   │ NATS │   │  SQS │
   │ brkr │   │ brkr │   │ brkr │   │ srvr │   │(AWS) │
   └──┬───┘   └──┬───┘   └──┬───┘   └──┬───┘   └──┬───┘
      │          │          │          │          │
      └──────────┴──────────┼──────────┴──────────┘
                            │
                  ┌─────────▼─────────┐
                  │   Normalizer      │
                  │  (msg → Event)    │
                  └─────────┬─────────┘
                            │
                   ┌────────▼────────┐
                   │   Event Bus     │
                   └─────────────────┘
```

Every adapter is a separate package (`@my-agent/source-kafka`, `@my-agent/source-mqtt`, etc.). Users install the ones they need. The core agent knows nothing about any specific transport.

---

## 2. The EventSource Contract

One interface. Every adapter implements it. The registry doesn't care what's behind it.

```typescript
// src/events/sources/types.ts
export type SourceConfig = {
  id: string;                         // "orders-kafka", "sensor-mqtt"
  type: string;                       // "kafka" | "mqtt" | "amqp" | ...
  enabled: boolean;
  transport: TransportConfig;         // adapter-specific
  routing: RoutingConfig;             // how messages map to events
  delivery: DeliveryConfig;           // ack model, retries, DLQ
  security: SecurityConfig;
  limits: LimitsConfig;
  observability?: ObservabilityConfig;
};

export interface EventSourceAdapter {
  /** The transport family name — kafka, mqtt, amqp, etc. */
  readonly type: string;

  /** Minimum agent version this adapter requires. */
  readonly agentCompat: string;

  /** Validate config before attempting connection. Throw on invalid. */
  validateConfig(config: SourceConfig): Promise<void>;

  /** Construct a running source instance. */
  create(config: SourceConfig, deps: SourceDependencies): Promise<EventSourceInstance>;
}

export interface EventSourceInstance {
  readonly id: string;
  readonly type: string;

  /** Open connections, subscribe, begin consuming. */
  start(): Promise<void>;

  /** Stop consuming cleanly. Flush inflight ops. Close connections. */
  stop(reason?: string): Promise<void>;

  /** Pause consumption without disconnecting. */
  pause(): Promise<void>;
  resume(): Promise<void>;

  /** Liveness + metadata. */
  health(): Promise<SourceHealth>;

  /** Cumulative + gauge metrics. */
  metrics(): SourceMetrics;

  /** Optional: seek to a specific offset/position. */
  seek?(position: SeekPosition): Promise<void>;

  /** Optional: replay events from a time window or offset. */
  replay?(params: ReplayParams): AsyncGenerator<AgentEvent>;
}

export type SourceDependencies = {
  bus: EventBus;
  logger: Logger;
  metrics: MetricsRegistry;
  secrets: SecretResolver;             // resolves ${env:*}, ${secret:*}
  clock: Clock;                        // testable time source
  shutdownSignal: AbortSignal;
  normalizer: MessageNormalizer;
};

export type SourceHealth = {
  status: 'starting' | 'healthy' | 'degraded' | 'unhealthy' | 'stopped';
  lastConnectedAt?: number;
  lastMessageAt?: number;
  connectionErrors: number;
  details?: Record<string, unknown>;    // e.g., broker list, current partitions
};

export type SourceMetrics = {
  messagesReceived: number;
  messagesProcessed: number;
  messagesFailed: number;
  messagesDLQ: number;
  inflightCount: number;
  lagByPartition?: Record<string, number>;
  avgProcessMs: number;
  p99ProcessMs: number;
};
```

### Why each field exists

| Field | Why |
|---|---|
| `validateConfig` before `create` | Let ops see misconfig on `--dry-run` without opening connections |
| Separate `pause`/`resume` from `stop` | Backpressure control, maintenance windows |
| `seek` + `replay` | Kafka/Kinesis/Pulsar support it natively; exposing it lets the agent reprocess on demand |
| `SourceDependencies` injected | No globals; testable; clean shutdown |
| `clock` injected | Deterministic tests for time-based backoff |

---

## 3. The Source Registry

Same lifecycle pattern as plugin loading, MCP management, skill discovery. Unified machinery.

```typescript
// src/events/sources/registry.ts
export class EventSourceRegistry {
  private adapters = new Map<string, EventSourceAdapter>();
  private instances = new Map<string, EventSourceInstance>();

  constructor(private deps: SourceDependencies) {}

  /** Called when an adapter package is loaded (e.g., @my-agent/source-kafka). */
  registerAdapter(adapter: EventSourceAdapter) {
    if (this.adapters.has(adapter.type)) {
      throw new Error(`Adapter already registered: ${adapter.type}`);
    }
    this.adapters.set(adapter.type, adapter);
  }

  /** Load all sources from config. */
  async loadFromConfig(sources: SourceConfig[]) {
    const results = await Promise.allSettled(
      sources.filter(s => s.enabled).map(s => this.createAndStart(s)),
    );
    for (const [i, r] of results.entries()) {
      if (r.status === 'rejected') {
        this.deps.logger.error(`Source ${sources[i].id} failed to start`, r.reason);
      }
    }
  }

  async createAndStart(config: SourceConfig): Promise<EventSourceInstance> {
    const adapter = this.adapters.get(config.type);
    if (!adapter) throw new Error(`No adapter for type: ${config.type}`);

    if (!semver.satisfies(AGENT_VERSION, adapter.agentCompat)) {
      throw new Error(
        `Adapter ${config.type} requires agent ${adapter.agentCompat}, got ${AGENT_VERSION}`,
      );
    }

    await adapter.validateConfig(config);

    const instance = await adapter.create(config, this.deps);
    this.instances.set(config.id, instance);

    try {
      await instance.start();
    } catch (e) {
      this.instances.delete(config.id);
      throw e;
    }

    return instance;
  }

  async stop(id: string, reason = 'manual') {
    const inst = this.instances.get(id);
    if (!inst) return;
    await inst.stop(reason);
    this.instances.delete(id);
  }

  async stopAll(reason = 'shutdown') {
    await Promise.allSettled(
      Array.from(this.instances.values()).map(i => i.stop(reason)),
    );
    this.instances.clear();
  }

  async reload(id: string, newConfig: SourceConfig) {
    await this.stop(id, 'reload');
    await this.createAndStart(newConfig);
  }

  /** Global health across all instances. */
  async health(): Promise<RegistryHealth> {
    const entries = await Promise.all(
      Array.from(this.instances.entries()).map(async ([id, inst]) => {
        try { return [id, await inst.health()]; }
        catch (e) { return [id, { status: 'unhealthy', details: { error: String(e) } }]; }
      }),
    );
    return Object.fromEntries(entries);
  }
}
```

### Adapter discovery

Three load paths, mirroring the plugin system:

```typescript
// 1. Bundled (shipped with the binary)
import { KafkaAdapter } from './adapters/kafka';
registry.registerAdapter(new KafkaAdapter());

// 2. User-installed (npm package, loaded via require)
const userAdapters = await loadAdapterPackages(config.adapter_packages);
for (const a of userAdapters) registry.registerAdapter(a);

// 3. Dynamic (WASM plugin, future)
```

### Package shape

```typescript
// @my-agent/source-kafka/package.json
{
  "name": "@my-agent/source-kafka",
  "my-agent": {
    "kind": "event-source-adapter",
    "type": "kafka",
    "agent_compat": ">=0.5.0"
  },
  "main": "./dist/index.js"
}

// @my-agent/source-kafka/src/index.ts
import { KafkaAdapter } from './adapter';
export default new KafkaAdapter();
```

On agent startup, it scans `node_modules/@my-agent/source-*`, imports each, and registers. Users install a new transport with `npm install @my-agent/source-kafka`. No core changes.

---

## 4. Transport Families

Different transports have different semantics. Group them into families; each family gets a shared adapter base class so you're not re-solving the same problems.

| Family | Members | Delivery | Ordering | Fan-out | Ack model |
|---|---|---|---|---|---|
| **Streaming log** | Kafka, Kinesis, Pulsar, Redis Streams | At-least-once | Per-partition | Consumer groups | Offset commit |
| **Queue** | SQS, RabbitMQ, Azure Service Bus | At-least-once | Best-effort | Competing consumers | Per-message ack |
| **Pub/sub** | MQTT, NATS, Google Pub/Sub, Redis Pub/Sub | Varies (0/1/2) | None | Topics/subjects | Varies |
| **Real-time** | WebSocket, gRPC stream, SSE | At-most-once | FIFO per conn | Per connection | None |
| **Polling** | DB CDC, IMAP, S3 notify, RSS | At-least-once | Source-ordered | Single consumer | Watermark |
| **Webhook** | HTTP push (already covered) | At-least-once | None | Per-endpoint | HTTP 2xx |

### Key implications

- **Streaming log** sources need **offset management** — where are we in the stream? Store offsets durably.
- **Queue** sources need **visibility timeouts** — if your agent takes 5 min to process, the queue must not redeliver in 30s.
- **Pub/sub** sources have **no durability by default** — disconnect = lose messages. Use durable subscriptions where available.
- **Real-time** sources need **heartbeat + reconnect** — connections drop; plan for it.
- **Polling** sources need **watermarks** — "what's the last thing I processed?" in persistent storage.

---

## 5. Adapter Implementations

Sketches, not full code. Each is a couple hundred lines in practice.

### 5.1 Base class

```typescript
// src/events/sources/adapters/base.ts
export abstract class BaseSourceInstance implements EventSourceInstance {
  protected state: 'starting' | 'running' | 'paused' | 'stopped' = 'starting';
  protected startedAt?: number;
  protected lastMessageAt?: number;
  protected counters = {
    received: 0, processed: 0, failed: 0, dlq: 0, connectionErrors: 0,
  };
  protected latencyHist = new Histogram();

  constructor(
    public readonly id: string,
    public readonly type: string,
    protected config: SourceConfig,
    protected deps: SourceDependencies,
  ) {}

  async start(): Promise<void> {
    this.state = 'starting';
    await this.doStart();
    this.state = 'running';
    this.startedAt = Date.now();
  }

  async stop(reason?: string): Promise<void> {
    this.state = 'stopped';
    await this.doStop(reason);
  }

  async pause(): Promise<void> { this.state = 'paused'; await this.doPause(); }
  async resume(): Promise<void> { this.state = 'running'; await this.doResume(); }

  async health(): Promise<SourceHealth> {
    return {
      status: this.computeStatus(),
      lastConnectedAt: this.startedAt,
      lastMessageAt: this.lastMessageAt,
      connectionErrors: this.counters.connectionErrors,
      details: await this.healthDetails(),
    };
  }

  metrics(): SourceMetrics {
    return {
      messagesReceived: this.counters.received,
      messagesProcessed: this.counters.processed,
      messagesFailed: this.counters.failed,
      messagesDLQ: this.counters.dlq,
      inflightCount: this.getInflight(),
      avgProcessMs: this.latencyHist.mean(),
      p99ProcessMs: this.latencyHist.p99(),
    };
  }

  /** Subclass calls this when a raw message arrives. */
  protected async handleMessage(raw: RawMessage, ackCtx: AckContext): Promise<void> {
    const timer = this.latencyHist.start();
    this.counters.received++;
    this.lastMessageAt = Date.now();

    try {
      const event = await this.deps.normalizer.normalize(raw, this.config.routing);
      if (!event) {
        // Filtered out — treat as success, ack
        await ackCtx.ack();
        return;
      }

      await this.deps.bus.publish(event);
      this.counters.processed++;
      await ackCtx.ack();
    } catch (e) {
      this.counters.failed++;
      await this.handleFailure(raw, ackCtx, e as Error);
    } finally {
      timer.stop();
    }
  }

  protected async handleFailure(raw: RawMessage, ackCtx: AckContext, err: Error) {
    const retries = raw.meta?.deliveryCount ?? 0;
    if (retries < this.config.delivery.maxRetries) {
      await ackCtx.nack();  // requeue with backoff
    } else {
      await this.sendToDLQ(raw, err);
      await ackCtx.ack();   // dead-letter → don't keep retrying
      this.counters.dlq++;
    }
  }

  protected abstract doStart(): Promise<void>;
  protected abstract doStop(reason?: string): Promise<void>;
  protected abstract doPause(): Promise<void>;
  protected abstract doResume(): Promise<void>;
  protected abstract healthDetails(): Promise<Record<string, unknown>>;
  protected abstract getInflight(): number;
  protected abstract sendToDLQ(raw: RawMessage, err: Error): Promise<void>;
  protected abstract computeStatus(): SourceHealth['status'];
}
```

### 5.2 Kafka adapter (streaming log)

```typescript
// @my-agent/source-kafka/src/adapter.ts
import { Kafka, type Consumer } from 'kafkajs';

export class KafkaSourceInstance extends BaseSourceInstance {
  private consumer?: Consumer;
  private inflight = new Set<string>();

  protected async doStart() {
    const kafka = new Kafka({
      clientId: `agent-${this.id}`,
      brokers: this.config.transport.brokers,
      ssl: await this.resolveSSL(this.config.security),
      sasl: await this.resolveSASL(this.config.security),
    });

    this.consumer = kafka.consumer({
      groupId: this.config.transport.consumerGroup,
      sessionTimeout: 30_000,
      heartbeatInterval: 3000,
      maxWaitTimeInMs: 1000,
      maxBytesPerPartition: 1_048_576,
    });

    await this.consumer.connect();
    for (const topic of this.config.transport.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      partitionsConsumedConcurrently: this.config.limits.concurrency ?? 4,
      autoCommit: false,   // we commit after successful bus.publish
      eachMessage: async ({ topic, partition, message, heartbeat }) => {
        if (this.state !== 'running') return;

        const msgKey = `${topic}-${partition}-${message.offset}`;
        this.inflight.add(msgKey);

        await this.handleMessage(
          {
            key: message.key?.toString(),
            value: message.value?.toString() ?? '',
            headers: headersToObject(message.headers),
            topic,
            partition,
            offset: message.offset,
            timestamp: Number(message.timestamp),
          },
          {
            ack: async () => {
              await this.consumer!.commitOffsets([{
                topic,
                partition,
                offset: (BigInt(message.offset) + 1n).toString(),
              }]);
              this.inflight.delete(msgKey);
            },
            nack: async () => {
              // Kafka doesn't have native nack; use a retry topic
              await this.sendToRetryTopic(message, topic);
              await this.consumer!.commitOffsets([{
                topic, partition,
                offset: (BigInt(message.offset) + 1n).toString(),
              }]);
              this.inflight.delete(msgKey);
            },
          },
        );

        await heartbeat();  // prevent rebalance during slow processing
      },
    });
  }

  protected async doStop(reason?: string) {
    await this.consumer?.disconnect();
  }

  protected async doPause() {
    const assignments = this.consumer!.assignment();
    this.consumer!.pause(assignments);
  }

  protected async doResume() {
    const assignments = this.consumer!.assignment();
    this.consumer!.resume(assignments);
  }

  async seek(pos: SeekPosition) {
    if (pos.kind === 'offset') {
      this.consumer!.seek({ topic: pos.topic, partition: pos.partition, offset: pos.offset });
    } else if (pos.kind === 'timestamp') {
      // ... lookup offsets by timestamp, seek to each
    }
  }

  protected getInflight() { return this.inflight.size; }
  protected async healthDetails() {
    return { assignment: this.consumer?.assignment() ?? [] };
  }
  protected computeStatus() { /* based on last heartbeat, lag, errors */ return 'healthy' as const; }
  protected async sendToDLQ(raw: RawMessage, err: Error) {
    // Produce to configured DLQ topic
  }
}
```

### 5.3 MQTT adapter (pub/sub)

```typescript
// @my-agent/source-mqtt/src/adapter.ts
import mqtt, { type MqttClient } from 'mqtt';

export class MqttSourceInstance extends BaseSourceInstance {
  private client?: MqttClient;

  protected async doStart() {
    this.client = mqtt.connect(this.config.transport.brokerUrl, {
      username: await this.deps.secrets.resolve(this.config.security.username),
      password: await this.deps.secrets.resolve(this.config.security.password),
      clientId: `agent-${this.id}`,
      clean: false,                         // durable session
      reconnectPeriod: 1000,
      keepalive: 60,
      protocolVersion: 5,
    });

    this.client.on('connect', async () => {
      for (const topic of this.config.transport.topics) {
        await this.subscribeTopic(topic);
      }
    });

    this.client.on('error', (e) => {
      this.counters.connectionErrors++;
      this.deps.logger.warn(`MQTT ${this.id} error: ${e.message}`);
    });

    this.client.on('message', async (topic, payload, packet) => {
      if (this.state !== 'running') return;

      await this.handleMessage(
        {
          value: payload.toString(),
          topic,
          headers: packet.properties?.userProperties ?? {},
          qos: packet.qos,
          retain: packet.retain,
        },
        {
          ack: async () => {
            // MQTT ack is automatic at QoS 0; client handles QoS 1/2 internally
            if (packet.qos > 0 && 'messageId' in packet) {
              // Explicit PUBACK happens via client; nothing to do
            }
          },
          nack: async () => {
            // MQTT has no nack. Republish to a retry topic with delay.
            await this.publishRetry(topic, payload, packet);
          },
        },
      );
    });
  }

  private async subscribeTopic(sub: MqttSubscription) {
    return new Promise<void>((resolve, reject) => {
      this.client!.subscribe(sub.filter, { qos: sub.qos ?? 1 }, (err) => {
        err ? reject(err) : resolve();
      });
    });
  }

  protected async doStop() {
    return new Promise<void>(resolve => this.client?.end(false, {}, () => resolve()));
  }
  // ... pause/resume via unsubscribe/resubscribe, etc.
}
```

### 5.4 AMQP adapter (queue)

```typescript
// @my-agent/source-amqp/src/adapter.ts
import amqp, { type Channel, type Connection } from 'amqplib';

export class AmqpSourceInstance extends BaseSourceInstance {
  private connection?: Connection;
  private channel?: Channel;

  protected async doStart() {
    this.connection = await amqp.connect(this.config.transport.url, {
      heartbeat: 30,
    });

    this.connection.on('error', (e) => { this.counters.connectionErrors++; });
    this.connection.on('close', () => {
      if (this.state === 'running') this.scheduleReconnect();
    });

    this.channel = await this.connection.createChannel();
    await this.channel.prefetch(this.config.limits.concurrency ?? 10);

    for (const q of this.config.transport.queues) {
      await this.channel.assertQueue(q.name, { durable: true, ...q.options });

      await this.channel.consume(q.name, async (msg) => {
        if (!msg || this.state !== 'running') return;

        await this.handleMessage(
          {
            value: msg.content.toString(),
            headers: msg.properties.headers ?? {},
            routingKey: msg.fields.routingKey,
            meta: { deliveryCount: msg.properties.headers?.['x-delivery-count'] ?? 0 },
          },
          {
            ack: async () => this.channel!.ack(msg),
            nack: async () => this.channel!.nack(msg, false, false), // send to DLX
          },
        );
      }, { noAck: false });
    }
  }

  private scheduleReconnect() {
    // Exponential backoff reconnect — see §8
  }
  // ...
}
```

### 5.5 Other adapters in brief

**NATS** (`@my-agent/source-nats`)
- Subjects + queue groups for competing consumers.
- JetStream for durability; use pull subscriptions for explicit ack control.
- Auth via nkeys or JWT.

**SQS** (`@my-agent/source-sqs`)
- Long polling with `WaitTimeSeconds: 20`.
- Visibility timeout tuned to expected process time (+ safety margin).
- DLQ via redrive policy on the queue itself — adapter doesn't need to implement DLQ.
- FIFO queues for ordering; use `MessageGroupId` from routing config.

**Redis Streams** (`@my-agent/source-redis-streams`)
- `XREADGROUP` with consumer group for competing consumers.
- `XACK` after processing; `XPENDING` / `XCLAIM` for stuck-message recovery.
- Trim strategy to cap memory.

**Kinesis** (`@my-agent/source-kinesis`)
- Shard-based; one consumer per shard ideally.
- KCL-style checkpointing, but simpler with enhanced fan-out.

**Pulsar** (`@my-agent/source-pulsar`)
- Subscriptions (Exclusive/Shared/Failover/Key_Shared).
- Native retry topics + DLQ.

**WebSocket / SSE** (`@my-agent/source-websocket`)
- Single long-lived connection; heartbeats; jittered reconnect.
- No durability — combine with a local buffer + resume cursor if the protocol supports it.

**gRPC streaming** (`@my-agent/source-grpc`)
- Server-streaming RPCs as sources. Bi-directional for ack/control.

**Google Pub/Sub** (`@my-agent/source-gcp-pubsub`)
- Use `StreamingPull`, not pull. Modify ack deadline while processing.
- Flow control settings map to adapter `limits`.

**Azure Service Bus** (`@my-agent/source-azure-sb`)
- Sessions for ordered processing; AMQP 1.0 under the hood.
- Peek-lock mode; auto-renew lock during processing.

**Database CDC** (`@my-agent/source-cdc`)
- Debezium-compatible reader, or direct logical replication (Postgres), binlog (MySQL).
- Watermark = LSN / binlog position.

**S3 notifications** (`@my-agent/source-s3`)
- Typically wraps SQS (S3 → SQS → you).
- Per-object event with metadata; fetch object on demand.

**IMAP / email** (`@my-agent/source-imap`)
- IDLE for push notifications; polling fallback.
- Watermark = UID.

**RSS / Atom** (`@my-agent/source-rss`)
- Polling with ETag/Last-Modified.
- Dedup by GUID/link.

---

## 6. The Message Normalizer

Every transport has its own message shape. The **normalizer** is the single layer that converts `RawMessage` into `AgentEvent`.

```typescript
// src/events/normalizer.ts
export type RawMessage = {
  value: string;                       // the payload
  key?: string;                        // Kafka key, MQTT has none, SQS has none
  topic?: string;
  partition?: number;
  offset?: string;
  routingKey?: string;                 // AMQP
  headers?: Record<string, unknown>;
  timestamp?: number;
  meta?: Record<string, unknown>;
};

export interface MessageNormalizer {
  normalize(raw: RawMessage, routing: RoutingConfig): Promise<AgentEvent | null>;
}

export type RoutingConfig = {
  /** Which field contains the event kind? */
  kindSelector: JsonPath | string;

  /** How to decide the target? */
  targetSelector: TargetSelector;

  /** Optional filter — if this returns false, message is skipped. */
  filter?: { expr: string };           // JSONata, JMESPath, or CEL

  /** Optional transformer before normalization. */
  transform?: { expr: string };

  /** Format of `value` — json, protobuf, avro, msgpack, plain. */
  format?: 'json' | 'avro' | 'protobuf' | 'msgpack' | 'plain';

  /** Schema ID + registry URL for schema-registry-based formats. */
  schemaRegistry?: { url: string; subject: string };
};

export class DefaultMessageNormalizer implements MessageNormalizer {
  constructor(
    private schemaRegistry: SchemaRegistry,
    private logger: Logger,
  ) {}

  async normalize(raw: RawMessage, routing: RoutingConfig): Promise<AgentEvent | null> {
    // 1. Decode the payload
    const decoded = await this.decode(raw.value, routing);

    // 2. Apply filter
    if (routing.filter && !evaluateFilter(routing.filter.expr, decoded)) {
      return null;  // skip
    }

    // 3. Apply transform
    const body = routing.transform
      ? evaluateTransform(routing.transform.expr, decoded)
      : decoded;

    // 4. Resolve kind + target from selectors
    const kind = resolveKind(body, routing.kindSelector);
    const target = resolveTarget(body, raw, routing.targetSelector);

    // 5. Build the event
    return {
      id: raw.headers?.['x-event-id']?.toString() ?? uuid(),
      source: this.sourceDescriptor(raw),
      timestamp: raw.timestamp ?? Date.now(),
      kind,
      target,
      payload: body,
      auth: { kind: 'internal' },         // overlaid by security layer
      meta: {
        idempotencyKey: raw.headers?.['x-idempotency-key']?.toString()
          ?? this.deriveIdempotencyKey(raw),
        correlationId: raw.headers?.['x-correlation-id']?.toString(),
        causedBy: raw.headers?.['x-caused-by']?.toString(),
      },
    };
  }

  private async decode(value: string, routing: RoutingConfig) {
    switch (routing.format ?? 'json') {
      case 'json': return JSON.parse(value);
      case 'avro': return this.schemaRegistry.decodeAvro(Buffer.from(value, 'base64'), routing.schemaRegistry!);
      case 'protobuf': return this.schemaRegistry.decodeProto(Buffer.from(value, 'base64'), routing.schemaRegistry!);
      case 'msgpack': return msgpack.decode(Buffer.from(value, 'base64'));
      case 'plain': return { text: value };
    }
  }

  private deriveIdempotencyKey(raw: RawMessage): string {
    // Transport-specific natural keys: Kafka offset, SQS message ID, etc.
    if (raw.topic != null && raw.partition != null && raw.offset != null) {
      return `kafka:${raw.topic}:${raw.partition}:${raw.offset}`;
    }
    return crypto.createHash('sha256').update(raw.value).digest('hex');
  }
}
```

### Why a single normalizer

- **One place** to add schema-registry support, protobuf, avro, etc.
- **Uniform idempotency** — every message gets a key, transport-specific fallback.
- **Declarative routing** without coding — config describes how the message maps to an event.

### Example routing config (YAML-friendly)

```yaml
routing:
  format: json
  filter:
    expr: "$.event_type in ['order.placed', 'order.cancelled']"
  kindSelector: "$.event_type"
  targetSelector:
    type: skill
    name: "order-workflow"
    inputs:
      order_id: "$.order_id"
      customer_id: "$.customer.id"
```

A Kafka message with `{event_type: "order.placed", order_id: "42", customer: {id: "u1"}}` becomes:

```json
{
  "kind": "order.placed",
  "target": {
    "type": "skill",
    "name": "order-workflow",
    "inputs": { "order_id": "42", "customer_id": "u1" }
  }
}
```

No code change required to handle a new topic.

---

## 7. Delivery Semantics

The single hardest thing about event-driven at scale. Get these contracts clear up front.

### The three modes

| Mode | Meaning | Use when |
|---|---|---|
| **At-most-once** | Message may be lost; never duplicated | Metrics, telemetry where loss is OK |
| **At-least-once** | Message always delivered; may duplicate | Default for everything business-critical |
| **Exactly-once** | Delivered exactly once | Rarely achievable end-to-end; requires idempotent side-effects |

**You cannot achieve exactly-once without idempotent downstream ops.** Don't sell it. What you *can* achieve is at-least-once + idempotent processing, which is indistinguishable from exactly-once from the user's perspective.

### The agent's contract

Your agent's `DeliveryConfig`:

```typescript
type DeliveryConfig = {
  mode: 'at-most-once' | 'at-least-once';
  ackStrategy: 'before-publish' | 'after-publish' | 'after-dispatch';
  maxRetries: number;
  retryBackoff: { initialMs: number; maxMs: number; jitter: boolean };
  dlq?: DlqConfig;
  visibilityTimeoutMs?: number;        // for queues
  idempotency: {
    strategy: 'transport-natural' | 'header' | 'content-hash';
    ttlMs: number;
    store: 'memory' | 'redis' | 'sqlite';
  };
};
```

### ackStrategy trade-offs

- **`before-publish`** — ack the transport as soon as we received the message. Fast but at-most-once.
- **`after-publish`** — ack after `bus.publish()` succeeds. Safe default. Message redelivered if agent crashes before ack.
- **`after-dispatch`** — ack only after the dispatcher has fully handled the event (session injected, new session started, skill completed). Strongest durability; slowest. Use for critical workflows.

### DLQ (dead-letter queue)

```typescript
type DlqConfig = {
  kind: 'transport-native' | 'agent-managed';
  // For transport-native: SQS redrive policy, RabbitMQ DLX, Pulsar DLQ topic
  // For agent-managed: we write to a local jsonl or a separate queue
  destination?: string;
  onDlq?: 'alert' | 'retry-manual' | 'ignore';
};
```

Every adapter must support DLQ. Every message that exhausts retries goes somewhere a human can find it.

### Replay

For incident recovery, the adapter should expose `replay()`:

```typescript
for await (const event of source.replay({ from: '2026-04-15T00:00Z', to: '2026-04-15T01:00Z' })) {
  await dispatcher.handle(event);
}
```

Kafka/Kinesis/Pulsar support this natively. Queues (SQS, RabbitMQ) usually don't — replay requires a separate archive (S3, cold storage) fed from the DLQ.

---

## 8. Connection Management at Scale

Connections fail. Plan for it.

### Reconnection with exponential backoff + jitter

```typescript
class ReconnectStrategy {
  private attempt = 0;

  nextDelayMs(): number {
    const base = Math.min(
      this.config.initialMs * Math.pow(2, this.attempt),
      this.config.maxMs,
    );
    const jitter = this.config.jitter ? Math.random() * base * 0.3 : 0;
    this.attempt++;
    return base + jitter;
  }

  reset() { this.attempt = 0; }
}
```

**Jitter is non-negotiable** in any fleet with multiple agent instances. Otherwise all agents reconnect in lockstep when a broker flaps, hammering it.

### Circuit breaker

When an adapter has had N consecutive failures, open the circuit: stop trying for M seconds, emit an `unhealthy` status, alert.

```typescript
class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private consecutiveFailures = 0;
  private openedAt?: number;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt! > this.cooldownMs) {
        this.state = 'half-open';
      } else {
        throw new CircuitOpenError();
      }
    }

    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      if (this.state === 'half-open') this.state = 'closed';
      return result;
    } catch (e) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.state = 'open';
        this.openedAt = Date.now();
      }
      throw e;
    }
  }
}
```

### Health checks

Expose a liveness endpoint:

```typescript
// daemon.ts
app.get('/health', async (req, res) => {
  const registry = await sourceRegistry.health();
  const unhealthy = Object.entries(registry).filter(([, h]) => h.status === 'unhealthy');
  res.status(unhealthy.length ? 503 : 200).json({ sources: registry });
});
```

k8s probes, load balancers, and monitoring all hook into this.

### Graceful shutdown

When `SIGTERM` arrives:
1. Set registry state to "draining."
2. Stop accepting new sessions from dispatchers.
3. Pause (not stop) all sources.
4. Wait for inflight messages to complete (up to `shutdownGracePeriod`).
5. Stop sources in reverse start order.
6. Flush metrics, close bus.
7. Exit.

Your pod restart will drop zero messages if the grace period is tuned right.

---

## 9. Concurrency, Partitioning, Backpressure

### Per-source concurrency

Each source has its own concurrency limit. Don't let one busy Kafka topic starve a low-volume webhook:

```typescript
type LimitsConfig = {
  concurrency: number;                 // parallel message handlers
  maxInflight: number;                 // back-pressure threshold
  ratePerSec?: number;                 // smoothing
  maxPayloadBytes?: number;
  maxEventsPerMinute?: number;
};
```

Implement with a bounded queue + worker pool:

```typescript
class ConcurrencyLimiter {
  private inflight = 0;
  private waiters: Array<() => void> = [];

  constructor(private max: number) {}

  async acquire(): Promise<() => void> {
    if (this.inflight < this.max) {
      this.inflight++;
      return () => this.release();
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.inflight++;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.inflight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
```

### Partitioning for ordered processing

If order matters (per user, per order, per device), route by key:

```typescript
// In normalizer's targetSelector:
targetSelector:
  type: session
  sessionIdFrom: "$.customer_id"    // one session per customer
  action: inject
```

Kafka already hashes by key → same key to same partition → one consumer → in-order. MQTT / NATS don't guarantee; use a separate ordering key + local per-key queue.

### Backpressure propagation

When the dispatcher can't keep up:

```
Source ── too fast ──► Bus ── too slow ──► Dispatcher
  ▲                                              │
  │           pause()                            │
  └──────────────────────────────────────────────┘
```

Expose a signal:

```typescript
class EventBus {
  // ... earlier code
  private pressureWatermarkHigh = 1000;
  private pressureWatermarkLow = 100;
  private queueDepth = 0;

  private onPressureHigh() { for (const s of this.sources) s.pause(); }
  private onPressureLow() { for (const s of this.sources) s.resume(); }
}
```

Streaming sources (Kafka) and queue sources (SQS, RabbitMQ) honor pause cleanly. Push sources (MQTT, webhook) require unsubscribing and re-subscribing — or dropping (use a SizedRing and shed load under pressure).

### Per-target rate limiting

Beyond per-source: limit **how often a given target is triggered**. Without this, a chatty topic drains your LLM budget.

```typescript
// In dispatcher:
const targetKey = `target:${event.target.type}:${extractTargetId(event.target)}`;
if (!await rateLimiter.tryAcquire(targetKey)) {
  this.shed(event);  // drop or DLQ
  return;
}
```

---

## 10. Observability

You will regret flying blind at scale. Ship this from day one.

### Required metrics per source

```
source.{id}.messages.received           counter
source.{id}.messages.processed          counter
source.{id}.messages.failed             counter
source.{id}.messages.dlq                counter
source.{id}.inflight                    gauge
source.{id}.process.duration_ms         histogram
source.{id}.connection.errors           counter
source.{id}.lag                         gauge         (streaming only)
source.{id}.circuit.state               gauge         (0=closed 1=half 2=open)
```

Emit via OpenTelemetry or Prometheus client — whichever your infra speaks.

### Required spans / traces

One span per message from `received → event published → dispatched → target action completed`. Stitch via `correlationId`:

```typescript
const span = tracer.startSpan('source.message', {
  attributes: {
    'source.id': this.id,
    'source.type': this.type,
    'message.topic': raw.topic,
    'message.partition': raw.partition,
    'message.offset': raw.offset,
    'correlation.id': event.meta?.correlationId,
  },
});
```

### Lag dashboard

For streaming sources, **lag is the single most important metric**. `(latestOffset - committedOffset)` per partition. Alert on sustained non-zero lag beyond a threshold.

### Structured logs

Every event-flow log line: `source_id`, `event_id`, `correlation_id`, `target`, `outcome`. Plain text logs at scale are a dead-end.

### Audit trail

Write every processed event (source, target, auth, payload hash, outcome, timing) to an append-only log. Retain for compliance. Cheap. Saves you once.

---

## 11. Security at Scale

Transports have their own security; the agent layers its own on top.

### Transport-level auth

| Transport | Auth options |
|---|---|
| Kafka | SASL/PLAIN, SASL/SCRAM, SASL/OAUTHBEARER, mTLS |
| MQTT | Username/password, client cert (mTLS), JWT (MQTT 5) |
| AMQP | PLAIN, EXTERNAL (mTLS), AMQPLAIN |
| NATS | nkeys, JWT, user/pass |
| SQS | IAM role (preferred), access keys |
| Pulsar | JWT tokens, OAuth2, mTLS |
| gRPC | mTLS, JWT metadata |
| WebSocket | JWT in subprotocol or header |

Every adapter's `SecurityConfig` accepts `${env:*}`, `${secret:*}`, or file paths. Never plaintext in config.

### Per-source identity

Each source has its own service identity. Don't share credentials across sources — if one leaks, only one blast radius.

### Per-topic / per-queue authorization

At the broker: ACLs that limit what each service account can read. The agent can't accidentally consume a topic it shouldn't.

### Payload encryption

For PII-heavy streams:
- **TLS for in-flight** — mandatory.
- **Envelope encryption at rest** — payload encrypted with a KEK, DEK stored separately. Decrypt in the normalizer.

### PII redaction

Before logging/emitting metrics, scrub payloads:

```typescript
const payloadForLog = redact(event.payload, this.config.observability.redactPaths);
```

### Per-source permission scope (reminder from EVENT_DRIVEN_AGENT.md)

Any session spawned from a source has a permission scope **defined by the source config**, not inherited from the user. A Kafka-triggered session never has `Bash(*)`.

```yaml
sources:
  - id: orders-kafka
    # ...
    permissions:
      mode: auto
      allow: ["mcp__warehouse__*", "Read(**/*)"]
      deny: ["Bash(*)", "Edit(**/*)", "mcp__payments__*"]
```

### Tenant isolation

Multi-tenant agents: include `tenantId` in every event, propagate to all target sessions, enforce at the permission layer. One compromised source must not cross tenant boundaries.

---

## 12. Declarative Configuration

The whole point of this system: **add a new source = write a config file; no code.**

```yaml
# ~/.youragent/event-sources.yaml
version: 1
sources:
  - id: orders-kafka
    type: kafka
    enabled: true
    transport:
      brokers: ["kafka1:9092", "kafka2:9092", "kafka3:9092"]
      consumerGroup: "my-agent-orders"
      topics: ["orders.placed", "orders.cancelled"]
    security:
      sasl:
        mechanism: SCRAM-SHA-512
        username: "${secret:kafka_username}"
        password: "${secret:kafka_password}"
      ssl: { ca: "/etc/ssl/kafka-ca.pem" }
    routing:
      format: avro
      schemaRegistry:
        url: "https://schema-registry.internal"
        subject: "orders-value"
      kindSelector: "$.event_type"
      targetSelector:
        type: skill
        name: "order-workflow"
        inputs:
          order_id: "$.order_id"
    delivery:
      mode: at-least-once
      ackStrategy: after-publish
      maxRetries: 5
      retryBackoff: { initialMs: 1000, maxMs: 60000, jitter: true }
      dlq: { kind: transport-native, destination: "orders.dlq" }
    limits:
      concurrency: 8
      maxInflight: 100
      ratePerSec: 50
    permissions:
      mode: auto
      allow: ["mcp__warehouse__*", "Read(**/*)"]
      deny: ["Bash(*)"]

  - id: sensors-mqtt
    type: mqtt
    enabled: true
    transport:
      brokerUrl: "mqtts://mqtt.internal:8883"
      topics:
        - { filter: "sensors/+/temperature", qos: 1 }
        - { filter: "sensors/+/humidity", qos: 1 }
    security:
      username: "${env:MQTT_USER}"
      password: "${secret:mqtt_password}"
      tls: { ca: "/etc/ssl/mqtt-ca.pem" }
    routing:
      format: json
      kindSelector: { const: "sensor.reading" }
      targetSelector:
        type: session
        sessionIdFrom: "$.device_id"
        action: inject
    limits:
      concurrency: 50
      maxInflight: 1000

  - id: support-queue
    type: sqs
    enabled: true
    transport:
      queueUrl: "https://sqs.us-east-1.amazonaws.com/12345/support"
      region: "us-east-1"
      visibilityTimeoutSec: 300
    security:
      auth: { kind: iam-role }         # use ambient AWS creds
    routing:
      format: json
      kindSelector: "$.type"
      targetSelector:
        type: new-session
        initialPromptFrom: "$.prompt"
    permissions:
      mode: default
      allow: ["Read(**/*)", "mcp__support__*"]
```

Three transports, three semantics, three permission scopes — all in one file.

### Validation

Schema-validate on load (Zod). Surface errors with file paths and line numbers. Fail fast on startup; don't let a misconfigured source take down the whole agent:

```typescript
const results = await Promise.allSettled(sources.map(loadSource));
const failed = results.filter(r => r.status === 'rejected');
if (failed.length === sources.length) {
  throw new Error('All sources failed to load');
} else if (failed.length > 0) {
  logger.warn(`${failed.length}/${sources.length} sources failed`);
  // continue; healthy sources keep working
}
```

---

## 13. Worked Examples at Scale

### 13.1 Real-time fraud triage (Kafka)

**Transport**: Kafka topic `transactions.flagged`, 12 partitions, ~500 events/sec.

**Config**:
```yaml
- id: fraud-flags
  type: kafka
  transport: { brokers: [...], topics: [transactions.flagged], consumerGroup: fraud-agent }
  routing:
    targetSelector:
      type: skill
      name: fraud-triage
      inputs: { txn_id: "$.txn_id", amount: "$.amount", user_id: "$.user_id" }
  limits: { concurrency: 24 }          # 2 workers per partition
  delivery: { ackStrategy: after-dispatch, maxRetries: 3, dlq: { destination: fraud.dlq } }
```

**Flow**: Transaction flagged → event → normalizer extracts fields → skill `fraud-triage` spawned (sub-agent with read-only tools + `mcp__risk__*`) → agent decides: auto-block / escalate / clear → writes decision back via MCP. 500/sec handled with 24 concurrent sessions, avg ~4s each.

### 13.2 IoT fleet monitoring (MQTT)

**Transport**: MQTT broker, 50K devices, each publishing every 30s.

**Config**: one source per topic pattern. Per-device sessions via `sessionIdFrom: "$.device_id"`. Use `action: inject` to feed a long-running session per device.

**Trick**: at this scale, don't spawn a session per reading. Most readings are noise. Use the **filter** stage to drop anomaly-free readings; only surface abnormal ones.

```yaml
filter:
  expr: "$.temperature > 80 or $.humidity > 95 or $.vibration > 3.0"
```

50K devices × 1 event/30s = 1,600 events/sec → filter drops 95% → 80/sec reach the agent.

### 13.3 Customer support triage (SQS)

**Transport**: SQS queue fed by your ticketing system's webhook.

**Config**: `new-session` per ticket, `after-dispatch` ack (don't delete the SQS message until the session actually starts). Visibility timeout = 5 min; agent must ack or renew within.

**Scaling**: Horizontal. Run N agent instances; SQS competing-consumers mode distributes. No coordination needed.

### 13.4 Multi-source correlation (Kafka + DB CDC)

**Transports**: Kafka topic `user.events` + Postgres CDC from `orders` table.

**Approach**: Both sources publish into the same bus with the same `correlation_id` (user ID). A skill `correlate-activity` has a long-running session keyed by user, getting injected messages from both sources. The session builds a picture per user over time.

This is where **per-session state** + **multi-source injection** really pays off. Neither Kafka nor CDC alone has the right shape; the agent stitches them.

### 13.5 Autonomous ops (everything)

A single agent deployment with:
- **Prometheus alertmanager** → webhook source (alerts)
- **PagerDuty** → webhook source (incidents)
- **GitHub** → webhook source (PRs, issues)
- **S3 bucket notifications** → SQS source (new log files)
- **Slack** → WebSocket source (mentions)
- **Cron** → scheduled tasks
- **Self-wakeup** → polling loops

All routed through one event bus, all dispatched to appropriate skills or sessions. Multi-tenant if needed via `tenantId` in events. The agent becomes **an autonomous operations layer** — not a chatbot.

---

## 14. Build Order

Add on top of `EVENT_DRIVEN_AGENT.md`'s milestones. Roughly sequential; some can parallelize.

### Milestone S1 — The contract (2–3 days)

Define `EventSourceAdapter`, `EventSourceInstance`, `SourceConfig`. Build the registry. Implement an **in-memory source** for testing (`registry.publish('test', event)`). DoD: registry + contract + test harness working; no real transport.

### Milestone S2 — First real adapter: Kafka (5–7 days)

Cover the streaming log pattern end-to-end: connect, subscribe, consume, ack, offset commit, DLQ via retry topic, pause/resume, reconnect. This adapter shakes out 80% of the design issues.

### Milestone S3 — Normalizer + routing config (3–5 days)

JSON-path selectors, filters, transforms. Schema-registry support (start with Confluent's Avro; add Protobuf later). Format decoders.

### Milestone S4 — Second real adapter: SQS or RabbitMQ (3–5 days)

Different family (queue, not streaming). Validates the base class abstractions.

### Milestone S5 — Observability (3–4 days)

Metrics, traces, structured logs, health endpoint, lag dashboard.

### Milestone S6 — DLQ + replay (2–3 days)

Transport-native for both above adapters; replay API.

### Milestone S7 — Third adapter: MQTT or NATS (3–4 days)

Pub/sub family. Confirms the pattern holds for a different semantics profile.

### Milestone S8 — Backpressure + circuit breaker (2–3 days)

Pause propagation, health-driven circuit opening, graceful shutdown.

### Milestone S9 — Declarative config loader (2 days)

YAML, env/secret resolution, schema validation, hot reload on SIGHUP.

### Milestone S10 — Additional adapters as packages (1–2 days each)

Pulsar, Kinesis, Redis Streams, WebSocket, gRPC, GCP Pub/Sub, Azure Service Bus, CDC, IMAP, S3. Each reuses the base class; each is a small package.

**Total: ~5–7 weeks** for a production-grade pluggable event source system with 2–3 first-class adapters. Additional adapters are days, not weeks.

---

## 15. Pitfalls

### ❌ Letting adapters do routing

Routing belongs in the normalizer + dispatcher, configured declaratively. If every adapter implements its own routing logic, you have N versions of `if (msg.type === X) ...` scattered across the codebase.

### ❌ Sharing a single consumer across topics at the adapter level

Looks efficient, kills observability. One source instance per logical stream. Per-source metrics are non-negotiable.

### ❌ Ignoring partition affinity

Kafka in-order guarantees are per-partition. If you parallelize across partitions without care, per-key ordering breaks. Use `partitionsConsumedConcurrently` at the Kafka level, not a blind worker pool.

### ❌ Acking before publish

Ack-before-publish = at-most-once, regardless of what your config says. One broker hiccup = lost messages. The default should be `after-publish`; make users explicitly opt into `before-publish`.

### ❌ No idempotency strategy

Every message will be redelivered eventually. If your dispatcher spawns a session every time, you'll spawn duplicates under broker retries. Use the idempotency cache in the dispatcher, keyed by `event.meta.idempotencyKey`, TTL longer than any retry window.

### ❌ DLQ with no human in the loop

A DLQ nobody watches is a memory leak. Alert on non-zero DLQ depth. Build a `/dlq list` / `/dlq replay` / `/dlq drop` command. Treat it as first-class operational state.

### ❌ Per-event session spawning on high-volume streams

10K events/sec × 1 session each = 10K LLM calls/sec. Your bill, your rate limits, and your sanity all die. Use **session coalescing**: route events to a shared session keyed by entity, inject as batched messages.

### ❌ Cross-source coupling via globals

"This Kafka handler writes to the module-level `kafkaOffsets` variable…" Your test harness becomes impossible. Every source instance is self-contained with injected deps.

### ❌ Not setting max payload sizes

A 100MB Kafka message will OOM your agent. Enforce `maxPayloadBytes` at the adapter layer; reject oversized messages to DLQ without parsing.

### ❌ Same credentials for producer and consumer paths

If your agent both consumes from and produces to a transport (e.g., Kafka both in and out), use **separate** credentials with least privilege. Consumer shouldn't have produce ACLs on business topics.

### ❌ Missing graceful drain on shutdown

`kill -15` → instant exit → inflight messages roll back → redelivery storm on restart. Implement drain with a grace period. Test it by rolling pods under load.

### ❌ Treating each adapter as a special snowflake

If you find yourself writing a fifth adapter and still hand-coding retries, backoff, health tracking, DLQ handling — you skipped the base class. Go back. Every adapter should be ~200–400 lines of *transport-specific* code, not repeating plumbing.

### ❌ Forgetting that sources feed the same bus

A cron trigger and a Kafka message both publish `AgentEvent`s. The dispatcher can't tell the difference — which is the whole point. If you start special-casing "this is a Kafka event" downstream, you've leaked the abstraction.

### ❌ Not supporting dry-run / seek

Production incidents demand "replay yesterday's orders topic from 14:00–15:00 against the fixed code." If your adapter doesn't support `seek` and `replay`, you'll be writing a one-off script at 3am. Support them from the start.

---

## Closing Thought

The pattern here is the same pattern you've seen in three docs now:

- **Plugins** = pluggable feature packs
- **MCP** = pluggable tool providers
- **Skills** = pluggable workflows
- **Event sources** = pluggable triggers

All of them share the same abstractions: a **contract**, a **registry**, **lifecycle hooks**, **scoped permissions**, **declarative config**. Once you have one of these right, the rest are mechanical. Get the contract right and any number of packages can implement against it without touching your core.

At scale, the payoff is enormous: the core agent stays small, cohesive, and understood by one person. The ecosystem sprawls — Kafka, MQTT, AMQP, NATS, Pulsar, gRPC, CDC, IMAP — but as *independent packages*, each owned by whoever cares. Your agent is no longer a product. It is **a platform that consumes the world and takes action on what it sees.**

That's the whole game.

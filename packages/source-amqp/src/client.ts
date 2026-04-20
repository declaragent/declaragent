/**
 * Thin facade over the `amqplib` surface the adapter uses. Keeping this
 * interface narrow lets unit tests stub RabbitMQ completely — `amqplib`
 * itself only appears in `createAmqplibClient` (the default factory).
 *
 * Modelled as a two-level facade: `AmqpClient` owns the connection;
 * `AmqpChannel` owns the confirm-channel. Only one channel per adapter
 * instance is needed.
 */

export interface AmqpClientOptions {
  /** AMQP URL, e.g. `amqp://guest:guest@localhost:5672`. */
  url: string;
  /** Optional heartbeat (seconds). `amqplib` default is 0 (disabled). */
  heartbeatSeconds?: number;
}

export interface AmqpQueueOptions {
  durable?: boolean;
  autoDelete?: boolean;
  exclusive?: boolean;
  arguments?: Record<string, unknown>;
}

export interface AmqpExchangeOptions {
  durable?: boolean;
  autoDelete?: boolean;
  internal?: boolean;
  arguments?: Record<string, unknown>;
}

/**
 * Message fields + properties surfaced by `basic.deliver`. We keep the
 * field list tight to what the adapter actually uses — headers live on
 * `properties.headers` (RabbitMQ convention), while `deliveryTag` + the
 * `redelivered` flag live on `fields`.
 */
export interface AmqpIncomingMessage {
  content: Uint8Array;
  fields: {
    deliveryTag: number;
    redelivered: boolean;
    exchange: string;
    routingKey: string;
    consumerTag: string;
  };
  properties: {
    headers?: Record<string, unknown>;
    messageId?: string;
    timestamp?: number;
    correlationId?: string;
    contentType?: string;
    contentEncoding?: string;
    type?: string;
    appId?: string;
    userId?: string;
    priority?: number;
    replyTo?: string;
    expiration?: string;
  };
}

export type AmqpMessageHandler = (msg: AmqpIncomingMessage) => Promise<void> | void;

export interface AmqpPublishOptions {
  headers?: Record<string, unknown>;
  persistent?: boolean;
  messageId?: string;
  timestamp?: number;
  correlationId?: string;
  contentType?: string;
  contentEncoding?: string;
}

/**
 * Per-adapter confirm channel. Every declare / bind / consume / ack /
 * publish flows through this handle. A single channel is enough because
 * adapter-level concurrency is bounded by the base class's
 * `ConcurrencyLimiter`.
 */
export interface AmqpChannel {
  assertExchange(
    exchange: string,
    type: 'direct' | 'topic' | 'headers' | 'fanout',
    options?: AmqpExchangeOptions,
  ): Promise<void>;
  assertQueue(queue: string, options?: AmqpQueueOptions): Promise<{ queue: string }>;
  bindQueue(queue: string, exchange: string, pattern: string): Promise<void>;
  prefetch(count: number, global?: boolean): Promise<void>;
  /** Starts a consumer. Returns the server-assigned consumer tag. */
  consume(queue: string, handler: AmqpMessageHandler): Promise<{ consumerTag: string }>;
  cancel(consumerTag: string): Promise<void>;
  ack(deliveryTag: number, allUpTo?: boolean): void;
  nack(deliveryTag: number, allUpTo?: boolean, requeue?: boolean): void;
  /**
   * Publish with publisher confirms. Resolves when the broker has
   * acknowledged the message (or rejects on nack / closed channel).
   */
  publish(
    exchange: string,
    routingKey: string,
    content: Uint8Array,
    options?: AmqpPublishOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface AmqpClient {
  connect(): Promise<void>;
  createConfirmChannel(): Promise<AmqpChannel>;
  close(): Promise<void>;
}

// ─── Default impl: real amqplib ─────────────────────────────────────────

import * as amqplib from 'amqplib';
import type {
  ChannelModel as AmqplibChannelModel,
  ConfirmChannel as AmqplibConfirmChannel,
  Options as AmqplibOptions,
  ConsumeMessage,
} from 'amqplib';

export function createAmqplibClient(options: AmqpClientOptions): AmqpClient {
  let connection: AmqplibChannelModel | null = null;

  const connectOptions: string | AmqplibOptions.Connect =
    options.heartbeatSeconds !== undefined
      ? { ...parseUrl(options.url), heartbeat: options.heartbeatSeconds }
      : options.url;

  return {
    async connect() {
      // `amqplib`'s `connect()` returns a `ChannelModel` whose type differs
      // across package versions — the narrow surface we use (`createConfirmChannel`,
      // `close`) is stable across 0.10.x.
      connection = (await amqplib.connect(connectOptions as never)) as AmqplibChannelModel;
    },
    async createConfirmChannel(): Promise<AmqpChannel> {
      if (!connection) throw new Error('amqp client not connected');
      const ch = (await connection.createConfirmChannel()) as AmqplibConfirmChannel;
      return wrapChannel(ch);
    },
    async close() {
      if (connection) {
        try {
          await connection.close();
        } finally {
          connection = null;
        }
      }
    },
  };
}

function wrapChannel(ch: AmqplibConfirmChannel): AmqpChannel {
  return {
    async assertExchange(exchange, type, opts) {
      await ch.assertExchange(exchange, type, toAssertExchange(opts));
    },
    async assertQueue(queue, opts) {
      const reply = await ch.assertQueue(queue, toAssertQueue(opts));
      return { queue: reply.queue };
    },
    async bindQueue(queue, exchange, pattern) {
      await ch.bindQueue(queue, exchange, pattern);
    },
    async prefetch(count, global) {
      await ch.prefetch(count, global ?? false);
    },
    async consume(queue, handler) {
      const reply = await ch.consume(queue, (msg: ConsumeMessage | null) => {
        if (!msg) return; // consumer cancelled by the broker
        const wrapped: AmqpIncomingMessage = {
          content: new Uint8Array(msg.content),
          fields: {
            deliveryTag: msg.fields.deliveryTag,
            redelivered: msg.fields.redelivered,
            exchange: msg.fields.exchange,
            routingKey: msg.fields.routingKey,
            consumerTag: msg.fields.consumerTag,
          },
          properties: mapProperties(msg.properties),
        };
        // Errors inside the handler are caught by BaseSourceInstance; any
        // that escape that are an adapter bug. Don't crash the channel on
        // rejected promises returned by the registered handler.
        void Promise.resolve(handler(wrapped)).catch(() => {});
      });
      return { consumerTag: reply.consumerTag };
    },
    async cancel(consumerTag) {
      await ch.cancel(consumerTag);
    },
    ack(deliveryTag, allUpTo) {
      ch.ack(synthMessage(deliveryTag), allUpTo ?? false);
    },
    nack(deliveryTag, allUpTo, requeue) {
      ch.nack(synthMessage(deliveryTag), allUpTo ?? false, requeue ?? true);
    },
    async publish(exchange, routingKey, content, opts) {
      const publishOptions = toPublishOptions(opts);
      const buf = Buffer.from(content);
      await new Promise<void>((resolve, reject) => {
        const ok = ch.publish(exchange, routingKey, buf, publishOptions, (err) => {
          if (err) reject(err);
          else resolve();
        });
        if (!ok) {
          // `publish` returns false under broker-side back-pressure; the
          // channel emits `drain` when it's safe again. The awaiter still
          // fires on confirm, but we surface the signal via the logger on
          // the caller side (base-source logs backpressure as a warn).
        }
      });
    },
    async close() {
      await ch.close();
    },
  };
}

/**
 * `amqplib.ack` / `.nack` take the full message object; the only field
 * they actually inspect is `fields.deliveryTag`. Synth a minimal object
 * to keep our narrower `AmqpChannel` API in shape.
 */
function synthMessage(deliveryTag: number): amqplib.Message {
  return {
    content: Buffer.alloc(0),
    fields: {
      deliveryTag,
      redelivered: false,
      exchange: '',
      routingKey: '',
    },
    properties: {
      contentType: undefined,
      contentEncoding: undefined,
      headers: {},
      deliveryMode: undefined,
      priority: undefined,
      correlationId: undefined,
      replyTo: undefined,
      expiration: undefined,
      messageId: undefined,
      timestamp: undefined,
      type: undefined,
      userId: undefined,
      appId: undefined,
      clusterId: undefined,
    },
  } as amqplib.Message;
}

function mapProperties(props: ConsumeMessage['properties']): AmqpIncomingMessage['properties'] {
  const out: AmqpIncomingMessage['properties'] = {};
  if (props.headers !== undefined) out.headers = { ...props.headers };
  if (props.messageId !== undefined) out.messageId = String(props.messageId);
  if (props.timestamp !== undefined) out.timestamp = Number(props.timestamp);
  if (props.correlationId !== undefined) out.correlationId = String(props.correlationId);
  if (props.contentType !== undefined) out.contentType = String(props.contentType);
  if (props.contentEncoding !== undefined) out.contentEncoding = String(props.contentEncoding);
  if (props.type !== undefined) out.type = String(props.type);
  if (props.appId !== undefined) out.appId = String(props.appId);
  if (props.userId !== undefined) out.userId = String(props.userId);
  if (props.priority !== undefined) out.priority = Number(props.priority);
  if (props.replyTo !== undefined) out.replyTo = String(props.replyTo);
  if (props.expiration !== undefined) out.expiration = String(props.expiration);
  return out;
}

function toAssertQueue(opts?: AmqpQueueOptions): AmqplibOptions.AssertQueue | undefined {
  if (!opts) return undefined;
  const out: AmqplibOptions.AssertQueue = {};
  if (opts.durable !== undefined) out.durable = opts.durable;
  if (opts.autoDelete !== undefined) out.autoDelete = opts.autoDelete;
  if (opts.exclusive !== undefined) out.exclusive = opts.exclusive;
  if (opts.arguments !== undefined) out.arguments = opts.arguments;
  return out;
}

function toAssertExchange(opts?: AmqpExchangeOptions): AmqplibOptions.AssertExchange | undefined {
  if (!opts) return undefined;
  const out: AmqplibOptions.AssertExchange = {};
  if (opts.durable !== undefined) out.durable = opts.durable;
  if (opts.autoDelete !== undefined) out.autoDelete = opts.autoDelete;
  if (opts.internal !== undefined) out.internal = opts.internal;
  if (opts.arguments !== undefined) out.arguments = opts.arguments;
  return out;
}

function toPublishOptions(opts?: AmqpPublishOptions): AmqplibOptions.Publish {
  const out: AmqplibOptions.Publish = {};
  if (!opts) return out;
  if (opts.headers !== undefined) out.headers = opts.headers;
  if (opts.persistent !== undefined) out.persistent = opts.persistent;
  if (opts.messageId !== undefined) out.messageId = opts.messageId;
  if (opts.timestamp !== undefined) out.timestamp = opts.timestamp;
  if (opts.correlationId !== undefined) out.correlationId = opts.correlationId;
  if (opts.contentType !== undefined) out.contentType = opts.contentType;
  if (opts.contentEncoding !== undefined) out.contentEncoding = opts.contentEncoding;
  return out;
}

/**
 * Break an `amqp://` URL into the object form `amqplib` wants when extra
 * `heartbeat` / `frameMax` knobs are supplied alongside it.
 */
function parseUrl(url: string): AmqplibOptions.Connect {
  const parsed = new URL(url);
  const out: AmqplibOptions.Connect = {
    protocol: parsed.protocol.replace(':', ''),
    hostname: parsed.hostname || 'localhost',
  };
  if (parsed.port) out.port = Number(parsed.port);
  if (parsed.username) out.username = decodeURIComponent(parsed.username);
  if (parsed.password) out.password = decodeURIComponent(parsed.password);
  if (parsed.pathname && parsed.pathname !== '/') {
    out.vhost = decodeURIComponent(parsed.pathname.slice(1));
  }
  return out;
}

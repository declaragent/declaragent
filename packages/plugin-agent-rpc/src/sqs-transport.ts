/**
 * Amazon SQS-backed `RpcTransport` — at-least-once RPC over SQS
 * (post-enterprise backlog item #24a, Sprint 3).
 *
 * Third broker in the at-least-once family alongside Kafka (backlog #7
 * / Slice 7) and JetStream (backlog #23). Delivery semantics:
 *
 *   - `publish(topic, envelope)` encodes the envelope and calls
 *     `SendMessage` against the queue URL mapped to `topic`. On standard
 *     queues the call is fire-and-forget-once-acked; on FIFO queues we
 *     honour the configured `messageGroupId` resolver and (optionally)
 *     a `messageDeduplicationId` resolver so exactly-once-within-5-min
 *     dedup works as SQS intends.
 *   - `subscribe(topic, handler)` starts a per-topic long-poll loop
 *     (one in-flight `ReceiveMessage` at a time). Handler success →
 *     `DeleteMessage`. Handler throw → leave the message un-deleted so
 *     visibility-timeout + queue-level `maxReceiveCount` → native SQS
 *     DLQ redrive fires. Envelope decode failure is terminal (the bytes
 *     won't parse any better on retry) — by default we **delete** the
 *     malformed message after logging it via `onDecodeFail`; callers
 *     who want the message pushed to a side-channel for inspection can
 *     override with `decodeFail: 'leave'` (let SQS redrive) or
 *     `decodeFail: 'send-dlq'` + `dlqQueueUrl`.
 *   - `close()` stops every loop and drains in-flight handlers.
 *
 * ## Standard vs FIFO queues
 *
 * SQS has two queue flavours with different trade-offs:
 *
 *   - **Standard queues** (most common): at-least-once, best-effort
 *     ordering, nearly unlimited throughput. Use these unless ordering
 *     between messages in a logical group is load-bearing.
 *   - **FIFO queues** (suffix `.fifo`): strict ordering within a
 *     `MessageGroupId`, exactly-once dedup within a 5-minute window
 *     keyed by `MessageDeduplicationId`. Throughput caps at 300 TPS per
 *     API action (3,000 with batch calls) per group — you pay for
 *     ordering.
 *
 * The transport auto-detects FIFO by the `.fifo` suffix on the queue
 * URL (matches `source-sqs`). When FIFO, a `messageGroupId` resolver
 * MUST be provided — either a static string (all requests for that
 * topic serialize behind one group) or a function receiving the
 * envelope (typically keyed by `correlationId` or `to` agent id). The
 * default, when FIFO is detected and no resolver is provided, uses
 * `envelope.to` as the group id — safe for request/response flows where
 * ordering per target-agent is what operators want.
 *
 * ## Credentials
 *
 * By default the transport delegates to the AWS SDK credential chain
 * (env vars → shared config → IAM role / instance profile). Static
 * credentials are accepted but discouraged outside local testing. The
 * `endpoint` override supports LocalStack for the `SQS_INTEGRATION=1`
 * test path (mirrors `@declaragent/source-sqs`).
 *
 * ## Relationship to `@declaragent/source-sqs`
 *
 * Both packages use `@aws-sdk/client-sqs` and both wrap it in a narrow
 * `SqsClient` / `SqsClientLike` structural type. This file intentionally
 * duplicates the narrow structural shape instead of depending on
 * `@declaragent/source-sqs` — the source adapter's `SqsClient` is
 * consume-oriented (long-poll + ack-by-delete) and ties into
 * `BaseSourceInstance`, which isn't the right abstraction for an RPC
 * transport. Sharing a single SDK dep across both packages is fine;
 * sharing the client type would create a circular dep (source depends
 * on core which depends on plugin-agent-rpc types).
 *
 * @since 0.7.3 — post-enterprise backlog item #24a.
 */

import type {
  AgentRpcEnvelope,
  Logger,
  RpcSubscriptionHandler,
  RpcTransport,
} from '@declaragent/core';
import { decodeEnvelope, encodeEnvelope } from '@declaragent/core';

// ── Minimal structural types for the AWS SDK surface we touch.
//    Tests pass in fakes implementing exactly these shapes; the real
//    `@aws-sdk/client-sqs` is loaded via dynamic import so this package
//    has no hard SDK dep.

/** Structural view of `Message` returned by SQS `ReceiveMessage`. */
export interface SqsIncomingMessageLike {
  /** Unique per send; stable across redeliveries. */
  readonly messageId: string;
  /**
   * Receipt handle — required for `DeleteMessage` + `ChangeMessageVisibility`.
   * Changes on every `ReceiveMessage` return.
   */
  readonly receiptHandle: string;
  readonly body: string;
  /** Standard SQS system attributes (`ApproximateReceiveCount`, …). */
  readonly attributes?: Readonly<Record<string, string>>;
  /** `MessageGroupId` is populated only for FIFO queues. */
  readonly messageGroupId?: string;
}

/** Request shape for `ReceiveMessage`. */
export interface SqsReceiveRequest {
  queueUrl: string;
  /** SQS caps at 10. */
  maxMessages: number;
  /** Long-poll wait time; SQS caps at 20. */
  waitTimeSeconds: number;
  /**
   * Visibility timeout (seconds) applied to the returned batch. When
   * undefined the queue's default is used.
   */
  visibilityTimeoutSeconds?: number;
}

export interface SqsSendRequest {
  queueUrl: string;
  body: string;
  /** Required for FIFO queues; ignored by SQS on standard queues. */
  messageGroupId?: string;
  /**
   * Optional FIFO dedup key. When omitted on a FIFO queue the queue's
   * content-based dedup (if enabled) kicks in; otherwise SQS rejects.
   */
  messageDeduplicationId?: string;
}

/**
 * Narrow SQS client facade — kept intentionally small so tests can
 * stub it without pulling the AWS SDK. The default implementation wraps
 * `@aws-sdk/client-sqs`.
 */
export interface SqsClientLike {
  receiveMessage(req: SqsReceiveRequest): Promise<readonly SqsIncomingMessageLike[]>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
  sendMessage(req: SqsSendRequest): Promise<{ messageId: string }>;
  /** Best-effort shutdown. Safe to call multiple times. */
  disconnect(): Promise<void>;
}

/**
 * SDK-module factory — `createSqsTransport` resolves credentials via
 * this factory when the caller doesn't inject an `sqsClient` directly.
 * Matches the shape `@aws-sdk/client-sqs` provides via named exports.
 */
export interface SqsClientFactory {
  create(options: SqsClientFactoryOptions): SqsClientLike;
}

export interface SqsClientFactoryOptions {
  region: string;
  endpoint?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Default 3 — matches AWS SDK default. */
  maxAttempts?: number;
}

/**
 * Decode-failure policy. The envelope decoder is strict — malformed
 * bytes will not parse better on retry. Three strategies:
 *
 *   - `'delete'` (default) — log + delete. Keeps the queue clean and
 *     lets healthy traffic flow. Matches JetStream's `term` choice.
 *   - `'leave'` — neither delete nor change visibility. SQS will
 *     redeliver until the queue's `maxReceiveCount` sends the message
 *     to its configured native DLQ. Use this when a queue-level DLQ is
 *     your inspection channel.
 *   - `'send-dlq'` — forward the raw body to an operator-owned DLQ
 *     queue (`dlqQueueUrl`) and delete from the main queue. Use when
 *     you want decode failures separated from handler failures.
 */
export type SqsDecodeFailPolicy = 'delete' | 'leave' | 'send-dlq';

export interface CreateSqsTransportOptions {
  /** AWS region. Required when no injected `sqsClient`. */
  region?: string;
  /**
   * Map of topic → `queueUrl`. Either this or `queueUrlFor` must be
   * supplied. When both are provided, `queueUrlFor` wins.
   */
  queueUrls?: Readonly<Record<string, string>>;
  /** Dynamic topic → `queueUrl` resolver. */
  queueUrlFor?: (topic: string) => string;
  /**
   * `MessageGroupId` resolver for FIFO queues. Accepts a static string
   * (all messages serialize behind one group) or a function called per
   * envelope (typically keyed by `to` or `correlationId`). When a FIFO
   * queue is detected (URL ends in `.fifo`) and no resolver is given,
   * defaults to the envelope's `to` field.
   */
  messageGroupId?: string | ((envelope: AgentRpcEnvelope) => string);
  /**
   * `MessageDeduplicationId` resolver for FIFO queues. Optional —
   * omit when the queue has content-based dedup enabled. Provide when
   * you need deterministic dedup behaviour keyed by, e.g., the
   * envelope's `messageId`.
   */
  messageDeduplicationId?: string | ((envelope: AgentRpcEnvelope) => string);
  /**
   * SDK visibility timeout (seconds). When undefined the queue's
   * default applies. Tune up when handlers regularly run longer than
   * the queue default; tune down to tighten redelivery latency on
   * handler crashes.
   */
  visibilityTimeoutSeconds?: number;
  /**
   * Long-poll wait time (seconds). SQS caps at 20. Default: 20 — the
   * SQS-recommended maximum, which minimises idle API spend.
   */
  waitTimeSeconds?: number;
  /** Max messages per `ReceiveMessage` batch. SQS caps at 10. Default: 10. */
  maxMessages?: number;
  /**
   * Max concurrent in-flight handler calls per topic. Acts as a
   * back-pressure ceiling: when reached the poll loop pauses until a
   * handler completes. Default: 10 (matches `maxMessages`).
   */
  maxInFlight?: number;
  /**
   * Decode-failure policy. Default `'delete'` — log + remove the bad
   * message so healthy traffic flows. See `SqsDecodeFailPolicy`.
   */
  decodeFail?: SqsDecodeFailPolicy;
  /**
   * Required when `decodeFail: 'send-dlq'`. The queue URL malformed
   * payloads are forwarded to before deletion from the main queue.
   */
  dlqQueueUrl?: string;
  /** AWS SDK maxAttempts. Default 3 — matches the SDK default. */
  maxAttempts?: number;
  /**
   * Static credentials. Prefer the default credential chain (IAM role,
   * shared config, env vars). Supply only when the chain isn't
   * acceptable for the deployment.
   */
  credentials?: SqsClientFactoryOptions['credentials'];
  /** Custom endpoint — primarily for LocalStack + test doubles. */
  endpoint?: string;
  /**
   * Injected client — bypasses `sqsClientFactory` entirely. Supply in
   * tests or when the host already manages an SDK client.
   */
  sqsClient?: SqsClientLike;
  /**
   * Injected SDK factory — used when `sqsClient` is not supplied.
   * Default: dynamic-import-based wrapper around `@aws-sdk/client-sqs`.
   */
  sqsClientFactory?: SqsClientFactory;
  logger?: Logger;
}

const DEFAULT_WAIT_TIME_SECONDS = 20;
const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_MAX_IN_FLIGHT = 10;
const DEFAULT_DECODE_FAIL: SqsDecodeFailPolicy = 'delete';

/** Returns true when a queue URL points at a FIFO queue. */
export function isFifoQueueUrl(queueUrl: string): boolean {
  return queueUrl.endsWith('.fifo');
}

export async function createSqsTransport(opts: CreateSqsTransportOptions): Promise<RpcTransport> {
  if (opts.queueUrls === undefined && opts.queueUrlFor === undefined) {
    throw new Error(
      'createSqsTransport: either queueUrls map or queueUrlFor resolver must be supplied',
    );
  }
  if (opts.decodeFail === 'send-dlq' && opts.dlqQueueUrl === undefined) {
    throw new Error('createSqsTransport: decodeFail="send-dlq" requires dlqQueueUrl');
  }

  const resolveQueueUrl = (topic: string): string => {
    if (opts.queueUrlFor !== undefined) return opts.queueUrlFor(topic);
    const url = opts.queueUrls?.[topic];
    if (url === undefined || url === '') {
      throw new Error(`createSqsTransport: no queueUrl mapped for topic "${topic}"`);
    }
    return url;
  };

  const client = opts.sqsClient ?? (await buildDefaultClient(opts));

  const waitTimeSeconds = clamp(opts.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS, 0, 20);
  const maxMessages = clamp(opts.maxMessages ?? DEFAULT_MAX_MESSAGES, 1, 10);
  const maxInFlight = Math.max(1, opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
  const decodeFail = opts.decodeFail ?? DEFAULT_DECODE_FAIL;

  const handlers = new Map<string, Set<RpcSubscriptionHandler>>();
  const pollers = new Map<string, PollerState>();
  let closed = false;

  const transport: RpcTransport = {
    kind: 'sqs',

    async publish(topic, envelope) {
      if (closed) throw new Error('createSqsTransport: transport closed');
      const queueUrl = resolveQueueUrl(topic);
      const body = encodeEnvelope(envelope);
      const req: SqsSendRequest = { queueUrl, body };
      if (isFifoQueueUrl(queueUrl)) {
        req.messageGroupId = resolveGroupId(envelope, opts.messageGroupId);
        const dedup = resolveDedupId(envelope, opts.messageDeduplicationId);
        if (dedup !== undefined) req.messageDeduplicationId = dedup;
      }
      await client.sendMessage(req);
    },

    subscribe(topic, handler): () => void {
      if (closed) {
        opts.logger?.warn('sqs-transport.subscribe-after-close', { topic });
        return () => {};
      }
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
        const queueUrl = resolveQueueUrl(topic);
        const state: PollerState = {
          stopped: false,
          inFlight: 0,
          loop: null,
        };
        pollers.set(topic, state);
        state.loop = runPollLoop({
          client,
          state,
          topic,
          queueUrl,
          handlers,
          waitTimeSeconds,
          maxMessages,
          maxInFlight,
          visibilityTimeoutSeconds: opts.visibilityTimeoutSeconds,
          decodeFail,
          dlqQueueUrl: opts.dlqQueueUrl,
          logger: opts.logger,
        }).catch((err) => {
          opts.logger?.error('sqs-transport.poll-loop-fatal', {
            topic,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      set.add(handler);

      return () => {
        const s = handlers.get(topic);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) {
          handlers.delete(topic);
          const p = pollers.get(topic);
          if (p) {
            pollers.delete(topic);
            p.stopped = true;
          }
        }
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const p of pollers.values()) p.stopped = true;
      const loops = Array.from(pollers.values(), (p) => p.loop).filter(
        (l): l is Promise<void> => l !== null,
      );
      pollers.clear();
      handlers.clear();
      await Promise.allSettled(loops);
      try {
        await client.disconnect();
      } catch {
        // best-effort
      }
    },
  };

  return transport;
}

// ── Poll loop ────────────────────────────────────────────────────────────

interface PollerState {
  stopped: boolean;
  inFlight: number;
  loop: Promise<void> | null;
}

interface PollLoopContext {
  client: SqsClientLike;
  state: PollerState;
  topic: string;
  queueUrl: string;
  handlers: Map<string, Set<RpcSubscriptionHandler>>;
  waitTimeSeconds: number;
  maxMessages: number;
  maxInFlight: number;
  visibilityTimeoutSeconds: number | undefined;
  decodeFail: SqsDecodeFailPolicy;
  dlqQueueUrl: string | undefined;
  logger: Logger | undefined;
}

async function runPollLoop(ctx: PollLoopContext): Promise<void> {
  while (!ctx.state.stopped) {
    // Back-pressure: if at capacity, wait a tick before re-checking.
    if (ctx.state.inFlight >= ctx.maxInFlight) {
      await sleep(25);
      continue;
    }
    let batch: readonly SqsIncomingMessageLike[] = [];
    try {
      const slots = Math.min(ctx.maxMessages, ctx.maxInFlight - ctx.state.inFlight);
      const req: SqsReceiveRequest = {
        queueUrl: ctx.queueUrl,
        maxMessages: Math.max(1, slots),
        waitTimeSeconds: ctx.waitTimeSeconds,
      };
      if (ctx.visibilityTimeoutSeconds !== undefined) {
        req.visibilityTimeoutSeconds = ctx.visibilityTimeoutSeconds;
      }
      batch = await ctx.client.receiveMessage(req);
    } catch (err) {
      ctx.logger?.warn('sqs-transport.receive-failed', {
        topic: ctx.topic,
        err: err instanceof Error ? err.message : String(err),
      });
      // Back off briefly so a hard AWS outage doesn't hot-spin.
      await sleep(500);
      continue;
    }
    if (ctx.state.stopped) break;
    if (batch.length === 0) continue;

    for (const msg of batch) {
      ctx.state.inFlight += 1;
      void dispatchMessage(ctx, msg).finally(() => {
        ctx.state.inFlight -= 1;
      });
    }
  }
}

async function dispatchMessage(ctx: PollLoopContext, msg: SqsIncomingMessageLike): Promise<void> {
  let envelope: AgentRpcEnvelope;
  try {
    envelope = decodeEnvelope(msg.body);
  } catch (err) {
    ctx.logger?.warn('sqs-transport.parse-failed', {
      topic: ctx.topic,
      messageId: msg.messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    await handleDecodeFailure(ctx, msg);
    return;
  }
  const set = ctx.handlers.get(ctx.topic);
  if (!set) {
    // Subscription removed mid-flight. Don't delete — let visibility
    // timeout return the message to another replica.
    return;
  }
  const snapshot = Array.from(set);
  let handlerThrew = false;
  for (const handler of snapshot) {
    try {
      await handler(envelope);
    } catch (err) {
      handlerThrew = true;
      ctx.logger?.warn('sqs-transport.handler-error', {
        topic: ctx.topic,
        messageId: msg.messageId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (handlerThrew) {
    // Leave the message un-deleted; SQS visibility-timeout + queue-level
    // maxReceiveCount → native DLQ redrive handles retries from here.
    return;
  }
  try {
    await ctx.client.deleteMessage(ctx.queueUrl, msg.receiptHandle);
  } catch (err) {
    ctx.logger?.warn('sqs-transport.delete-failed', {
      topic: ctx.topic,
      messageId: msg.messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleDecodeFailure(
  ctx: PollLoopContext,
  msg: SqsIncomingMessageLike,
): Promise<void> {
  switch (ctx.decodeFail) {
    case 'leave':
      // Do nothing — SQS will redeliver until maxReceiveCount trips the
      // queue-native redrive policy.
      return;
    case 'send-dlq':
      if (ctx.dlqQueueUrl !== undefined) {
        try {
          await ctx.client.sendMessage({ queueUrl: ctx.dlqQueueUrl, body: msg.body });
        } catch (err) {
          ctx.logger?.warn('sqs-transport.dlq-send-failed', {
            topic: ctx.topic,
            messageId: msg.messageId,
            err: err instanceof Error ? err.message : String(err),
          });
          // Even if the DLQ send failed, fall through to delete — the
          // message is terminal on the main queue; retaining it would
          // only cause redelivery storms.
        }
      }
      try {
        await ctx.client.deleteMessage(ctx.queueUrl, msg.receiptHandle);
      } catch {
        // best-effort
      }
      return;
    default:
      // 'delete'
      try {
        await ctx.client.deleteMessage(ctx.queueUrl, msg.receiptHandle);
      } catch (err) {
        ctx.logger?.warn('sqs-transport.delete-failed', {
          topic: ctx.topic,
          messageId: msg.messageId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function resolveGroupId(
  envelope: AgentRpcEnvelope,
  spec: CreateSqsTransportOptions['messageGroupId'],
): string {
  if (typeof spec === 'function') return spec(envelope);
  if (typeof spec === 'string' && spec.length > 0) return spec;
  // FIFO default: serialize per `to` agent — preserves request ordering
  // to any one recipient. Callers who want per-correlation ordering
  // supply an explicit resolver.
  return envelope.to;
}

function resolveDedupId(
  envelope: AgentRpcEnvelope,
  spec: CreateSqsTransportOptions['messageDeduplicationId'],
): string | undefined {
  if (typeof spec === 'function') return spec(envelope);
  if (typeof spec === 'string' && spec.length > 0) return spec;
  return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function buildDefaultClient(opts: CreateSqsTransportOptions): Promise<SqsClientLike> {
  if (opts.region === undefined || opts.region === '') {
    throw new Error(
      'createSqsTransport: region is required when no sqsClient is supplied (default credential chain uses region for endpoint resolution)',
    );
  }
  const factory = opts.sqsClientFactory ?? (await loadAwsSqsFactory());
  const factoryOpts: SqsClientFactoryOptions = { region: opts.region };
  if (opts.endpoint !== undefined) factoryOpts.endpoint = opts.endpoint;
  if (opts.credentials !== undefined) factoryOpts.credentials = opts.credentials;
  if (opts.maxAttempts !== undefined) factoryOpts.maxAttempts = opts.maxAttempts;
  return factory.create(factoryOpts);
}

async function loadAwsSqsFactory(): Promise<SqsClientFactory> {
  try {
    // Indirect specifier — same dynamic-import trick as the Kafka and
    // JetStream transports. Keeps `@aws-sdk/client-sqs` out of this
    // package's declared deps; the host provides it.
    const specifier = '@aws-sdk/client-sqs';
    const mod = (await import(/* @vite-ignore */ specifier)) as unknown as Record<string, unknown>;
    const SQSClient = (mod.SQSClient ??
      (mod.default as Record<string, unknown> | undefined)?.SQSClient) as
      | (new (
          cfg: Record<string, unknown>,
        ) => unknown)
      | undefined;
    const ReceiveMessageCommand = pickCtor(mod, 'ReceiveMessageCommand');
    const DeleteMessageCommand = pickCtor(mod, 'DeleteMessageCommand');
    const SendMessageCommand = pickCtor(mod, 'SendMessageCommand');
    if (!SQSClient || !ReceiveMessageCommand || !DeleteMessageCommand || !SendMessageCommand) {
      throw new Error('@aws-sdk/client-sqs is missing expected exports');
    }
    return {
      create(options) {
        const client = new SQSClient({
          region: options.region,
          ...(options.endpoint !== undefined && { endpoint: options.endpoint }),
          ...(options.credentials !== undefined && {
            credentials: {
              accessKeyId: options.credentials.accessKeyId,
              secretAccessKey: options.credentials.secretAccessKey,
              ...(options.credentials.sessionToken !== undefined && {
                sessionToken: options.credentials.sessionToken,
              }),
            },
          }),
          ...(options.maxAttempts !== undefined && { maxAttempts: options.maxAttempts }),
        }) as { send(cmd: unknown): Promise<unknown>; destroy(): void };

        return {
          async receiveMessage(req) {
            const out = (await client.send(
              new ReceiveMessageCommand({
                QueueUrl: req.queueUrl,
                MaxNumberOfMessages: req.maxMessages,
                WaitTimeSeconds: req.waitTimeSeconds,
                ...(req.visibilityTimeoutSeconds !== undefined && {
                  VisibilityTimeout: req.visibilityTimeoutSeconds,
                }),
                AttributeNames: ['All'],
              }),
            )) as { Messages?: ReadonlyArray<Record<string, unknown>> };
            const msgs = out.Messages ?? [];
            return msgs.map((m) => {
              const attrs = (m.Attributes as Record<string, string> | undefined) ?? {};
              const base: SqsIncomingMessageLike = {
                messageId: (m.MessageId as string | undefined) ?? '',
                receiptHandle: (m.ReceiptHandle as string | undefined) ?? '',
                body: (m.Body as string | undefined) ?? '',
                attributes: attrs,
                ...(attrs.MessageGroupId !== undefined && {
                  messageGroupId: attrs.MessageGroupId,
                }),
              };
              return base;
            });
          },
          async deleteMessage(queueUrl, receiptHandle) {
            await client.send(
              new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
            );
          },
          async sendMessage(req) {
            const out = (await client.send(
              new SendMessageCommand({
                QueueUrl: req.queueUrl,
                MessageBody: req.body,
                ...(req.messageGroupId !== undefined && {
                  MessageGroupId: req.messageGroupId,
                }),
                ...(req.messageDeduplicationId !== undefined && {
                  MessageDeduplicationId: req.messageDeduplicationId,
                }),
              }),
            )) as { MessageId?: string };
            return { messageId: out.MessageId ?? '' };
          },
          async disconnect() {
            try {
              client.destroy();
            } catch {
              // best-effort
            }
          },
        };
      },
    };
  } catch (err) {
    throw new Error(
      `createSqsTransport: unable to load "@aws-sdk/client-sqs" (${err instanceof Error ? err.message : String(err)}). Install the peer dep with \`npm install @aws-sdk/client-sqs\` or pass \`sqsClient\` / \`sqsClientFactory\` explicitly.`,
    );
  }
}

function pickCtor(
  mod: Record<string, unknown>,
  name: string,
): (new (input: Record<string, unknown>) => unknown) | undefined {
  const top = mod[name] as (new (input: Record<string, unknown>) => unknown) | undefined;
  if (top) return top;
  const def = mod.default as Record<string, unknown> | undefined;
  return def?.[name] as (new (input: Record<string, unknown>) => unknown) | undefined;
}

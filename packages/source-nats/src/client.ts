/**
 * Thin facade over the `nats` npm surface the adapter uses. Keeping this
 * interface narrow lets unit tests stub NATS + JetStream completely — the
 * real `nats` client only appears in `createNatsJetStreamClient` (the
 * default factory).
 *
 * The facade wraps JetStream pull consumers (`consumer.consume()`) in a
 * callback-based API so the instance code stays transport-agnostic. For
 * adapters that want raw core-NATS subscriptions instead (no stream, just
 * subject queue groups), that's a separate follow-up — the JetStream path
 * is the primary target per the Phase-4 plan.
 */

export interface NatsTlsConfig {
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface NatsClientOptions {
  servers: readonly string[];
  /** NATS client name — shows up in monitoring + auth logs. */
  name?: string;
  /** Simple password auth. Paired with `password`. */
  user?: string;
  password?: string;
  /** Token auth (supersedes user/password when both are set). */
  token?: string;
  /** NKey seed (newline-free Uint8Array or string). Used for nkey/JWT auth. */
  nkeySeed?: string;
  /** TLS options (if the server requires TLS). */
  tls?: NatsTlsConfig | boolean;
  /** Max reconnect attempts. Default: forever. */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay (ms). */
  reconnectTimeWaitMs?: number;
}

export interface NatsIncomingMessage {
  /** Subject the message was delivered on. */
  subject: string;
  /** Raw payload bytes. */
  data: Uint8Array;
  /** Stream sequence (JetStream). Monotonically increasing per stream. */
  streamSequence: number;
  /** Consumer delivery sequence. */
  deliverySequence: number;
  /**
   * Number of times this message has been delivered (1 on first delivery,
   * incremented by JetStream when `nak()` / ackWait elapses).
   */
  redeliveryCount: number;
  /** Headers flattened to a plain dict. `undefined` if no headers. */
  headers?: Record<string, string>;
  /** Publish timestamp from JetStream's `DeliveryInfo`, if available (ms). */
  timestampMs?: number;
}

/**
 * Handle for an active JetStream consume loop. Callers hold a reference
 * so they can `stop()` the iterator on pause / shutdown.
 */
export interface NatsConsumerHandle {
  /** Stops the consume iterator. The returned promise settles when the loop exits. */
  stop(): Promise<void>;
  /** Promise that resolves when the consume loop naturally exits (error or stop). */
  readonly closed: Promise<void>;
}

/**
 * Options for creating + binding a JetStream consumer. When `durableName`
 * is set the consumer is durable (server retains state across
 * disconnects); otherwise it's ephemeral.
 */
export interface ConsumeOptions {
  stream: string;
  /** Durable consumer name. When set, the consumer is created if missing, else bound. */
  durableName?: string;
  /** Subject filters for the consumer. Defaults to all subjects of the stream. */
  filterSubjects?: readonly string[];
  /** Start sequence (`deliver_policy = 'by_start_sequence'`). */
  startSequence?: number;
  /** Start time (ISO). Alternative to `startSequence`. */
  startTime?: string;
  /**
   * Deliver only new messages (`deliver_policy = 'new'`). Used for
   * `seek({ kind: 'end' })` / `seek({ kind: 'beginning' })` with no
   * further override.
   */
  deliverPolicy?: 'all' | 'last' | 'new' | 'by_start_sequence' | 'by_start_time';
  /** Ack wait (ms). How long JetStream waits before redelivering. */
  ackWaitMs?: number;
  /** Max deliveries before JetStream quarantines the message. */
  maxDeliver?: number;
}

export interface NatsClient {
  /**
   * Subscribe to a JetStream consumer. The returned handle lets the caller
   * `stop()` the consume loop. `onMessage` is invoked once per delivered
   * message; it should not throw — caller ack/nak semantics are driven
   * through `NatsIncomingMessage` / the ack context built around it.
   */
  consume(
    opts: ConsumeOptions,
    onMessage: (msg: NatsIncomingMessage, ack: NatsAckHandle) => Promise<void> | void,
    onError?: (err: Error) => void,
  ): Promise<NatsConsumerHandle>;
  /**
   * Publish an arbitrary payload on a subject. Used by the adapter's
   * agent-managed DLQ path.
   */
  publish(subject: string, data: Uint8Array, headers?: Record<string, string>): Promise<void>;
  /** Drain in-flight subscriptions and close the connection. */
  close(): Promise<void>;
  /** Is the underlying transport currently connected? */
  isConnected(): boolean;
}

/**
 * Ack surface exposed to the instance's message handler. Kept separate
 * from `NatsIncomingMessage` so the raw-msg view stays read-only.
 */
export interface NatsAckHandle {
  ack(): Promise<void>;
  nak(delayMs?: number): Promise<void>;
  /** Terminate (don't redeliver). */
  term(reason?: string): Promise<void>;
  /** Signal progress so ackWait is reset. */
  working(): Promise<void>;
}

// ─── Default impl: real `nats` npm ───────────────────────────────────────

import { type NatsConnection, connect } from 'nats';

/**
 * Builds the default client backed by the `nats` npm package. Connects
 * eagerly so config errors surface at `consume` time.
 */
export function createNatsJetStreamClient(options: NatsClientOptions): NatsClient {
  let conn: NatsConnection | null = null;
  let connecting: Promise<NatsConnection> | null = null;

  const ensureConnected = async (): Promise<NatsConnection> => {
    if (conn) return conn;
    if (!connecting) {
      connecting = connect({
        servers: [...options.servers],
        ...(options.name !== undefined && { name: options.name }),
        ...(options.user !== undefined && { user: options.user }),
        ...(options.password !== undefined && { pass: options.password }),
        ...(options.token !== undefined && { token: options.token }),
        ...(options.maxReconnectAttempts !== undefined && {
          maxReconnectAttempts: options.maxReconnectAttempts,
        }),
        ...(options.reconnectTimeWaitMs !== undefined && {
          reconnectTimeWait: options.reconnectTimeWaitMs,
        }),
        ...(options.tls !== undefined && {
          tls: typeof options.tls === 'boolean' ? {} : { ...options.tls },
        }),
      });
    }
    conn = await connecting;
    return conn;
  };

  return {
    async consume(opts, onMessage, onError) {
      const nc = await ensureConnected();
      const jsm = await nc.jetstreamManager();

      const consumerConfig: Record<string, unknown> = {
        ack_policy: 'explicit',
        ...(opts.durableName !== undefined && { durable_name: opts.durableName }),
        ...(opts.filterSubjects !== undefined &&
          opts.filterSubjects.length > 0 && {
            filter_subjects: [...opts.filterSubjects],
          }),
        ...(opts.ackWaitMs !== undefined && { ack_wait: opts.ackWaitMs * 1_000_000 }),
        ...(opts.maxDeliver !== undefined && { max_deliver: opts.maxDeliver }),
      };
      if (opts.startSequence !== undefined) {
        consumerConfig.deliver_policy = 'by_start_sequence';
        consumerConfig.opt_start_seq = opts.startSequence;
      } else if (opts.startTime !== undefined) {
        consumerConfig.deliver_policy = 'by_start_time';
        consumerConfig.opt_start_time = opts.startTime;
      } else if (opts.deliverPolicy !== undefined) {
        consumerConfig.deliver_policy = opts.deliverPolicy;
      }

      // `add` upserts: if the consumer already exists with a matching
      // config JetStream will accept; otherwise we catch + bind. For
      // ephemeral (no durable_name) we always create.
      let resolvedDurableName = opts.durableName;
      if (resolvedDurableName !== undefined) {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: JetStream manager typing is loose here.
          await jsm.consumers.add(opts.stream, consumerConfig as any);
        } catch (err) {
          // Already exists → bind. Anything else is a real error.
          const msg = err instanceof Error ? err.message : String(err);
          if (!/already in use|consumer name already in use/i.test(msg)) {
            throw err;
          }
        }
      } else {
        // biome-ignore lint/suspicious/noExplicitAny: JetStream manager typing is loose here.
        const info = await jsm.consumers.add(opts.stream, consumerConfig as any);
        resolvedDurableName = info.name;
      }

      const js = nc.jetstream();
      const consumer = await js.consumers.get(opts.stream, resolvedDurableName ?? '');
      const iter = await consumer.consume();

      let resolveClosed!: () => void;
      const closed = new Promise<void>((r) => {
        resolveClosed = r;
      });
      let stopped = false;

      const run = async (): Promise<void> => {
        try {
          for await (const m of iter) {
            if (stopped) break;
            const headers: Record<string, string> | undefined = extractHeaders(m.headers);
            const raw: NatsIncomingMessage = {
              subject: m.subject,
              data: m.data,
              streamSequence: Number(m.info.streamSequence),
              deliverySequence: Number(m.info.deliverySequence),
              redeliveryCount: Number(m.info.redeliveryCount ?? 1),
              ...(headers !== undefined && { headers }),
              ...(m.info.timestampNanos !== undefined && {
                timestampMs: Number(BigInt(m.info.timestampNanos) / 1_000_000n),
              }),
            };
            const ack: NatsAckHandle = {
              async ack() {
                m.ack();
              },
              async nak(delayMs?: number) {
                m.nak(delayMs);
              },
              async term(reason?: string) {
                m.term(reason);
              },
              async working() {
                m.working();
              },
            };
            try {
              await onMessage(raw, ack);
            } catch (err) {
              onError?.(err instanceof Error ? err : new Error(String(err)));
            }
          }
        } catch (err) {
          if (!stopped) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
          }
        } finally {
          resolveClosed();
        }
      };

      void run();

      return {
        async stop() {
          if (stopped) return;
          stopped = true;
          try {
            iter.stop();
          } catch {
            // best-effort
          }
          await closed;
        },
        closed,
      };
    },

    async publish(subject, data, headers) {
      const nc = await ensureConnected();
      if (headers) {
        // Headers on core publish require MsgHdrs; the `nats` client
        // exposes `headers()` as a factory but importing it dynamically
        // keeps the typing-surface narrow for stubs.
        const { headers: makeHeaders } = await import('nats');
        const h = makeHeaders();
        for (const [k, v] of Object.entries(headers)) {
          h.set(k, v);
        }
        nc.publish(subject, data, { headers: h });
      } else {
        nc.publish(subject, data);
      }
      await nc.flush();
    },

    async close() {
      if (conn) {
        try {
          await conn.drain();
        } catch {
          // best-effort; `drain` may throw if already closed.
        }
        conn = null;
        connecting = null;
      }
    },

    isConnected() {
      return conn !== null && !conn.isClosed();
    },
  };
}

function extractHeaders(h: unknown): Record<string, string> | undefined {
  if (!h) return undefined;
  // MsgHdrs exposes `keys()` + `get()`. We normalize to a flat dict.
  const out: Record<string, string> = {};
  const hdrs = h as { keys?: () => Iterable<string>; get?: (k: string) => string };
  if (typeof hdrs.keys === 'function' && typeof hdrs.get === 'function') {
    for (const k of hdrs.keys()) {
      out[k] = hdrs.get(k);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

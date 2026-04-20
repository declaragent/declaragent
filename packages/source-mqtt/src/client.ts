/**
 * Thin facade over the `mqtt` (MQTT.js) surface the adapter uses. Keeping
 * this interface narrow lets unit tests stub MQTT completely — the real
 * `mqtt` package only appears in `createMqttjsClient` (the default
 * factory).
 */

export type MqttQoS = 0 | 1 | 2;

/**
 * MQTT protocol version. `3` = MQTT 3.1, `4` = MQTT 3.1.1, `5` = MQTT 5.0.
 * Defaults to 5 so user-properties + per-subscription options are
 * available; drop to 4 for older brokers.
 */
export type MqttProtocolVersion = 3 | 4 | 5;

export interface MqttClientOptions {
  /** `mqtt://host:1883`, `mqtts://host:8883`, `ws://…`, `wss://…`. */
  brokerUrl: string;
  clientId: string;
  username?: string;
  password?: string;
  /**
   * MQTT "clean start" flag. `false` keeps a durable session on the broker
   * so QoS 1/2 subscriptions survive a disconnect. Defaults to `false`.
   */
  clean?: boolean;
  protocolVersion?: MqttProtocolVersion;
  keepaliveSeconds?: number;
  /** TLS fields. Only honored for `mqtts://` / `wss://` brokers. */
  ca?: string;
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
}

export interface MqttSubscription {
  topic: string;
  qos: MqttQoS;
}

export interface MqttIncomingMessage {
  topic: string;
  payload: Uint8Array;
  qos: MqttQoS;
  retain: boolean;
  /** MQTT packet id for QoS > 0. `undefined` for QoS 0. */
  messageId?: number;
  /** `true` when the broker flags this packet as a redelivery (QoS > 0). */
  dup: boolean;
  /**
   * MQTT 5 user-properties, normalized to `Record<string, string>`. Older
   * protocol versions always surface an empty object.
   */
  userProperties: Record<string, string>;
}

export type MqttMessageHandler = (msg: MqttIncomingMessage) => Promise<void> | void;

export interface MqttPublishOptions {
  qos?: MqttQoS;
  retain?: boolean;
  userProperties?: Record<string, string>;
}

export interface MqttClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(subscriptions: readonly MqttSubscription[]): Promise<void>;
  unsubscribe(topics: readonly string[]): Promise<void>;
  publish(topic: string, payload: Uint8Array | string, opts?: MqttPublishOptions): Promise<void>;
  onMessage(handler: MqttMessageHandler): () => void;
  /** Returns true while the underlying TCP/TLS connection is established. */
  isConnected(): boolean;
}

// ─── Default impl: real mqtt (MQTT.js) ──────────────────────────────────

import type { IClientOptions, IClientPublishOptions, IPublishPacket } from 'mqtt';
import { connect as mqttConnect } from 'mqtt';

export function createMqttjsClient(options: MqttClientOptions): MqttClient {
  const clientOpts: IClientOptions = {
    clientId: options.clientId,
    clean: options.clean ?? false,
    protocolVersion: (options.protocolVersion ?? 5) as IClientOptions['protocolVersion'],
    // Let higher-level reconnect be handled by the adapter's lifecycle
    // rather than mqtt.js's built-in backoff — we still inherit its
    // reconnect on transient errors, but keep the interval modest.
    reconnectPeriod: 1000,
    ...(options.username !== undefined && { username: options.username }),
    ...(options.password !== undefined && { password: options.password }),
    ...(options.keepaliveSeconds !== undefined && { keepalive: options.keepaliveSeconds }),
    ...(options.ca !== undefined && { ca: options.ca }),
    ...(options.cert !== undefined && { cert: options.cert }),
    ...(options.key !== undefined && { key: options.key }),
    ...(options.rejectUnauthorized !== undefined && {
      rejectUnauthorized: options.rejectUnauthorized,
    }),
  };

  const client = mqttConnect(options.brokerUrl, clientOpts);
  // Avoid emitting to process-level `error` listeners until the adapter
  // subscribes; the subscriber below will re-throw during `connect()`.
  client.on('error', () => {
    // Swallowed — the adapter surfaces connection errors via the
    // `connect()` promise and `isConnected()` check.
  });

  const handlers = new Set<MqttMessageHandler>();
  client.on('message', (topic, payload, packet: IPublishPacket) => {
    const userProps = extractUserProperties(packet);
    const msg: MqttIncomingMessage = {
      topic,
      payload: new Uint8Array(payload),
      qos: (packet.qos ?? 0) as MqttQoS,
      retain: Boolean(packet.retain),
      ...(packet.messageId !== undefined && { messageId: packet.messageId }),
      dup: Boolean(packet.dup),
      userProperties: userProps,
    };
    for (const h of handlers) {
      try {
        const result = h(msg);
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch(() => {
            // handler's own failure is already surfaced via the adapter's
            // metrics/logger; nothing more to do here.
          });
        }
      } catch {
        // ditto — ignore sync throws; the adapter owns error reporting.
      }
    }
  });

  return {
    async connect() {
      if (client.connected) return;
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          client.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          client.off('connect', onConnect);
          reject(err);
        };
        client.once('connect', onConnect);
        client.once('error', onError);
      });
    },
    async disconnect() {
      await new Promise<void>((resolve) => {
        client.end(false, {}, () => resolve());
      });
    },
    async subscribe(subscriptions) {
      if (subscriptions.length === 0) return;
      await new Promise<void>((resolve, reject) => {
        const topicMap: Record<string, { qos: MqttQoS }> = {};
        for (const sub of subscriptions) {
          topicMap[sub.topic] = { qos: sub.qos };
        }
        client.subscribe(topicMap, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    async unsubscribe(topics) {
      if (topics.length === 0) return;
      await new Promise<void>((resolve, reject) => {
        client.unsubscribe([...topics], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    async publish(topic, payload, opts) {
      const publishOpts: IClientPublishOptions = {
        ...(opts?.qos !== undefined && { qos: opts.qos }),
        ...(opts?.retain !== undefined && { retain: opts.retain }),
      };
      if (opts?.userProperties !== undefined) {
        publishOpts.properties = { userProperties: opts.userProperties };
      }
      const body =
        typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
      await new Promise<void>((resolve, reject) => {
        client.publish(topic, body, publishOpts, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    isConnected() {
      return client.connected;
    },
  };
}

function extractUserProperties(packet: IPublishPacket): Record<string, string> {
  const out: Record<string, string> = {};
  const props = packet.properties?.userProperties;
  if (!props) return out;
  // MQTT.js types user-properties as `UserProperties`. At runtime it's
  // either `Record<string, string>` or `Record<string, string[]>` when a
  // key appears multiple times. Normalize both shapes to a single string
  // per key (join with comma — same convention as HTTP header collapsing).
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.join(',');
    }
  }
  return out;
}

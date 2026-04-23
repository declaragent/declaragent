/**
 * Unit tests for `createMqttTransport` (post-enterprise backlog #24c).
 *
 * Mirrors `amqp-transport.test.ts` / `nats-transport.test.ts`. A real
 * broker round-trip against Mosquitto would live in
 * `packages/plugin-agent-rpc/src/mqtt-transport.integration.test.ts`
 * gated behind `MQTT_INTEGRATION=1` (not shipped this sprint — unit
 * coverage only).
 *
 * Special note on MQTT semantics: MQTT 3 has no per-message ack the
 * handler can call. These tests verify the "log + continue" behaviour
 * documented in `mqtt-transport.ts`; they do NOT assert handler-level
 * redelivery because MQTT can't provide it.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import {
  type MqttClientLike,
  type MqttModule,
  type MqttQoS,
  createMqttTransport,
  matchTopic,
} from './mqtt-transport.js';

interface PublishedMsg {
  topic: string;
  payload: Uint8Array;
  qos: MqttQoS;
}

interface FakeMqttClient extends MqttClientLike {
  readonly published: PublishedMsg[];
  readonly subscribed: { topic: string; qos: MqttQoS }[];
  readonly unsubscribed: string[];
  ended: boolean;
  /** Simulate a broker-delivered message. */
  deliver(topic: string, payload: Uint8Array, qos?: MqttQoS): void;
}

interface FakeMqtt {
  module: MqttModule;
  client: FakeMqttClient;
  connectCalls: number;
}

function makeFakeMqtt(): FakeMqtt {
  const published: PublishedMsg[] = [];
  const subscribed: FakeMqttClient['subscribed'] = [];
  const unsubscribed: string[] = [];
  const listeners = new Set<
    (topic: string, payload: Uint8Array, packet: { qos?: MqttQoS }) => void
  >();
  let ended = false;

  const client: FakeMqttClient = {
    published,
    subscribed,
    unsubscribed,
    get ended() {
      return ended;
    },
    set ended(v) {
      ended = v;
    },
    async publish(topic, payload, opts) {
      const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
      published.push({ topic, payload: bytes, qos: opts.qos });
    },
    async subscribe(topic, opts) {
      subscribed.push({ topic, qos: opts.qos });
    },
    async unsubscribe(topic) {
      unsubscribed.push(topic);
    },
    on(event, handler) {
      if (event === 'message') listeners.add(handler);
    },
    off(event, handler) {
      if (event === 'message') listeners.delete(handler);
    },
    async end() {
      ended = true;
    },
    deliver(topic, payload, qos = 1) {
      for (const l of listeners) l(topic, payload, { qos });
    },
  };

  const state = { connectCalls: 0 };
  const module: MqttModule = {
    async connectAsync() {
      state.connectCalls += 1;
      return client;
    },
  };

  return {
    module,
    client,
    get connectCalls() {
      return state.connectCalls;
    },
  } as FakeMqtt;
}

const sampleEnvelope: AgentRpcEnvelope = {
  version: 1,
  kind: 'request',
  messageId: 'env-1',
  correlationId: 'corr-1',
  from: 'agent://alpha',
  to: 'agent://beta',
  capability: 'beta.ping',
  payload: { n: 1 },
};

function encode(env: AgentRpcEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env));
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('createMqttTransport', () => {
  test('kind is "mqtt"', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    expect(t.kind).toBe('mqtt');
    await t.close();
  });

  test('publish routes encoded envelope with default QoS 1', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    await t.publish('agents/beta/requests', sampleEnvelope);
    expect(fake.client.published).toHaveLength(1);
    const p = fake.client.published[0];
    expect(p?.topic).toBe('agents/beta/requests');
    expect(p?.qos).toBe(1);
    const decoded = JSON.parse(new TextDecoder().decode(p?.payload));
    expect(decoded).toMatchObject({ messageId: 'env-1', capability: 'beta.ping' });
    await t.close();
  });

  test('publish honors per-topic QoS override', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      defaultQoS: 1,
      topicQoS: { 'telemetry/fast': 0, 'critical/orders': 2 },
      mqttModule: fake.module,
    });
    await t.publish('telemetry/fast', sampleEnvelope);
    await t.publish('critical/orders', sampleEnvelope);
    await t.publish('other/topic', sampleEnvelope);
    expect(fake.client.published[0]?.qos).toBe(0);
    expect(fake.client.published[1]?.qos).toBe(2);
    expect(fake.client.published[2]?.qos).toBe(1);
    await t.close();
  });

  test('subscribe delivers envelopes and handler fires', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('agents/beta/requests', async (env) => {
      received.push(env);
    });
    await tick();
    expect(fake.client.subscribed).toEqual([{ topic: 'agents/beta/requests', qos: 1 }]);
    fake.client.deliver('agents/beta/requests', encode(sampleEnvelope));
    await tick();
    expect(received).toHaveLength(1);
    expect(received[0]?.messageId).toBe('env-1');
    await t.close();
  });

  test('MQTT wildcards: subscribing `agents/+/requests` receives concrete topics', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    const received: string[] = [];
    t.subscribe('agents/+/requests', async (env) => {
      received.push(env.to);
    });
    await tick();
    fake.client.deliver('agents/beta/requests', encode(sampleEnvelope));
    fake.client.deliver(
      'agents/gamma/requests',
      encode({ ...sampleEnvelope, to: 'agent://gamma' }),
    );
    fake.client.deliver(
      'agents/beta/responses',
      encode({ ...sampleEnvelope, to: 'agent://beta-resp' }),
    );
    await tick();
    expect(received.sort()).toEqual(['agent://beta', 'agent://gamma']);
    await t.close();
  });

  test('MQTT wildcard `#` matches the rest of a topic', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    const received: string[] = [];
    t.subscribe('agents/#', async (env) => {
      received.push(env.messageId);
    });
    await tick();
    fake.client.deliver('agents/beta/requests', encode(sampleEnvelope));
    fake.client.deliver('agents/gamma/deep/nested', encode({ ...sampleEnvelope, messageId: 'e2' }));
    fake.client.deliver('other/topic', encode({ ...sampleEnvelope, messageId: 'e3' }));
    await tick();
    expect(received.sort()).toEqual(['e2', 'env-1']);
    await t.close();
  });

  test('handler throw is logged but does NOT ack / nack (MQTT has no handler ack)', async () => {
    const fake = makeFakeMqtt();
    const warnings: unknown[] = [];
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
      logger: {
        debug() {},
        info() {},
        warn(_event: string, data: unknown) {
          warnings.push(data);
        },
        error() {},
        child: () => ({
          debug() {},
          info() {},
          warn() {},
          error() {},
          child: () => ({}) as never,
        }),
      } as never,
    });
    t.subscribe('agents/beta/requests', async () => {
      throw new Error('boom');
    });
    await tick();
    fake.client.deliver('agents/beta/requests', encode(sampleEnvelope));
    await tick();
    expect(warnings.length).toBeGreaterThan(0);
    // The subsequent message still delivers — broker-layer delivery is
    // already acked at the network level; handler throw is a local log.
    const received: string[] = [];
    t.subscribe('agents/beta/requests', async (env) => {
      received.push(env.messageId);
    });
    fake.client.deliver('agents/beta/requests', encode(sampleEnvelope));
    await tick();
    expect(received).toContain('env-1');
    await t.close();
  });

  test('malformed payload logs + dlqPublish is invoked when configured', async () => {
    const fake = makeFakeMqtt();
    const warns: unknown[] = [];
    const dlqCalls: { topic: string; bytes: Uint8Array }[] = [];
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
      dlqPublish(topic, bytes) {
        dlqCalls.push({ topic, bytes });
      },
      logger: {
        debug() {},
        info() {},
        warn(_event: string, data: unknown) {
          warns.push(data);
        },
        error() {},
        child: () => ({
          debug() {},
          info() {},
          warn() {},
          error() {},
          child: () => ({}) as never,
        }),
      } as never,
    });
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('agents/beta/requests', async (env) => {
      received.push(env);
    });
    await tick();
    fake.client.deliver('agents/beta/requests', new TextEncoder().encode('{not-json'));
    await tick();
    expect(received).toHaveLength(0);
    expect(warns.length).toBeGreaterThan(0);
    expect(dlqCalls).toHaveLength(1);
    expect(dlqCalls[0]?.topic).toBe('agents/beta/requests');
    await t.close();
  });

  test('multiple handlers on one topic all receive', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    const hits: number[] = [];
    t.subscribe('fanout', async () => {
      hits.push(1);
    });
    t.subscribe('fanout', async () => {
      hits.push(2);
    });
    await tick();
    // Only one subscribe call to the broker — fan-out is client-side.
    expect(fake.client.subscribed).toHaveLength(1);
    fake.client.deliver('fanout', encode(sampleEnvelope));
    await tick();
    expect(hits.sort()).toEqual([1, 2]);
    await t.close();
  });

  test('unsubscribe on last handler sends broker unsubscribe', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    const off = t.subscribe('agents/beta/requests', async () => {});
    await tick();
    off();
    await tick();
    expect(fake.client.unsubscribed).toContain('agents/beta/requests');
    await t.close();
  });

  test('shared-subscription group wraps subscribe topic with $share prefix', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      sharedSubscriptionGroup: 'worker-group',
      mqttModule: fake.module,
    });
    t.subscribe('agents/beta/requests', async () => {});
    await tick();
    expect(fake.client.subscribed[0]?.topic).toBe('$share/worker-group/agents/beta/requests');
    // Publish is NOT rewritten — only consumer side uses $share.
    await t.publish('agents/beta/requests', sampleEnvelope);
    expect(fake.client.published[0]?.topic).toBe('agents/beta/requests');
    await t.close();
  });

  test('close ends the client when not injected', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    await t.close();
    expect(fake.client.ended).toBe(true);
  });

  test('injected client is NOT ended on close (caller owns lifecycle)', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      client: fake.client,
    });
    await t.close();
    expect(fake.client.ended).toBe(false);
  });

  test('publish after close rejects', async () => {
    const fake = makeFakeMqtt();
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
    });
    await t.close();
    await expect(t.publish('topic', sampleEnvelope)).rejects.toThrow('closed');
  });

  test('subscribe after close is a no-op that logs a warning', async () => {
    const fake = makeFakeMqtt();
    const warns: unknown[] = [];
    const t = await createMqttTransport({
      brokerUrl: 'mqtt://localhost',
      mqttModule: fake.module,
      logger: {
        debug() {},
        info() {},
        warn(_event: string, data: unknown) {
          warns.push(data);
        },
        error() {},
        child: () => ({
          debug() {},
          info() {},
          warn() {},
          error() {},
          child: () => ({}) as never,
        }),
      } as never,
    });
    await t.close();
    const off = t.subscribe('topic', async () => {});
    off(); // should not throw
    expect(warns.some((w) => JSON.stringify(w).includes('topic'))).toBe(true);
  });
});

describe('matchTopic', () => {
  test('exact match', () => {
    expect(matchTopic('a/b/c', 'a/b/c')).toBe(true);
    expect(matchTopic('a/b/c', 'a/b/d')).toBe(false);
  });
  test('single-level +', () => {
    expect(matchTopic('a/+/c', 'a/b/c')).toBe(true);
    expect(matchTopic('a/+/c', 'a/b/c/d')).toBe(false);
    expect(matchTopic('a/+/c', 'a/c')).toBe(false);
  });
  test('multi-level #', () => {
    expect(matchTopic('a/#', 'a/b/c')).toBe(true);
    // Per MQTT 5 spec §4.7.1.2: `sport/#` also matches `sport` — `#`
    // matches zero or more levels.
    expect(matchTopic('a/#', 'a')).toBe(true);
    expect(matchTopic('a/#', 'b')).toBe(false);
    expect(matchTopic('#', 'literally/anything')).toBe(true);
  });
  test('case-sensitive', () => {
    expect(matchTopic('A/b', 'a/b')).toBe(false);
  });
});

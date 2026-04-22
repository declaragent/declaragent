/**
 * Unit tests for createNatsTransport (Item #2 of ENTERPRISE_PRODUCTION_PLAN).
 *
 * Mirrors `kafka-transport.test.ts` — we verify the wire protocol +
 * lifecycle against a mocked `nats` module. The ACTUAL broker
 * integration test lives in `packages/testkit/src/fleet-integration/`
 * and is gated behind `NATS_INTEGRATION=1` because it needs a live
 * nats-server.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import {
  type NatsConnectionLike,
  type NatsModule,
  type NatsSubscriptionLike,
  createNatsTransport,
} from './nats-transport.js';

interface PublishedMessage {
  subject: string;
  data: Uint8Array;
}

interface FakeSubscription extends NatsSubscriptionLike {
  subject: string;
  queue: string | undefined;
  callback: (err: Error | null, msg: { subject: string; data: Uint8Array }) => void;
  active: boolean;
}

interface FakeConnection extends NatsConnectionLike {
  published: PublishedMessage[];
  subs: FakeSubscription[];
  closed: boolean;
}

interface FakeNats {
  module: NatsModule;
  connection: FakeConnection;
  /** Deliver a raw envelope payload to every subscriber of the subject. */
  deliver: (subject: string, envelope: AgentRpcEnvelope) => Promise<void>;
}

async function flushMicrotasks(): Promise<void> {
  // nats callback -> handler is chained through a `Promise.resolve` to
  // avoid starving the client loop — yield a few cycles so the test
  // assertion runs after handler completion.
  await new Promise((r) => setTimeout(r, 20));
}

function makeFakeNats(): FakeNats {
  const published: PublishedMessage[] = [];
  const subs: FakeSubscription[] = [];
  let closed = false;

  const connection: FakeConnection = {
    published,
    subs,
    get closed() {
      return closed;
    },
    set closed(v) {
      closed = v;
    },
    publish(subject, data) {
      published.push({ subject, data });
    },
    subscribe(subject, opts) {
      const sub: FakeSubscription = {
        subject,
        queue: opts.queue,
        callback: opts.callback,
        active: true,
        unsubscribe() {
          this.active = false;
        },
      };
      subs.push(sub);
      return sub;
    },
    async flush() {
      // no-op; in real nats this awaits server ack.
    },
    async drain() {
      closed = true;
    },
    isClosed() {
      return closed;
    },
  };

  const module: NatsModule = {
    async connect() {
      return connection;
    },
  };

  return {
    module,
    connection,
    deliver: async (subject, envelope) => {
      const payload = new TextEncoder().encode(JSON.stringify(envelope));
      for (const s of subs) {
        if (s.subject === subject && s.active) {
          s.callback(null, { subject, data: payload });
        }
      }
    },
  };
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

describe('createNatsTransport', () => {
  test('publish encodes the envelope and routes it to the configured subject', async () => {
    const fake = makeFakeNats();
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
    });

    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.connection.published).toHaveLength(1);
    expect(fake.connection.published[0]?.subject).toBe('agents.beta.requests');
    const decoded = JSON.parse(
      new TextDecoder().decode(fake.connection.published[0]?.data ?? new Uint8Array()),
    );
    expect(decoded).toMatchObject({
      messageId: 'env-1',
      capability: 'beta.ping',
    });
    await t.close();
  });

  test('subscribe wires a subscription that delivers envelopes to the handler', async () => {
    const fake = makeFakeNats();
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
    });
    const received: AgentRpcEnvelope[] = [];
    const unsub = t.subscribe('agents.alpha.responses', async (env) => {
      received.push(env);
    });
    await fake.deliver('agents.alpha.responses', sampleEnvelope);
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    expect(received[0]?.messageId).toBe('env-1');
    unsub();
    await t.close();
  });

  test('unsubscribe stops the handler from receiving further messages', async () => {
    const fake = makeFakeNats();
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
    });
    const received: AgentRpcEnvelope[] = [];
    const unsub = t.subscribe('agents.beta.requests', async (env) => {
      received.push(env);
    });
    unsub();
    await fake.deliver('agents.beta.requests', sampleEnvelope);
    await flushMicrotasks();
    expect(received).toHaveLength(0);
    await t.close();
  });

  test('multiple handlers on the same subject all receive', async () => {
    const fake = makeFakeNats();
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
    });
    const hits: number[] = [];
    t.subscribe('fanout', async () => {
      hits.push(1);
    });
    t.subscribe('fanout', async () => {
      hits.push(2);
    });
    await fake.deliver('fanout', sampleEnvelope);
    await flushMicrotasks();
    expect(hits.sort()).toEqual([1, 2]);
    await t.close();
  });

  test('close unsubscribes every subscription and drains the connection', async () => {
    const fake = makeFakeNats();
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
    });
    t.subscribe('topic-a', async () => {});
    t.subscribe('topic-b', async () => {});
    expect(fake.connection.subs.filter((s) => s.active)).toHaveLength(2);
    await t.close();
    expect(fake.connection.subs.every((s) => !s.active)).toBe(true);
    expect(fake.connection.closed).toBe(true);
  });

  test('publish after close rejects', async () => {
    const fake = makeFakeNats();
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
    });
    await t.close();
    await expect(t.publish('topic', sampleEnvelope)).rejects.toThrow('closed');
  });

  test('empty servers array is rejected', async () => {
    const fake = makeFakeNats();
    await expect(
      createNatsTransport({
        servers: [],
        natsModule: fake.module,
      }),
    ).rejects.toThrow('servers');
  });

  test('malformed message payloads are logged + dropped without crashing the loop', async () => {
    const fake = makeFakeNats();
    const warnings: unknown[] = [];
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
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
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('agents.beta.requests', async (env) => {
      received.push(env);
    });

    // Deliver a payload that doesn't round-trip through parseEnvelope.
    fake.connection.subs[0]?.callback(null, {
      subject: 'agents.beta.requests',
      data: new TextEncoder().encode('{not-json'),
    });
    // Good envelope still delivers.
    await fake.deliver('agents.beta.requests', sampleEnvelope);
    await flushMicrotasks();

    expect(warnings.length).toBeGreaterThan(0);
    expect(received).toHaveLength(1);
    await t.close();
  });

  test('subjectPrefix namespaces both publish + subscribe subjects', async () => {
    const fake = makeFakeNats();
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
      subjectPrefix: 'tenant1',
    });
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('agents.beta.requests', async (env) => {
      received.push(env);
    });
    // Subscription should be attached to the prefixed subject.
    expect(fake.connection.subs[0]?.subject).toBe('tenant1.agents.beta.requests');

    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.connection.published[0]?.subject).toBe('tenant1.agents.beta.requests');

    // Deliver on the prefixed subject — handler should fire.
    await fake.deliver('tenant1.agents.beta.requests', sampleEnvelope);
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    await t.close();
  });

  test('queueGroup opts every subscription into the shared queue', async () => {
    const fake = makeFakeNats();
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
      queueGroup: 'beta-workers',
    });
    t.subscribe('agents.beta.requests', async () => {});
    expect(fake.connection.subs[0]?.queue).toBe('beta-workers');
    await t.close();
  });

  test('callback-level errors from nats are logged and do not crash the handler', async () => {
    const fake = makeFakeNats();
    const warnings: unknown[] = [];
    const t = await createNatsTransport({
      servers: ['nats://localhost:4222'],
      natsModule: fake.module,
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
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('errs', async (env) => {
      received.push(env);
    });
    fake.connection.subs[0]?.callback(new Error('stream closed'), {
      subject: 'errs',
      data: new Uint8Array(),
    });
    // A real message after an error still delivers.
    await fake.deliver('errs', sampleEnvelope);
    await flushMicrotasks();
    expect(warnings.length).toBeGreaterThan(0);
    expect(received).toHaveLength(1);
    await t.close();
  });
});

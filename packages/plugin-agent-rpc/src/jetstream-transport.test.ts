/**
 * Unit tests for createJetStreamTransport (post-enterprise backlog #23).
 *
 * Mirrors the shape of `nats-transport.test.ts` but swaps the core-NATS
 * fake for a JetStream fake — the fake owns a stream of messages and
 * lets tests drive publish / redelivery / ack directly. The live-broker
 * round-trip lives in `packages/testkit/src/fleet-integration/`, gated
 * behind `FLEET_INTEGRATION=1` + `NATS_INTEGRATION=1`.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import {
  type JetStreamClient,
  type JetStreamConnectionLike,
  type JetStreamConsumer,
  type JetStreamConsumerConfig,
  type JetStreamConsumerMessages,
  type JetStreamManager,
  type JetStreamMessageLike,
  type JetStreamNatsModule,
  type JetStreamPublishAck,
  buildDurableName,
  createJetStreamTransport,
} from './jetstream-transport.js';

interface FakeMessage extends JetStreamMessageLike {
  acks: number;
  naks: number;
  terms: number;
  workings: number;
}

interface FakeConsumeIter extends JetStreamConsumerMessages {
  push(msg: FakeMessage): void;
  stopped: boolean;
}

interface FakeNats {
  module: JetStreamNatsModule;
  published: { subject: string; data: Uint8Array }[];
  /** Upserted consumer configs captured so tests can assert the wire-ack + replay config. */
  consumerConfigs: { stream: string; config: JetStreamConsumerConfig }[];
  /** Map of consumerName → iterator so tests can inject messages. */
  iters: Map<string, FakeConsumeIter>;
  drained: boolean;
  /** Deliver a fresh JSON envelope to every consumer whose `filter_subject` matches. */
  deliver: (subject: string, envelope: AgentRpcEnvelope) => FakeMessage[];
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
}

function makeFakeNats(): FakeNats {
  const published: { subject: string; data: Uint8Array }[] = [];
  const consumerConfigs: { stream: string; config: JetStreamConsumerConfig }[] = [];
  const iters = new Map<string, FakeConsumeIter>();
  const consumerBySubject = new Map<string, string>(); // filter_subject → consumerName
  let drained = false;

  const jsm: JetStreamManager = {
    consumers: {
      async add(stream, config) {
        consumerConfigs.push({ stream, config });
        const name = config.durable_name ?? `ephemeral-${consumerConfigs.length}`;
        if (config.filter_subject !== undefined) {
          consumerBySubject.set(config.filter_subject, name);
        }
        return { name };
      },
    },
  };

  function makeIter(): FakeConsumeIter {
    const queue: FakeMessage[] = [];
    let resolveNext: ((v: IteratorResult<JetStreamMessageLike>) => void) | null = null;

    const iter: FakeConsumeIter = {
      stopped: false,
      push(msg) {
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: msg, done: false });
        } else {
          queue.push(msg);
        }
      },
      stop() {
        this.stopped = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: undefined, done: true });
        }
      },
      [Symbol.asyncIterator](): AsyncIterator<JetStreamMessageLike> {
        return {
          next: (): Promise<IteratorResult<JetStreamMessageLike>> => {
            if (iter.stopped) return Promise.resolve({ value: undefined, done: true });
            const head = queue.shift();
            if (head) return Promise.resolve({ value: head, done: false });
            return new Promise<IteratorResult<JetStreamMessageLike>>((resolve) => {
              resolveNext = resolve;
            });
          },
        };
      },
    };
    return iter;
  }

  const js: JetStreamClient = {
    async publish(subject, data): Promise<JetStreamPublishAck> {
      published.push({ subject, data });
      return { stream: 'fake-stream', seq: published.length };
    },
    consumers: {
      async get(_stream, name): Promise<JetStreamConsumer> {
        return {
          async consume() {
            let iter = iters.get(name);
            if (!iter) {
              iter = makeIter();
              iters.set(name, iter);
            }
            return iter;
          },
        };
      },
    },
  };

  const connection: JetStreamConnectionLike = {
    jetstream() {
      return js;
    },
    async jetstreamManager() {
      return jsm;
    },
    async drain() {
      drained = true;
      for (const it of iters.values()) it.stop();
    },
    isClosed() {
      return drained;
    },
  };

  const module: JetStreamNatsModule = {
    async connect() {
      return connection;
    },
  };

  function mkMessage(subject: string, envelope: AgentRpcEnvelope): FakeMessage {
    const data = new TextEncoder().encode(JSON.stringify(envelope));
    const self: FakeMessage = {
      subject,
      data,
      redeliveryCount: 1,
      acks: 0,
      naks: 0,
      terms: 0,
      workings: 0,
      ack() {
        self.acks += 1;
      },
      nak() {
        self.naks += 1;
      },
      term() {
        self.terms += 1;
      },
      working() {
        self.workings += 1;
      },
    };
    return self;
  }

  return {
    module,
    published,
    consumerConfigs,
    iters,
    get drained() {
      return drained;
    },
    deliver(subject, envelope) {
      const delivered: FakeMessage[] = [];
      for (const [filter, consumerName] of consumerBySubject.entries()) {
        if (filter === subject) {
          const iter = iters.get(consumerName);
          if (iter) {
            const msg = mkMessage(subject, envelope);
            iter.push(msg);
            delivered.push(msg);
          }
        }
      }
      return delivered;
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

describe('createJetStreamTransport', () => {
  test('kind is "nats" (JetStream is an overlay on the same wire protocol)', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      natsModule: fake.module,
    });
    expect(t.kind).toBe('nats');
    await t.close();
  });

  test('publish routes the encoded envelope via JetStream (server-acked)', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      natsModule: fake.module,
    });

    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.published).toHaveLength(1);
    expect(fake.published[0]?.subject).toBe('agents.beta.requests');
    const decoded = JSON.parse(
      new TextDecoder().decode(fake.published[0]?.data ?? new Uint8Array()),
    );
    expect(decoded).toMatchObject({ messageId: 'env-1', capability: 'beta.ping' });
    await t.close();
  });

  test('subscribe upserts a durable consumer with at-least-once config', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      ackWaitMs: 5_000,
      maxDeliver: 3,
      replay: 'instant',
      deliverPolicy: 'new',
      natsModule: fake.module,
    });
    t.subscribe('agents.beta.requests', async () => {});
    // Give the async start loop a tick to run.
    await flushMicrotasks();
    expect(fake.consumerConfigs).toHaveLength(1);
    const cfg = fake.consumerConfigs[0]?.config;
    expect(cfg?.ack_policy).toBe('explicit');
    expect(cfg?.filter_subject).toBe('agents.beta.requests');
    expect(cfg?.ack_wait).toBe(5_000 * 1_000_000); // ms → ns
    expect(cfg?.max_deliver).toBe(3);
    expect(cfg?.replay_policy).toBe('instant');
    expect(cfg?.deliver_policy).toBe('new');
    expect(cfg?.durable_name).toBe('alpha-worker-agents_beta_requests');
    await t.close();
  });

  test('subscribe delivers envelopes to the handler and acks on success', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      natsModule: fake.module,
    });
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('agents.beta.requests', async (env) => {
      received.push(env);
    });
    await flushMicrotasks();
    const [msg] = fake.deliver('agents.beta.requests', sampleEnvelope);
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    expect(received[0]?.messageId).toBe('env-1');
    expect(msg?.acks).toBe(1);
    expect(msg?.naks).toBe(0);
    await t.close();
  });

  test('handler throwing leaves the message un-acked (JetStream will redeliver)', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      natsModule: fake.module,
    });
    t.subscribe('agents.beta.requests', async () => {
      throw new Error('boom');
    });
    await flushMicrotasks();
    const [msg] = fake.deliver('agents.beta.requests', sampleEnvelope);
    await flushMicrotasks();
    expect(msg?.acks).toBe(0);
    expect(msg?.naks).toBe(1);
    await t.close();
  });

  test('malformed payloads are terminated so JetStream stops redelivering', async () => {
    const fake = makeFakeNats();
    const warnings: unknown[] = [];
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
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
    await flushMicrotasks();

    // Push a malformed message directly.
    const iter = Array.from(fake.iters.values())[0];
    expect(iter).toBeDefined();
    let badTerms = 0;
    iter?.push({
      subject: 'agents.beta.requests',
      data: new TextEncoder().encode('{not-json'),
      acks: 0,
      naks: 0,
      terms: 0,
      workings: 0,
      ack() {},
      nak() {},
      term() {
        badTerms += 1;
      },
      working() {},
    });
    // Follow with a good envelope so the loop stays alive.
    fake.deliver('agents.beta.requests', sampleEnvelope);
    await flushMicrotasks();

    expect(badTerms).toBe(1);
    expect(received).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
    await t.close();
  });

  test('close stops every consume loop and drains the connection', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      natsModule: fake.module,
    });
    t.subscribe('topic-a', async () => {});
    t.subscribe('topic-b', async () => {});
    await flushMicrotasks();
    expect(fake.iters.size).toBe(2);
    await t.close();
    for (const iter of fake.iters.values()) {
      expect(iter.stopped).toBe(true);
    }
    expect(fake.drained).toBe(true);
  });

  test('publish after close rejects', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      natsModule: fake.module,
    });
    await t.close();
    await expect(t.publish('topic', sampleEnvelope)).rejects.toThrow('closed');
  });

  test('empty servers[] / stream / durableName are rejected', async () => {
    const fake = makeFakeNats();
    await expect(
      createJetStreamTransport({
        servers: [],
        stream: 'RPC',
        durableName: 'w',
        natsModule: fake.module,
      }),
    ).rejects.toThrow('servers');
    await expect(
      createJetStreamTransport({
        servers: ['nats://x'],
        stream: '',
        durableName: 'w',
        natsModule: fake.module,
      }),
    ).rejects.toThrow('stream');
    await expect(
      createJetStreamTransport({
        servers: ['nats://x'],
        stream: 'RPC',
        durableName: '',
        natsModule: fake.module,
      }),
    ).rejects.toThrow('durableName');
  });

  test('subjectPrefix namespaces both publish + the consumer filter', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      subjectPrefix: 'tenant1',
      natsModule: fake.module,
    });
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('agents.beta.requests', async (env) => {
      received.push(env);
    });
    await flushMicrotasks();
    expect(fake.consumerConfigs[0]?.config.filter_subject).toBe('tenant1.agents.beta.requests');

    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.published[0]?.subject).toBe('tenant1.agents.beta.requests');

    fake.deliver('tenant1.agents.beta.requests', sampleEnvelope);
    await flushMicrotasks();
    expect(received).toHaveLength(1);
    await t.close();
  });

  test('replay="original" flows through to the JetStream consumer config', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      replay: 'original',
      deliverPolicy: 'all',
      natsModule: fake.module,
    });
    t.subscribe('topic', async () => {});
    await flushMicrotasks();
    expect(fake.consumerConfigs[0]?.config.replay_policy).toBe('original');
    expect(fake.consumerConfigs[0]?.config.deliver_policy).toBe('all');
    await t.close();
  });

  test('`already in use` upsert errors are swallowed (bind-to-existing)', async () => {
    const fake = makeFakeNats();
    // Shadow `add` to reject with the "already in use" signal.
    const origAdd = fake.module.connect;
    fake.module.connect = async (o) => {
      const conn = await origAdd(o);
      const jsm = await conn.jetstreamManager();
      const origConsumersAdd = jsm.consumers.add.bind(jsm.consumers);
      jsm.consumers.add = async (stream, cfg) => {
        // Capture the config still
        await origConsumersAdd(stream, cfg);
        throw new Error('consumer name already in use');
      };
      return conn;
    };

    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      natsModule: fake.module,
    });
    // Subscribing must not crash the consume loop even though `add` threw.
    t.subscribe('topic-x', async () => {});
    await flushMicrotasks();
    expect(fake.consumerConfigs).toHaveLength(1);
    await t.close();
  });

  test('unsubscribe stops the consume loop when the last handler leaves', async () => {
    const fake = makeFakeNats();
    const t = await createJetStreamTransport({
      servers: ['nats://localhost:4222'],
      stream: 'RPC',
      durableName: 'alpha-worker',
      natsModule: fake.module,
    });
    const unsub = t.subscribe('topic-x', async () => {});
    await flushMicrotasks();
    const iter = Array.from(fake.iters.values())[0];
    expect(iter?.stopped).toBe(false);
    unsub();
    expect(iter?.stopped).toBe(true);
    await t.close();
  });
});

describe('buildDurableName', () => {
  test('replaces dots and other subject chars with underscores', () => {
    expect(buildDurableName('worker', 'agents.beta.requests')).toBe('worker-agents_beta_requests');
  });

  test('preserves already-safe topics', () => {
    expect(buildDurableName('worker', 'alpha-1')).toBe('worker-alpha-1');
  });

  test('collapses unsafe runs into individual underscores (one per char)', () => {
    // One underscore per unsafe char keeps the mapping injective enough
    // for human inspection in dashboards.
    expect(buildDurableName('w', 'a.b*c')).toBe('w-a_b_c');
  });
});

/**
 * Unit tests for `createSqsTransport` (post-enterprise backlog #24a).
 *
 * Mirrors the shape of `jetstream-transport.test.ts` / `kafka-transport.test.ts`
 * but with a fake SQS client that owns in-memory queues + receipt-handle
 * bookkeeping. The live-broker round-trip against LocalStack lives in
 * `packages/plugin-agent-rpc/src/sqs-transport.integration.test.ts`,
 * gated behind `SQS_INTEGRATION=1` to match `@declaragent/source-sqs`.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import {
  type SqsClientLike,
  type SqsIncomingMessageLike,
  type SqsSendRequest,
  createSqsTransport,
  isFifoQueueUrl,
} from './sqs-transport.js';

interface FakeMessage extends SqsIncomingMessageLike {
  /** Mutable so tests can tweak. */
  body: string;
}

interface FakeSqsClient extends SqsClientLike {
  enqueue(queueUrl: string, body: string): string;
  readonly sent: SqsSendRequest[];
  readonly deleted: { queueUrl: string; receiptHandle: string }[];
  readonly receiveCalls: { queueUrl: string; maxMessages: number; waitTimeSeconds: number }[];
  receiveShouldFail: boolean;
  disconnected: boolean;
  waitFor(pred: () => boolean, timeoutMs?: number): Promise<void>;
}

function makeFakeClient(): FakeSqsClient {
  const queues = new Map<string, FakeMessage[]>();
  const sent: SqsSendRequest[] = [];
  const deleted: { queueUrl: string; receiptHandle: string }[] = [];
  const receiveCalls: FakeSqsClient['receiveCalls'] = [];
  const state = { receiveShouldFail: false, disconnected: false };
  let nextHandle = 0;

  const client: FakeSqsClient = {
    enqueue(queueUrl, body) {
      const handle = `rh-${++nextHandle}`;
      const msg: FakeMessage = {
        messageId: `mid-${nextHandle}`,
        receiptHandle: handle,
        body,
      };
      const q = queues.get(queueUrl);
      if (q) q.push(msg);
      else queues.set(queueUrl, [msg]);
      return handle;
    },
    sent,
    deleted,
    receiveCalls,
    get receiveShouldFail() {
      return state.receiveShouldFail;
    },
    set receiveShouldFail(v) {
      state.receiveShouldFail = v;
    },
    get disconnected() {
      return state.disconnected;
    },
    set disconnected(v) {
      state.disconnected = v;
    },
    async receiveMessage(req) {
      receiveCalls.push({
        queueUrl: req.queueUrl,
        maxMessages: req.maxMessages,
        waitTimeSeconds: req.waitTimeSeconds,
      });
      if (state.receiveShouldFail) throw new Error('receive-failed');
      const q = queues.get(req.queueUrl) ?? [];
      if (q.length === 0) {
        // Simulate long-poll: short pause so we don't hot-spin.
        await new Promise((r) => setTimeout(r, 5));
        return [];
      }
      const out = q.splice(0, req.maxMessages);
      return out;
    },
    async deleteMessage(queueUrl, receiptHandle) {
      deleted.push({ queueUrl, receiptHandle });
    },
    async sendMessage(req) {
      sent.push(req);
      // Auto-enqueue into the target queue when it's also a subscribe
      // target — lets tests cross-route like a real SQS would.
      const existing = queues.get(req.queueUrl);
      const handle = `rh-${++nextHandle}`;
      const msg: FakeMessage = {
        messageId: `mid-${nextHandle}`,
        receiptHandle: handle,
        body: req.body,
      };
      if (existing) existing.push(msg);
      else queues.set(req.queueUrl, [msg]);
      return { messageId: msg.messageId };
    },
    async disconnect() {
      state.disconnected = true;
    },
    async waitFor(pred, timeoutMs = 2_000) {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > timeoutMs) {
          throw new Error('waitFor: timed out');
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
  return client;
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

const QUEUE_STANDARD = 'https://sqs.us-east-1.amazonaws.com/000/requests';
const QUEUE_FIFO = 'https://sqs.us-east-1.amazonaws.com/000/requests.fifo';
const QUEUE_DLQ = 'https://sqs.us-east-1.amazonaws.com/000/dlq';

describe('createSqsTransport', () => {
  test('kind is "sqs"', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      sqsClient: fake,
    });
    expect(t.kind).toBe('sqs');
    await t.close();
  });

  test('publish routes encoded envelope to the queue URL', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      sqsClient: fake,
    });
    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.queueUrl).toBe(QUEUE_STANDARD);
    expect(fake.sent[0]?.messageGroupId).toBeUndefined();
    const decoded = JSON.parse(fake.sent[0]?.body ?? '{}');
    expect(decoded).toMatchObject({ messageId: 'env-1', capability: 'beta.ping' });
    await t.close();
  });

  test('publish to FIFO queue auto-derives messageGroupId from envelope.to', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_FIFO },
      sqsClient: fake,
    });
    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.sent[0]?.messageGroupId).toBe('agent://beta');
    await t.close();
  });

  test('explicit messageGroupId resolver wins on FIFO', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_FIFO },
      messageGroupId: (env) => `grp-${env.correlationId}`,
      sqsClient: fake,
    });
    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.sent[0]?.messageGroupId).toBe('grp-corr-1');
    await t.close();
  });

  test('messageDeduplicationId resolver applies to FIFO queues', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_FIFO },
      messageDeduplicationId: (env) => env.messageId,
      sqsClient: fake,
    });
    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.sent[0]?.messageDeduplicationId).toBe('env-1');
    await t.close();
  });

  test('subscribe delivers envelopes to handler and deletes on success', async () => {
    const fake = makeFakeClient();
    const received: AgentRpcEnvelope[] = [];
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      sqsClient: fake,
    });
    t.subscribe('agents.beta.requests', async (env) => {
      received.push(env);
    });
    fake.enqueue(QUEUE_STANDARD, JSON.stringify(sampleEnvelope));
    await fake.waitFor(() => received.length >= 1);
    await fake.waitFor(() => fake.deleted.length >= 1);
    expect(received[0]?.messageId).toBe('env-1');
    expect(fake.deleted[0]?.queueUrl).toBe(QUEUE_STANDARD);
    await t.close();
  });

  test('handler throwing leaves the message undeleted (SQS redrives natively)', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      sqsClient: fake,
    });
    let calls = 0;
    t.subscribe('agents.beta.requests', async () => {
      calls += 1;
      throw new Error('boom');
    });
    fake.enqueue(QUEUE_STANDARD, JSON.stringify(sampleEnvelope));
    await fake.waitFor(() => calls >= 1);
    // Wait a few polls so we can assert "delete was never called".
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.deleted).toHaveLength(0);
    await t.close();
  });

  test('malformed body triggers default "delete" decode-fail policy', async () => {
    const fake = makeFakeClient();
    const warnings: unknown[] = [];
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      sqsClient: fake,
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
    let received = 0;
    t.subscribe('agents.beta.requests', async () => {
      received += 1;
    });
    const badHandle = fake.enqueue(QUEUE_STANDARD, '{not-json');
    await fake.waitFor(() => fake.deleted.some((d) => d.receiptHandle === badHandle), 2_000);
    expect(received).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    await t.close();
  });

  test('decodeFail="leave" does NOT delete malformed messages', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      decodeFail: 'leave',
      sqsClient: fake,
    });
    t.subscribe('agents.beta.requests', async () => {});
    fake.enqueue(QUEUE_STANDARD, '{not-json');
    // Give the loop time to process the bad message.
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.deleted).toHaveLength(0);
    await t.close();
  });

  test('decodeFail="send-dlq" forwards to the DLQ queue + deletes from main', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      decodeFail: 'send-dlq',
      dlqQueueUrl: QUEUE_DLQ,
      sqsClient: fake,
    });
    t.subscribe('agents.beta.requests', async () => {});
    const badHandle = fake.enqueue(QUEUE_STANDARD, '{not-json');
    await fake.waitFor(() => fake.sent.some((s) => s.queueUrl === QUEUE_DLQ));
    await fake.waitFor(() => fake.deleted.some((d) => d.receiptHandle === badHandle));
    expect(fake.sent.find((s) => s.queueUrl === QUEUE_DLQ)?.body).toBe('{not-json');
    await t.close();
  });

  test('decodeFail="send-dlq" without dlqQueueUrl is rejected at construction', async () => {
    const fake = makeFakeClient();
    await expect(
      createSqsTransport({
        queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
        decodeFail: 'send-dlq',
        sqsClient: fake,
      }),
    ).rejects.toThrow('dlqQueueUrl');
  });

  test('neither queueUrls nor queueUrlFor is rejected at construction', async () => {
    const fake = makeFakeClient();
    await expect(createSqsTransport({ sqsClient: fake })).rejects.toThrow('queueUrls');
  });

  test('queueUrlFor resolver wins over queueUrls map', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': 'should-be-ignored' },
      queueUrlFor: () => QUEUE_STANDARD,
      sqsClient: fake,
    });
    await t.publish('agents.beta.requests', sampleEnvelope);
    expect(fake.sent[0]?.queueUrl).toBe(QUEUE_STANDARD);
    await t.close();
  });

  test('publish after close rejects', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      sqsClient: fake,
    });
    await t.close();
    await expect(t.publish('agents.beta.requests', sampleEnvelope)).rejects.toThrow('closed');
  });

  test('unknown topic on publish throws a clear error', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'agents.beta.requests': QUEUE_STANDARD },
      sqsClient: fake,
    });
    await expect(t.publish('missing.topic', sampleEnvelope)).rejects.toThrow(/no queueUrl mapped/);
    await t.close();
  });

  test('close stops poll loops and disconnects the client', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'topic-a': QUEUE_STANDARD },
      sqsClient: fake,
    });
    t.subscribe('topic-a', async () => {});
    // Give the loop a chance to enter its first receive.
    await fake.waitFor(() => fake.receiveCalls.length > 0);
    await t.close();
    expect(fake.disconnected).toBe(true);
    const callsAtClose = fake.receiveCalls.length;
    await new Promise((r) => setTimeout(r, 50));
    // No additional poll calls after close.
    expect(fake.receiveCalls.length).toBe(callsAtClose);
  });

  test('unsubscribe stops the per-topic poll loop when last handler leaves', async () => {
    const fake = makeFakeClient();
    const t = await createSqsTransport({
      queueUrls: { 'topic-a': QUEUE_STANDARD },
      sqsClient: fake,
    });
    const off = t.subscribe('topic-a', async () => {});
    await fake.waitFor(() => fake.receiveCalls.length > 0);
    off();
    const at = fake.receiveCalls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.receiveCalls.length).toBeLessThanOrEqual(at + 1);
  });

  test('transient receiveMessage failure is logged + retried (not fatal)', async () => {
    const fake = makeFakeClient();
    const warns: unknown[] = [];
    fake.receiveShouldFail = true;
    const t = await createSqsTransport({
      queueUrls: { 'topic-a': QUEUE_STANDARD },
      sqsClient: fake,
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
    t.subscribe('topic-a', async (env) => {
      received.push(env);
    });
    await fake.waitFor(() => warns.length > 0);
    fake.receiveShouldFail = false;
    fake.enqueue(QUEUE_STANDARD, JSON.stringify(sampleEnvelope));
    await fake.waitFor(() => received.length >= 1, 5_000);
    await t.close();
  });

  test('missing region is required when no injected client', async () => {
    await expect(
      createSqsTransport({
        queueUrls: { 'topic-a': QUEUE_STANDARD },
      }),
    ).rejects.toThrow(/region/);
  });

  test('sqsClientFactory is used when no sqsClient injected', async () => {
    const fake = makeFakeClient();
    let factoryCalls = 0;
    const t = await createSqsTransport({
      region: 'us-east-1',
      queueUrls: { 'topic-a': QUEUE_STANDARD },
      sqsClientFactory: {
        create() {
          factoryCalls += 1;
          return fake;
        },
      },
    });
    expect(factoryCalls).toBe(1);
    await t.publish('topic-a', sampleEnvelope);
    expect(fake.sent).toHaveLength(1);
    await t.close();
  });
});

describe('isFifoQueueUrl', () => {
  test('detects .fifo suffix', () => {
    expect(isFifoQueueUrl('https://sqs.us-east-1.amazonaws.com/0/q.fifo')).toBe(true);
    expect(isFifoQueueUrl('https://sqs.us-east-1.amazonaws.com/0/q')).toBe(false);
  });
});

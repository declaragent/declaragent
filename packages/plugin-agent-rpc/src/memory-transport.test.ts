import { describe, expect, test } from 'bun:test';
import type { AgentRpcEnvelope } from '@declaragent/core';
import { createMemoryBus, createMemoryTransport } from './memory-transport.js';

function envelope(overrides: Partial<AgentRpcEnvelope> = {}): AgentRpcEnvelope {
  return {
    version: 1,
    kind: 'request',
    messageId: 'm1',
    correlationId: 'c1',
    from: 'agent://a',
    to: 'agent://b',
    capability: 'test',
    payload: {},
    ...overrides,
  } as AgentRpcEnvelope;
}

describe('createMemoryTransport', () => {
  test('publishes to subscribers on the same topic', async () => {
    const t = createMemoryTransport();
    const received: AgentRpcEnvelope[] = [];
    t.subscribe('agents.b.requests', (e) => {
      received.push(e);
    });
    await t.publish('agents.b.requests', envelope());
    expect(received).toHaveLength(1);
    expect(received[0]?.correlationId).toBe('c1');
  });

  test('does not deliver to subscribers of other topics', async () => {
    const t = createMemoryTransport();
    let called = false;
    t.subscribe('agents.other.requests', () => {
      called = true;
    });
    await t.publish('agents.b.requests', envelope());
    expect(called).toBe(false);
  });

  test('unsubscribe stops delivery', async () => {
    const t = createMemoryTransport();
    let count = 0;
    const unsub = t.subscribe('t1', () => {
      count += 1;
    });
    await t.publish('t1', envelope());
    unsub();
    await t.publish('t1', envelope());
    expect(count).toBe(1);
  });

  test('shared bus threads two transports together', async () => {
    const bus = createMemoryBus();
    const producer = createMemoryTransport({ bus });
    const consumer = createMemoryTransport({ bus });
    const received: string[] = [];
    consumer.subscribe('topic', (e) => {
      received.push(e.correlationId);
    });
    await producer.publish('topic', envelope({ correlationId: 'x' }));
    expect(received).toEqual(['x']);
  });

  test('subscriberCount reflects registrations', () => {
    const t = createMemoryTransport();
    expect(t.subscriberCount('topic')).toBe(0);
    const unsub = t.subscribe('topic', () => {});
    expect(t.subscriberCount('topic')).toBe(1);
    unsub();
    expect(t.subscriberCount('topic')).toBe(0);
  });

  test('handler exceptions surface to publisher', async () => {
    const t = createMemoryTransport();
    t.subscribe('topic', () => {
      throw new Error('boom');
    });
    await expect(t.publish('topic', envelope())).rejects.toThrow(/boom/);
  });
});

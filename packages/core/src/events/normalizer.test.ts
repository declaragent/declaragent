import { describe, expect, test } from 'bun:test';
import { NormalizeError, createMessageNormalizer } from './normalizer.js';
import type { NormalizeContext, RawMessage, RoutingConfig } from './types.js';

const CTX: NormalizeContext = {
  source: { type: 'self', reason: 'wakeup' },
  auth: { kind: 'internal' },
};

// Kafka-shape RawMessage.
function kafkaRaw(body: unknown, extras: Partial<RawMessage> = {}): RawMessage {
  return {
    value: JSON.stringify(body),
    topic: 'orders.placed',
    partition: 3,
    offset: '12345',
    timestamp: Date.parse('2026-04-16T10:00:00Z'),
    headers: { 'x-correlation-id': 'run-abc' },
    ...extras,
  };
}

// SQS-shape RawMessage.
function sqsRaw(body: unknown): RawMessage {
  return {
    value: JSON.stringify(body),
    meta: { messageId: 'sqs-1234-uuid' },
    timestamp: Date.now(),
  };
}

// MQTT-shape RawMessage.
function mqttRaw(body: unknown): RawMessage {
  return {
    value: JSON.stringify(body),
    topic: 'sensors/device-42/temperature',
    timestamp: Date.now(),
  };
}

describe('createMessageNormalizer — routing', () => {
  test('broadcast target + kind via JSONPath', async () => {
    const n = createMessageNormalizer();
    const routing: RoutingConfig = {
      format: 'json',
      kindSelector: '$.event_type',
      targetSelector: { type: 'broadcast' },
    };
    const event = await n.normalize(
      kafkaRaw({ event_type: 'trigger.fire', payload: 1 }),
      routing,
      CTX,
    );
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('trigger.fire');
    expect(event?.target).toEqual({ type: 'broadcast' });
    expect(event?.source).toEqual(CTX.source);
  });

  test('const kind selector', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      kafkaRaw({ anything: true }),
      {
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(event?.kind).toBe('trigger.fire');
  });

  test('session target resolves sessionIdFrom', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      mqttRaw({ device_id: 'dev-042', temp: 85 }),
      {
        kindSelector: { const: 'file.changed' },
        targetSelector: {
          type: 'session',
          sessionIdFrom: '$.device_id',
          action: 'inject',
        },
      },
      CTX,
    );
    expect(event?.target).toEqual({
      type: 'session',
      sessionId: 'dev-042',
      mode: 'inject',
    });
  });

  test('skill target threads JSONPath inputs', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      kafkaRaw({
        order_id: 'ord-7',
        customer: { id: 'cust-1' },
        const_value: 'x',
      }),
      {
        kindSelector: { const: 'trigger.fire' },
        targetSelector: {
          type: 'skill',
          name: 'order-workflow',
          inputs: {
            order_id: '$.order_id',
            customer_id: '$.customer.id',
            literal: 'always-this',
          },
        },
      },
      CTX,
    );
    expect(event?.target).toEqual({
      type: 'skill',
      name: 'order-workflow',
      inputs: {
        order_id: 'ord-7',
        customer_id: 'cust-1',
        literal: 'always-this',
      },
    });
  });

  test('new-session target extracts initial prompt', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      sqsRaw({ type: 'ticket.opened', prompt: 'Triage this incident.' }),
      {
        kindSelector: '$.type',
        targetSelector: {
          type: 'new-session',
          initialPromptFrom: '$.prompt',
        },
      },
      CTX,
    );
    expect(event?.target).toEqual({
      type: 'new-session',
      initialPrompt: 'Triage this incident.',
    });
  });

  test('sub-agent target reads parent session id', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      kafkaRaw({ parent_session: 'sess-42', op: 'investigate' }),
      {
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'sub-agent', parentSessionIdFrom: '$.parent_session' },
      },
      CTX,
    );
    expect(event?.target).toEqual({
      type: 'sub-agent',
      parentSessionId: 'sess-42',
      spec: {},
    });
  });
});

describe('createMessageNormalizer — filter', () => {
  test('filter drops a message → null', async () => {
    const n = createMessageNormalizer();
    const result = await n.normalize(
      mqttRaw({ temperature: 70 }),
      {
        filter: { expr: '$.temperature > 80' },
        kindSelector: { const: 'file.changed' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(result).toBeNull();
  });

  test('filter keeps a message → event', async () => {
    const n = createMessageNormalizer();
    const result = await n.normalize(
      mqttRaw({ temperature: 85 }),
      {
        filter: { expr: '$.temperature > 80' },
        kindSelector: { const: 'file.changed' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(result).not.toBeNull();
  });

  test('filter syntax error throws NormalizeError', async () => {
    const n = createMessageNormalizer();
    await expect(
      n.normalize(
        mqttRaw({}),
        {
          filter: { expr: '$.x ==' },
          kindSelector: { const: 'file.changed' },
          targetSelector: { type: 'broadcast' },
        },
        CTX,
      ),
    ).rejects.toThrow(NormalizeError);
  });
});

describe('createMessageNormalizer — transform', () => {
  test('transform extracts subtree into payload', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      kafkaRaw({
        envelope: { meta: { at: 1 }, body: { order_id: 'x', amount: 42 } },
      }),
      {
        transform: { expr: '$.envelope.body' },
        kindSelector: { const: 'trigger.fire' },
        targetSelector: {
          type: 'skill',
          name: 'triage',
          inputs: { order_id: '$.order_id' },
        },
      },
      CTX,
    );
    expect(event?.payload).toEqual({ order_id: 'x', amount: 42 });
    // inputs resolve against the transformed body, not the original.
    expect(event?.target).toEqual({
      type: 'skill',
      name: 'triage',
      inputs: { order_id: 'x' },
    });
  });
});

describe('createMessageNormalizer — decoders', () => {
  test('plain decoder wraps raw text', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      { value: 'hello world' },
      {
        format: 'plain',
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(event?.payload).toEqual({ text: 'hello world' });
  });

  test('invalid JSON → NormalizeError', async () => {
    const n = createMessageNormalizer();
    await expect(
      n.normalize(
        { value: '{bogus}' },
        { kindSelector: { const: 'trigger.fire' }, targetSelector: { type: 'broadcast' } },
        CTX,
      ),
    ).rejects.toThrow(/invalid JSON/);
  });

  test('avro without routing.schemaRegistry throws with clear hint', async () => {
    const n = createMessageNormalizer();
    await expect(
      n.normalize(
        { value: 'bytes' },
        {
          format: 'avro',
          kindSelector: { const: 'trigger.fire' },
          targetSelector: { type: 'broadcast' },
        },
        CTX,
      ),
    ).rejects.toThrow(/schemaRegistry\.url/);
  });
});

describe('createMessageNormalizer — idempotency', () => {
  test('default strategy derives Kafka-style key (topic:partition:offset)', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      kafkaRaw({ e: 1 }),
      {
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(event?.meta?.idempotencyKey).toBe('orders.placed:3:12345');
  });

  test('default strategy falls back to SQS MessageId when no topic/partition/offset', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      sqsRaw({ type: 'x' }),
      { kindSelector: '$.type', targetSelector: { type: 'broadcast' } },
      CTX,
    );
    expect(event?.meta?.idempotencyKey).toBe('sqs-1234-uuid');
  });

  test('content-hash strategy is deterministic and non-empty', async () => {
    const n = createMessageNormalizer();
    const raw = kafkaRaw({ hello: 'world' });
    const a = await n.normalize(
      raw,
      {
        idempotencyKeyFrom: 'content-hash',
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    const b = await n.normalize(
      raw,
      {
        idempotencyKeyFrom: 'content-hash',
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(a?.meta?.idempotencyKey).toBe(b?.meta?.idempotencyKey);
    expect((a?.meta?.idempotencyKey ?? '').length).toBeGreaterThan(0);
  });

  test('JSONPath strategy pulls from the body', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      kafkaRaw({ event_id: 'evt-999', type: 'x' }),
      {
        idempotencyKeyFrom: '$.event_id',
        kindSelector: '$.type',
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(event?.meta?.idempotencyKey).toBe('evt-999');
  });

  test('JSONPath strategy missing field → no idempotencyKey', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      { value: JSON.stringify({ type: 'x' }) },
      {
        idempotencyKeyFrom: '$.nope',
        kindSelector: '$.type',
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(event?.meta?.idempotencyKey).toBeUndefined();
  });

  test('header x-event-id overrides event.id', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      kafkaRaw({ type: 'x' }, { headers: { 'x-event-id': 'preset-id-123' } }),
      { kindSelector: '$.type', targetSelector: { type: 'broadcast' } },
      CTX,
    );
    expect(event?.id).toBe('preset-id-123');
  });
});

describe('createMessageNormalizer — correlation id', () => {
  test('correlationIdFrom extracts to meta', async () => {
    const n = createMessageNormalizer();
    const event = await n.normalize(
      kafkaRaw({ correlation_id: 'run-42', type: 'x' }),
      {
        correlationIdFrom: '$.correlation_id',
        kindSelector: '$.type',
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(event?.meta?.correlationId).toBe('run-42');
  });
});

describe('createMessageNormalizer — errors', () => {
  test('unknown kindSelector JSONPath yields a clear error', async () => {
    const n = createMessageNormalizer();
    await expect(
      n.normalize(
        kafkaRaw({ no_type_field: true }),
        {
          kindSelector: '$.missing',
          targetSelector: { type: 'broadcast' },
        },
        CTX,
      ),
    ).rejects.toThrow(/did not resolve/);
  });

  test('session target missing sessionIdFrom path throws', async () => {
    const n = createMessageNormalizer();
    await expect(
      n.normalize(
        kafkaRaw({ x: 1 }),
        {
          kindSelector: { const: 'trigger.fire' },
          targetSelector: {
            type: 'session',
            sessionIdFrom: '$.missing',
            action: 'inject',
          },
        },
        CTX,
      ),
    ).rejects.toThrow(/sessionIdFrom/);
  });
});

// ─── Binary format paths (avro / protobuf / msgpack) ────────────────────

describe('createMessageNormalizer — binary formats', () => {
  const AVRO_SCHEMA = JSON.stringify({
    type: 'record',
    name: 'Order',
    fields: [
      { name: 'event_type', type: 'string' },
      { name: 'order_id', type: 'string' },
    ],
  });

  // Helper: a stubbed schema-registry factory that always returns AVRO_SCHEMA
  // for id 42, and whatever's asked for subjects.
  function stubRegistry() {
    return {
      createRegistry: () => ({
        async getById(id: number) {
          if (id === 42) return { id, schema: AVRO_SCHEMA, schemaType: 'AVRO' };
          throw new Error(`unknown schema id ${id}`);
        },
        async getLatestForSubject() {
          return { id: 42, schema: AVRO_SCHEMA };
        },
      }),
    };
  }

  // A stubbed `peerLoader` that returns a tiny avsc / protobufjs / msgpackr.
  function stubPeers() {
    return async (name: string): Promise<unknown> => {
      if (name === 'avsc') {
        return {
          Type: {
            forSchema(schemaObj: unknown) {
              return {
                fromBuffer(buf: Uint8Array) {
                  // Fake decoder: pretend the first two bytes are an ASCII pair
                  // of lengths and decode the rest as two strings.
                  const len1 = buf[0] ?? 0;
                  const len2 = buf[1] ?? 0;
                  const a = new TextDecoder().decode(buf.subarray(2, 2 + len1));
                  const b = new TextDecoder().decode(buf.subarray(2 + len1, 2 + len1 + len2));
                  return { event_type: a, order_id: b, __schema: schemaObj };
                },
              };
            },
          },
        };
      }
      if (name === 'protobufjs') {
        return {
          parse() {
            return {
              root: {
                lookupType() {
                  return {
                    decode(buf: Uint8Array) {
                      return { __pb: true, size: buf.length };
                    },
                    toObject(m: unknown) {
                      return m;
                    },
                  };
                },
              },
            };
          },
        };
      }
      if (name === 'msgpackr') {
        return {
          unpack(buf: Uint8Array) {
            return { __msgpack: true, size: buf.length };
          },
        };
      }
      throw new Error(`unexpected peer dep: ${name}`);
    };
  }

  test('avro: parses wire format, looks up schema, decodes', async () => {
    const n = createMessageNormalizer({
      ...stubRegistry(),
      peerLoader: stubPeers(),
    });

    // Build a fake Confluent-wire-format message:
    //   [0x00, schemaId=42 big-endian, len('order.placed')=12, len('ord-7')=5, "order.placed", "ord-7"]
    const prefix = new Uint8Array([0x00, 0x00, 0x00, 0x00, 42]);
    const body = new Uint8Array([
      12,
      5,
      ...new TextEncoder().encode('order.placed'),
      ...new TextEncoder().encode('ord-7'),
    ]);
    const value = new Uint8Array(prefix.length + body.length);
    value.set(prefix, 0);
    value.set(body, prefix.length);

    const event = await n.normalize(
      { value, topic: 'orders', partition: 0, offset: '100' },
      {
        format: 'avro',
        schemaRegistry: { url: 'https://registry.example', subject: 'orders-value' },
        kindSelector: '$.event_type',
        targetSelector: {
          type: 'skill',
          name: 'order-workflow',
          inputs: { order_id: '$.order_id' },
        },
      },
      CTX,
    );
    // `order.placed` isn't in the EventKind union; the normalizer's return
    // type reflects that via a cast. Assert as a string.
    expect(String(event?.kind)).toBe('order.placed');
    expect(event?.target).toEqual({
      type: 'skill',
      name: 'order-workflow',
      inputs: { order_id: 'ord-7' },
    });
  });

  test('avro without routing.schemaRegistry throws', async () => {
    const n = createMessageNormalizer({ ...stubRegistry(), peerLoader: stubPeers() });
    await expect(
      n.normalize(
        { value: new Uint8Array([0x00, 0x00, 0x00, 0x00, 42, 1]) },
        {
          format: 'avro',
          kindSelector: { const: 'trigger.fire' },
          targetSelector: { type: 'broadcast' },
        },
        CTX,
      ),
    ).rejects.toThrow(/schemaRegistry\.url/);
  });

  test('missing avsc peer surfaces as npm install hint', async () => {
    const n = createMessageNormalizer({
      ...stubRegistry(),
      peerLoader: async (name) => {
        if (name === 'avsc') throw new Error('Cannot find module');
        return {};
      },
    });
    const value = new Uint8Array([0x00, 0x00, 0x00, 0x00, 42, 1, 2]);
    await expect(
      n.normalize(
        { value },
        {
          format: 'avro',
          schemaRegistry: { url: 'https://registry.example', subject: 's' },
          kindSelector: { const: 'trigger.fire' },
          targetSelector: { type: 'broadcast' },
        },
        CTX,
      ),
    ).rejects.toThrow(/npm install avsc/);
  });

  test('msgpack decodes without a schema registry', async () => {
    const n = createMessageNormalizer({ peerLoader: stubPeers() });
    const event = await n.normalize(
      { value: new Uint8Array([1, 2, 3, 4]) },
      {
        format: 'msgpack',
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(event?.payload).toEqual({ __msgpack: true, size: 4 });
  });

  test('protobuf: registry lookup + stubbed decoder', async () => {
    const n = createMessageNormalizer({
      createRegistry: () => ({
        async getById() {
          return { id: 1, schema: 'message Foo { string id = 1; }', schemaType: 'PROTOBUF' };
        },
        async getLatestForSubject() {
          return { id: 1, schema: 'message Foo { string id = 1; }' };
        },
      }),
      peerLoader: stubPeers(),
    });
    // [0x00, 0x00, 0x00, 0x00, 0x01, payload...]
    const event = await n.normalize(
      { value: new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x01, 10, 20, 30]) },
      {
        format: 'protobuf',
        schemaRegistry: { url: 'https://registry.example', subject: 'foo' },
        kindSelector: { const: 'trigger.fire' },
        targetSelector: { type: 'broadcast' },
      },
      CTX,
    );
    expect(event?.payload).toEqual({ __pb: true, size: 3 });
  });

  test('schema registry client is cached across calls with the same URL', async () => {
    let createCount = 0;
    const n = createMessageNormalizer({
      createRegistry: () => {
        createCount += 1;
        return {
          async getById() {
            return { id: 42, schema: AVRO_SCHEMA };
          },
          async getLatestForSubject() {
            return { id: 42, schema: AVRO_SCHEMA };
          },
        };
      },
      peerLoader: stubPeers(),
    });
    const prefix = new Uint8Array([0x00, 0x00, 0x00, 0x00, 42]);
    const body = new Uint8Array([
      5,
      3,
      ...new TextEncoder().encode('x.y'),
      ...new TextEncoder().encode('aaa'),
    ]);
    const value = new Uint8Array([...prefix, ...body]);
    const routing: RoutingConfig = {
      format: 'avro',
      schemaRegistry: { url: 'https://registry.example', subject: 'orders-value' },
      kindSelector: '$.event_type',
      targetSelector: { type: 'broadcast' },
    };
    await n.normalize({ value }, routing, CTX);
    await n.normalize({ value }, routing, CTX);
    expect(createCount).toBe(1);
  });
});

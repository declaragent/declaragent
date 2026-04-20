import { describe, expect, test } from 'bun:test';
import {
  CONFLUENT_MAGIC_BYTE,
  SchemaRegistryError,
  asBytes,
  createSchemaRegistry,
  decodeAvro,
  decodeMsgpack,
  decodeProtobuf,
  parseConfluentWireFormat,
} from './schema-registry.js';

// ─── Wire format ────────────────────────────────────────────────────────

describe('parseConfluentWireFormat', () => {
  test('splits prefix from payload', () => {
    // [0x00, 0x00, 0x00, 0x01, 0x23, ...payload]
    const bytes = new Uint8Array([CONFLUENT_MAGIC_BYTE, 0x00, 0x00, 0x01, 0x23, 0xaa, 0xbb]);
    const { schemaId, payload } = parseConfluentWireFormat(bytes);
    expect(schemaId).toBe(0x0123);
    expect(Array.from(payload)).toEqual([0xaa, 0xbb]);
  });

  test('big-endian schema id', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0xff, 0xff, 0xff, 0x01]);
    const { schemaId } = parseConfluentWireFormat(bytes);
    expect(schemaId).toBe(0xffffffff);
  });

  test('too-short buffer throws', () => {
    expect(() => parseConfluentWireFormat(new Uint8Array([0x00, 0x01, 0x02]))).toThrow(/too short/);
  });

  test('wrong magic byte throws', () => {
    expect(() => parseConfluentWireFormat(new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x01]))).toThrow(
      /magic byte/,
    );
  });
});

describe('asBytes', () => {
  test('passes through Uint8Array', () => {
    const b = new Uint8Array([1, 2, 3]);
    expect(asBytes(b)).toBe(b);
  });
  test('encodes strings as UTF-8', () => {
    expect(Array.from(asBytes('abc'))).toEqual([97, 98, 99]);
  });
});

// ─── HTTP client (mocked fetch) ─────────────────────────────────────────

function mockFetch(responses: Record<string, { status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers ?? {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const pair of rawHeaders) {
        const key = pair[0];
        const value = pair[1];
        if (typeof key === 'string' && typeof value === 'string') {
          headers[key.toLowerCase()] = value;
        }
      }
    } else {
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    calls.push({ url, headers });

    // Find the matching route by pathname.
    const pathname = new URL(url).pathname;
    const response = responses[pathname];
    if (!response) {
      return new Response('not found', { status: 404 });
    }
    if (response.status >= 400) {
      return new Response(JSON.stringify(response.body), { status: response.status });
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('createSchemaRegistry', () => {
  const AVRO_SCHEMA = JSON.stringify({
    type: 'record',
    name: 'Order',
    fields: [{ name: 'id', type: 'string' }],
  });

  test('getById returns the record and caches', async () => {
    const { fetch: f, calls } = mockFetch({
      '/schemas/ids/42': {
        status: 200,
        body: { schema: AVRO_SCHEMA, schemaType: 'AVRO' },
      },
    });
    const client = createSchemaRegistry({ url: 'https://registry.example', fetch: f });
    const a = await client.getById(42);
    const b = await client.getById(42);
    expect(a).toBe(b);
    expect(a.id).toBe(42);
    expect(a.schemaType).toBe('AVRO');
    expect(calls).toHaveLength(1); // cache hit on second call
  });

  test('getLatestForSubject warms the id cache', async () => {
    const { fetch: f, calls } = mockFetch({
      '/subjects/orders-value/versions/latest': {
        status: 200,
        body: { id: 7, schema: AVRO_SCHEMA, subject: 'orders-value', version: 3 },
      },
    });
    const client = createSchemaRegistry({ url: 'https://registry.example', fetch: f });
    const latest = await client.getLatestForSubject('orders-value');
    expect(latest.id).toBe(7);
    expect(latest.version).toBe(3);

    // getById(7) should NOT make a new request — warmed from the latest call.
    const byId = await client.getById(7);
    expect(byId).toEqual(latest);
    expect(calls).toHaveLength(1);
  });

  test('sends Basic auth when configured', async () => {
    const { fetch: f, calls } = mockFetch({
      '/schemas/ids/1': { status: 200, body: { schema: AVRO_SCHEMA } },
    });
    const client = createSchemaRegistry({
      url: 'https://registry.example',
      auth: { username: 'u', password: 'p' },
      fetch: f,
    });
    await client.getById(1);
    expect(calls[0]?.headers.authorization).toBe(`Basic ${btoa('u:p')}`);
  });

  test('non-2xx response throws SchemaRegistryError', async () => {
    const { fetch: f } = mockFetch({
      '/schemas/ids/99': { status: 404, body: { error_code: 40403, message: 'not found' } },
    });
    const client = createSchemaRegistry({ url: 'https://registry.example', fetch: f });
    await expect(client.getById(99)).rejects.toThrow(SchemaRegistryError);
    await expect(client.getById(99)).rejects.toThrow(/404/);
  });

  test('malformed response throws typed error', async () => {
    const { fetch: f } = mockFetch({
      '/schemas/ids/5': { status: 200, body: { not_a_schema: true } },
    });
    const client = createSchemaRegistry({ url: 'https://registry.example', fetch: f });
    await expect(client.getById(5)).rejects.toThrow(/malformed/);
  });

  test('trailing slash in base URL is normalized', async () => {
    const { fetch: f, calls } = mockFetch({
      '/schemas/ids/1': { status: 200, body: { schema: AVRO_SCHEMA } },
    });
    const client = createSchemaRegistry({ url: 'https://registry.example/', fetch: f });
    await client.getById(1);
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/schemas/ids/1');
  });
});

// ─── Decoders (stubbed peer deps) ───────────────────────────────────────

describe('decodeAvro', () => {
  test('missing peer → helpful error', async () => {
    await expect(
      decodeAvro(new Uint8Array([1, 2, 3]), '{"type":"string"}', async () => {
        throw new Error('Cannot find module avsc');
      }),
    ).rejects.toThrow(/npm install avsc/);
  });

  test('decodes with stubbed avsc', async () => {
    const stub = {
      Type: {
        forSchema(schema: unknown) {
          return {
            fromBuffer(buf: Uint8Array) {
              return { __avro: true, schema, size: buf.length };
            },
          };
        },
      },
    };
    const decoded = await decodeAvro(
      new Uint8Array([10, 20, 30]),
      '{"type":"string"}',
      async () => stub,
    );
    expect(decoded).toEqual({ __avro: true, schema: { type: 'string' }, size: 3 });
  });

  test('invalid schema JSON throws', async () => {
    const stub = { Type: { forSchema: () => ({ fromBuffer: () => null }) } };
    await expect(decodeAvro(new Uint8Array([1]), '{not json}', async () => stub)).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe('decodeProtobuf', () => {
  test('missing peer → helpful error', async () => {
    await expect(
      decodeProtobuf(new Uint8Array([1]), 'message X { string id = 1; }', 'X', async () => {
        throw new Error('Cannot find module protobufjs');
      }),
    ).rejects.toThrow(/npm install protobufjs/);
  });

  test('decodes with stubbed protobufjs + explicit type name', async () => {
    const stub = {
      parse: (_src: string) => ({
        root: {
          lookupType(name: string) {
            return {
              decode: (buf: Uint8Array) => ({ __message: name, size: buf.length }),
              toObject: (msg: unknown) => msg,
            };
          },
        },
      }),
    };
    const decoded = await decodeProtobuf(
      new Uint8Array([1, 2, 3]),
      'syntax = "proto3"; message Foo { string id = 1; }',
      'Foo',
      async () => stub,
    );
    expect(decoded).toEqual({ __message: 'Foo', size: 3 });
  });

  test('infers message name from schema when omitted', async () => {
    let requested = '';
    const stub = {
      parse: () => ({
        root: {
          lookupType(name: string) {
            requested = name;
            return {
              decode: () => ({}),
              toObject: () => ({}),
            };
          },
        },
      }),
    };
    await decodeProtobuf(
      new Uint8Array([1]),
      'message Auto { string id = 1; }',
      undefined,
      async () => stub,
    );
    expect(requested).toBe('Auto');
  });

  test('throws when message name cannot be inferred', async () => {
    const stub = {
      parse: () => ({ root: { lookupType: () => ({ decode: () => ({}), toObject: () => ({}) }) } }),
    };
    await expect(
      decodeProtobuf(new Uint8Array([1]), 'syntax = "proto3";', undefined, async () => stub),
    ).rejects.toThrow(/could not infer/);
  });
});

describe('decodeMsgpack', () => {
  test('missing peer → helpful error', async () => {
    await expect(
      decodeMsgpack(new Uint8Array([1]), async () => {
        throw new Error('Cannot find module msgpackr');
      }),
    ).rejects.toThrow(/npm install msgpackr/);
  });

  test('decodes with stubbed msgpackr', async () => {
    const stub = {
      unpack(buf: Uint8Array) {
        return { __msgpack: true, size: buf.length };
      },
    };
    const decoded = await decodeMsgpack(new Uint8Array([1, 2, 3]), async () => stub);
    expect(decoded).toEqual({ __msgpack: true, size: 3 });
  });
});

/**
 * Confluent Schema Registry client + binary-format decoders.
 *
 * Wire format (prepended by Kafka + friends when using a schema registry):
 *
 *   byte 0      : 0x00  (magic byte)
 *   bytes 1..4  : schema id (big-endian uint32)
 *   bytes 5..   : Avro / Protobuf / JSON-Schema encoded payload
 *
 * This module's responsibilities:
 *   - Parse the wire-format prefix (`parseConfluentWireFormat`).
 *   - Resolve a schema by id from a Confluent-protocol HTTP registry
 *     (`createSchemaRegistry`). `getById` is cached; `getLatestForSubject`
 *     is not (subjects evolve).
 *   - Decode Avro / Protobuf / msgpack payloads through optional peer
 *     dependencies. Missing peers throw a clear "`npm install <name>`"
 *     error — core has zero hard dependency on any binary-format library.
 */

export class SchemaRegistryError extends Error {
  readonly code = 'ESCHEMAREG';
  constructor(message: string) {
    super(message);
    this.name = 'SchemaRegistryError';
  }
}

// ─── Wire format ─────────────────────────────────────────────────────────

export const CONFLUENT_MAGIC_BYTE = 0x00;

export interface WireFormatParts {
  schemaId: number;
  payload: Uint8Array;
}

/**
 * Peel the Confluent prefix off a message. Throws `SchemaRegistryError`
 * on short buffers or a wrong magic byte.
 */
export function parseConfluentWireFormat(value: Uint8Array): WireFormatParts {
  if (value.length < 5) {
    throw new SchemaRegistryError(
      `message too short for Confluent wire format: ${value.length} bytes (need ≥5)`,
    );
  }
  if (value[0] !== CONFLUENT_MAGIC_BYTE) {
    throw new SchemaRegistryError(
      `expected Confluent magic byte 0x00, got 0x${(value[0] as number).toString(16).padStart(2, '0')}`,
    );
  }
  const b1 = value[1] as number;
  const b2 = value[2] as number;
  const b3 = value[3] as number;
  const b4 = value[4] as number;
  // Big-endian uint32. `>>> 0` forces unsigned.
  const schemaId = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
  return { schemaId, payload: value.subarray(5) };
}

// ─── Registry client ─────────────────────────────────────────────────────

export interface SchemaRecord {
  id: number;
  /** Raw schema text (Avro JSON, Protobuf .proto source, JSON-Schema JSON). */
  schema: string;
  /** "AVRO" | "PROTOBUF" | "JSON". Registry default is AVRO when omitted. */
  schemaType?: string;
  subject?: string;
  version?: number;
}

export interface SchemaRegistryClient {
  /**
   * Resolve a schema by its registry-assigned id. Results are cached
   * in memory since ids are immutable for the lifetime of a schema.
   */
  getById(id: number): Promise<SchemaRecord>;
  /**
   * Resolve the latest version for a subject. NOT cached — subjects
   * can evolve; adapters re-read as needed.
   */
  getLatestForSubject(subject: string): Promise<SchemaRecord>;
}

export interface SchemaRegistryAuth {
  username: string;
  password: string;
}

export interface CreateSchemaRegistryOptions {
  url: string;
  auth?: SchemaRegistryAuth;
  /** Request timeout ms. Default 5000. */
  timeoutMs?: number;
  /** Test override — swap in `fetch` impls that simulate the registry. */
  fetch?: typeof fetch;
}

export function createSchemaRegistry(options: CreateSchemaRegistryOptions): SchemaRegistryClient {
  const baseUrl = options.url.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const authHeader = options.auth
    ? `Basic ${btoa(`${options.auth.username}:${options.auth.password}`)}`
    : undefined;

  const byIdCache = new Map<number, SchemaRecord>();

  async function request(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.schemaregistry.v1+json, application/json',
    };
    if (authHeader) headers.Authorization = authHeader;
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '<no body>');
        throw new SchemaRegistryError(
          `registry ${path} returned ${res.status} ${res.statusText}: ${body}`,
        );
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function recordFromResponse(data: unknown, fallbackId: number): SchemaRecord {
    if (
      !data ||
      typeof data !== 'object' ||
      typeof (data as { schema?: unknown }).schema !== 'string'
    ) {
      throw new SchemaRegistryError(
        'registry returned malformed response (missing "schema" field)',
      );
    }
    const d = data as {
      id?: number;
      schema: string;
      schemaType?: string;
      subject?: string;
      version?: number;
    };
    const rec: SchemaRecord = {
      id: typeof d.id === 'number' ? d.id : fallbackId,
      schema: d.schema,
    };
    if (d.schemaType !== undefined) rec.schemaType = d.schemaType;
    if (d.subject !== undefined) rec.subject = d.subject;
    if (d.version !== undefined) rec.version = d.version;
    return rec;
  }

  return {
    async getById(id: number): Promise<SchemaRecord> {
      const cached = byIdCache.get(id);
      if (cached) return cached;
      const data = await request(`/schemas/ids/${id}`);
      const rec = recordFromResponse(data, id);
      byIdCache.set(id, rec);
      return rec;
    },
    async getLatestForSubject(subject: string): Promise<SchemaRecord> {
      const data = await request(`/subjects/${encodeURIComponent(subject)}/versions/latest`);
      const rec = recordFromResponse(data, Number.NaN);
      if (Number.isNaN(rec.id)) {
        throw new SchemaRegistryError(
          `registry response for subject "${subject}" is missing numeric "id"`,
        );
      }
      // Warm the id cache so subsequent getById calls don't roundtrip.
      byIdCache.set(rec.id, rec);
      return rec;
    },
  };
}

// ─── Peer-dep loader ─────────────────────────────────────────────────────

export type PeerDepLoader = (moduleName: string) => Promise<unknown>;

export const defaultPeerLoader: PeerDepLoader = (name) => import(name);

async function loadPeer(
  loader: PeerDepLoader,
  moduleName: string,
  format: string,
): Promise<unknown> {
  try {
    return await loader(moduleName);
  } catch (err) {
    throw new SchemaRegistryError(
      `${format} decoding requires the \`${moduleName}\` peer dependency. ` +
        `Run \`npm install ${moduleName}\`. (load error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

// ─── Decoders ────────────────────────────────────────────────────────────

interface AvscModule {
  Type: { forSchema: (schema: unknown) => { fromBuffer: (buf: Uint8Array) => unknown } };
}

/**
 * Decode Avro-encoded bytes against a JSON schema string (as returned by
 * the registry). Requires the `avsc` peer dep.
 */
export async function decodeAvro(
  payload: Uint8Array,
  schema: string,
  loader: PeerDepLoader = defaultPeerLoader,
): Promise<unknown> {
  const mod = (await loadPeer(loader, 'avsc', 'Avro')) as AvscModule;
  let schemaObj: unknown;
  try {
    schemaObj = JSON.parse(schema);
  } catch (err) {
    throw new SchemaRegistryError(
      `Avro schema is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const type = mod.Type.forSchema(schemaObj);
  try {
    return type.fromBuffer(payload);
  } catch (err) {
    throw new SchemaRegistryError(
      `Avro decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface ProtobufjsModule {
  parse: (source: string) => {
    root: {
      lookupType: (name: string) => {
        decode: (buf: Uint8Array) => unknown;
        toObject: (msg: unknown) => unknown;
      };
    };
  };
}

/**
 * Decode Protobuf-encoded bytes against a `.proto` source string.
 * `messageType` picks the top-level message; if omitted we try to infer
 * it from the schema (`message Foo { ... }` → `Foo`).
 *
 * Requires the `protobufjs` peer dep.
 */
export async function decodeProtobuf(
  payload: Uint8Array,
  schema: string,
  messageType: string | undefined,
  loader: PeerDepLoader = defaultPeerLoader,
): Promise<unknown> {
  const mod = (await loadPeer(loader, 'protobufjs', 'Protobuf')) as ProtobufjsModule;
  let parsed: ReturnType<ProtobufjsModule['parse']>;
  try {
    parsed = mod.parse(schema);
  } catch (err) {
    throw new SchemaRegistryError(
      `Protobuf schema parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const typeName = messageType ?? inferProtoMessageName(schema);
  const type = parsed.root.lookupType(typeName);
  try {
    const message = type.decode(payload);
    return type.toObject(message);
  } catch (err) {
    throw new SchemaRegistryError(
      `Protobuf decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function inferProtoMessageName(schema: string): string {
  const m = schema.match(/message\s+(\w+)/);
  if (!m) {
    throw new SchemaRegistryError(
      'could not infer protobuf message name from schema; pass `messageType` explicitly',
    );
  }
  return m[1] as string;
}

interface MsgpackrModule {
  unpack: (buf: Uint8Array) => unknown;
}

/** Decode msgpack bytes. Requires the `msgpackr` peer dep. */
export async function decodeMsgpack(
  payload: Uint8Array,
  loader: PeerDepLoader = defaultPeerLoader,
): Promise<unknown> {
  const mod = (await loadPeer(loader, 'msgpackr', 'msgpack')) as MsgpackrModule;
  try {
    return mod.unpack(payload);
  } catch (err) {
    throw new SchemaRegistryError(
      `msgpack decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Convenience: bytes from RawMessage.value ───────────────────────────

/**
 * Normalize the polymorphic `RawMessage.value` (`string | Uint8Array`)
 * into bytes. For binary formats, adapters SHOULD pass a `Uint8Array`
 * directly; the string fallback uses UTF-8 which loses data for
 * arbitrary binary.
 */
export function asBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  return new TextEncoder().encode(value);
}

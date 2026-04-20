import type { Logger } from '../types/logger.js';
import type { AgentSpec } from '../types/session.js';
import { evaluateFilter } from './filter-expr.js';
import { isJsonPath, resolveJsonPath } from './jsonpath.js';
import {
  type CreateSchemaRegistryOptions,
  type PeerDepLoader,
  type SchemaRegistryClient,
  asBytes,
  createSchemaRegistry,
  decodeAvro,
  decodeMsgpack,
  decodeProtobuf,
  parseConfluentWireFormat,
} from './schema-registry.js';
import type {
  AgentEvent,
  AgentEventMeta,
  EventKind,
  EventTarget,
  JsonPath,
  MessageNormalizer,
  NormalizeContext,
  RawMessage,
  RoutingConfig,
  TargetSelector,
} from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

export class NormalizeError extends Error {
  readonly code = 'ENORMALIZE';
  constructor(message: string) {
    super(message);
    this.name = 'NormalizeError';
  }
}

export interface CreateMessageNormalizerOptions {
  logger?: Logger;
  /**
   * Factory for schema-registry clients. Default: `createSchemaRegistry`
   * from `schema-registry.ts`. Per-URL clients are cached internally so
   * multiple sources pointing at the same registry share one id cache.
   */
  createRegistry?: (options: CreateSchemaRegistryOptions) => SchemaRegistryClient;
  /**
   * Test override for peer-dep loading. Default: `(name) => import(name)`.
   * Tests pass stubs for avsc / protobufjs / msgpackr without requiring
   * real packages to be installed.
   */
  peerLoader?: PeerDepLoader;
}

/**
 * Default `MessageNormalizer`. Handles JSON + plain payloads; Avro and
 * Protobuf flow through the Confluent-shaped wire format + a registry
 * lookup; msgpack decodes straight through. Each binary decoder loads
 * its peer dep lazily — core has zero hard runtime dep on any of them.
 *
 * JSONPath references are body-rooted — `$.order_id` resolves against
 * the decoded body. Transport metadata (topic, partition, offset,
 * headers) is NOT in the path namespace; use the `transport-natural`
 * idempotency strategy to derive keys from it.
 */
export function createMessageNormalizer(
  opts: CreateMessageNormalizerOptions = {},
): MessageNormalizer {
  const logger = opts.logger ?? NOOP_LOGGER;
  const createRegistry = opts.createRegistry ?? createSchemaRegistry;
  const peerLoader = opts.peerLoader;

  // One client per distinct registry URL. Shared across sources so the
  // `id → schema` cache isn't per-source duplicated.
  const registryCache = new Map<string, SchemaRegistryClient>();
  function registryFor(url: string): SchemaRegistryClient {
    const cached = registryCache.get(url);
    if (cached) return cached;
    const client = createRegistry({ url });
    registryCache.set(url, client);
    return client;
  }

  return {
    async normalize(
      raw: RawMessage,
      routing: RoutingConfig,
      ctx: NormalizeContext,
    ): Promise<AgentEvent | null> {
      // 1. Decode raw bytes / string into structured body.
      const decoded = await decodePayload(raw.value, routing, {
        registryFor,
        ...(peerLoader !== undefined && { peerLoader }),
      });

      // 2. Apply filter expression. `null` return means "drop this message."
      if (routing.filter?.expr) {
        try {
          if (!evaluateFilter(routing.filter.expr, decoded)) return null;
        } catch (err) {
          throw new NormalizeError(
            `filter expression "${routing.filter.expr}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // 3. Optional transform — path extraction carves out a subtree.
      //    (JSONata-style rewrites are a Phase-4.x peer-dep upgrade.)
      const body = routing.transform?.expr
        ? (resolveJsonPath(decoded, routing.transform.expr) ?? decoded)
        : decoded;

      // 4. Resolve event kind.
      const kind = resolveKind(body, routing.kindSelector);

      // 5. Resolve event target.
      const target = resolveTarget(body, routing.targetSelector);

      // 6. Build meta (correlationId + idempotencyKey).
      const meta: AgentEventMeta = {};
      if (routing.correlationIdFrom) {
        const v = resolveJsonPath(body, routing.correlationIdFrom);
        if (typeof v === 'string' && v.length > 0) meta.correlationId = v;
      }
      const idempotencyKey = deriveIdempotencyKey(raw, routing.idempotencyKeyFrom, body);
      if (idempotencyKey) meta.idempotencyKey = idempotencyKey;

      // 7. Event id — prefer a header-supplied id, else fall back to UUID.
      const headerId = raw.headers?.['x-event-id'];
      const id =
        typeof headerId === 'string' && headerId.length > 0 ? headerId : crypto.randomUUID();

      const event: AgentEvent = {
        id,
        kind,
        source: ctx.source,
        target,
        timestamp: raw.timestamp ?? Date.now(),
        payload: body,
        auth: ctx.auth ?? { kind: 'internal' },
      };
      if (Object.keys(meta).length > 0) event.meta = meta;

      // `logger` is reserved for future decode-error breadcrumbs; avoid
      // the "variable defined but not used" lint by making it observable.
      void logger;

      return event;
    },
  };
}

// ─── Decoders ────────────────────────────────────────────────────────────

interface DecodeDeps {
  registryFor(url: string): SchemaRegistryClient;
  peerLoader?: PeerDepLoader;
}

async function decodePayload(
  value: string | Uint8Array,
  routing: RoutingConfig,
  deps: DecodeDeps,
): Promise<unknown> {
  const format = routing.format ?? 'json';

  switch (format) {
    case 'plain': {
      const str = typeof value === 'string' ? value : new TextDecoder().decode(value);
      return { text: str };
    }
    case 'json': {
      const str = typeof value === 'string' ? value : new TextDecoder().decode(value);
      if (str.length === 0) return null;
      try {
        return JSON.parse(str);
      } catch (err) {
        throw new NormalizeError(
          `invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    case 'avro':
    case 'protobuf': {
      if (!routing.schemaRegistry) {
        throw new NormalizeError(
          `format "${format}" requires routing.schemaRegistry.url to resolve schemas`,
        );
      }
      const bytes = asBytes(value);
      const { schemaId, payload } = parseConfluentWireFormat(bytes);
      const client = deps.registryFor(routing.schemaRegistry.url);
      const record = await client.getById(schemaId);
      if (format === 'avro') {
        return decodeAvro(payload, record.schema, deps.peerLoader);
      }
      return decodeProtobuf(payload, record.schema, undefined, deps.peerLoader);
    }
    case 'msgpack':
      return decodeMsgpack(asBytes(value), deps.peerLoader);
    default:
      throw new NormalizeError(`unknown format "${format}"`);
  }
}

// ─── Kind selector ───────────────────────────────────────────────────────

function resolveKind(body: unknown, selector: RoutingConfig['kindSelector']): EventKind {
  if (typeof selector === 'object' && selector && 'const' in selector) {
    return selector.const;
  }
  if (typeof selector !== 'string') {
    throw new NormalizeError('kindSelector must be a JSONPath or { const: ... }');
  }
  const v = resolveJsonPath(body, selector);
  if (typeof v !== 'string' || v.length === 0) {
    throw new NormalizeError(
      `kindSelector "${selector}" did not resolve to a non-empty string (got ${describe(v)})`,
    );
  }
  return v as EventKind;
}

// ─── Target selector ─────────────────────────────────────────────────────

function resolveTarget(body: unknown, selector: TargetSelector): EventTarget {
  switch (selector.type) {
    case 'broadcast':
      return { type: 'broadcast' };

    case 'session': {
      const sessionId = resolveJsonPath(body, selector.sessionIdFrom);
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new NormalizeError(
          `session.sessionIdFrom "${selector.sessionIdFrom}" did not resolve to a non-empty string`,
        );
      }
      return { type: 'session', sessionId, mode: selector.action };
    }

    case 'new-session': {
      const initialPrompt = selector.initialPromptFrom
        ? String(resolveJsonPath(body, selector.initialPromptFrom) ?? '')
        : '';
      const target: EventTarget = {
        type: 'new-session',
        initialPrompt,
      };
      if (selector.agentSpec) target.agentSpec = selector.agentSpec as Partial<AgentSpec>;
      return target;
    }

    case 'skill': {
      const inputs: Record<string, unknown> = {};
      if (selector.inputs) {
        for (const [key, spec] of Object.entries(selector.inputs)) {
          if (isJsonPath(spec)) {
            inputs[key] = resolveJsonPath(body, spec);
          } else {
            // Bare string literal (or any non-path value).
            inputs[key] = spec;
          }
        }
      }
      return { type: 'skill', name: selector.name, inputs };
    }

    case 'sub-agent': {
      const parentSessionId = resolveJsonPath(body, selector.parentSessionIdFrom);
      if (typeof parentSessionId !== 'string' || parentSessionId.length === 0) {
        throw new NormalizeError(
          `sub-agent.parentSessionIdFrom "${selector.parentSessionIdFrom}" did not resolve`,
        );
      }
      return { type: 'sub-agent', parentSessionId, spec: {} };
    }
  }
}

// ─── Idempotency key derivation ─────────────────────────────────────────

function deriveIdempotencyKey(
  raw: RawMessage,
  from: JsonPath | 'transport-natural' | 'content-hash' | undefined,
  body: unknown,
): string | undefined {
  if (from === undefined || from === 'transport-natural') {
    return deriveTransportNatural(raw);
  }
  if (from === 'content-hash') {
    return contentHash(raw.value);
  }
  if (isJsonPath(from)) {
    const v = resolveJsonPath(body, from);
    if (typeof v === 'string' && v.length > 0) return v;
    return undefined;
  }
  return undefined;
}

function deriveTransportNatural(raw: RawMessage): string | undefined {
  // Streaming log (Kafka-shape): topic + partition + offset.
  if (raw.topic != null && raw.partition != null && raw.offset != null) {
    return `${raw.topic}:${raw.partition}:${raw.offset}`;
  }
  // Queue shapes expose a message id via meta.
  const messageId = raw.meta?.messageId;
  if (typeof messageId === 'string' && messageId.length > 0) return messageId;
  if (typeof messageId === 'number') return String(messageId);
  // AMQP: exchange + routing-key + delivery-tag.
  const deliveryTag = raw.meta?.deliveryTag;
  if (deliveryTag != null && raw.routingKey) {
    return `amqp:${raw.routingKey}:${String(deliveryTag)}`;
  }
  // Last resort: no natural key, let caller fall through to content-hash.
  return contentHash(raw.value);
}

/**
 * Non-cryptographic djb2 hash. Stable across runs, non-cryptographic.
 * Used only when no natural key is available and the user hasn't opted
 * into `content-hash` explicitly — real content-hash in practice uses
 * SHA-256 via the transport's own hashing (kafkajs etc. expose it).
 */
function contentHash(value: string | Uint8Array): string {
  const str = typeof value === 'string' ? value : new TextDecoder().decode(value);
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  // >>> 0 forces unsigned; hex encoding for readability.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return `"${v}"`;
  if (typeof v === 'object') return Array.isArray(v) ? 'array' : 'object';
  return String(v);
}

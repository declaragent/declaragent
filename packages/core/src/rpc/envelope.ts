/**
 * Agent RPC envelope — the wire format exchanged between agents over a
 * broker. Frozen at v1.1 under `version: 1`; additive-only evolution
 * within v1, breaking changes bump to `version: 2`.
 *
 * @since 1.1.0
 */

import { z } from 'zod';

/** Logical agent address. Matches `agent.yaml.name`, optionally `@<version>`. */
export type AgentAddress = `agent://${string}`;

/** Concrete broker topic/subject/queue. Transport-tagged. */
export type BrokerAddress =
  | `kafka://${string}`
  | `nats://${string}`
  | `sqs://${string}`
  | `amqp://${string}`
  | `mqtt://${string}`
  | `memory://${string}`;

/**
 * Envelope authenticator.
 *
 *   - `internal`       — intra-cluster trust, no crypto.
 *   - `hmac`           — shared-secret signing over the canonical envelope
 *                        form (see {@link canonicalizeForSigning}).
 *   - `oidc`           — bearer JWT issued by an OIDC IdP, verified against
 *                        a cached JWKS on the receiver (see
 *                        `@declaragent/plugin-agent-rpc/auth/oidc`).
 *   - `oauth2-client`  — bearer access token minted via OAuth2
 *                        Client-Credentials. Verified the same way as OIDC.
 *
 * Soft-compat within `version: 1`: receivers that don't recognise one of
 * the additive variants fail envelope decode and the transport routes
 * the message to the local DLQ — no silent accept.
 *
 * @since 1.1.0 — `internal`, `hmac`
 * @since 1.2.0 — `oidc`, `oauth2-client`
 */
export type RpcAuth =
  | { kind: 'internal' }
  | { kind: 'hmac'; keyId: string; signature: string }
  | { kind: 'oidc'; token: string; keyId?: string }
  | { kind: 'oauth2-client'; token: string; scope?: string };

/** Typed error body used on `response` envelopes with `status !== 'ok'`. */
export interface RpcError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Three message kinds. `request` expects a `replyTo`; `response` carries
 * a matching `correlationId`; `event` is fire-and-forget with no reply.
 */
export type EnvelopeKind = 'request' | 'response' | 'event';

/** @since 1.1.0 */
export interface AgentRpcEnvelope {
  /** Protocol version. v1.1 freezes this at 1; a breaking change bumps it. */
  version: 1;
  kind: EnvelopeKind;
  /** UUID unique to this message. */
  messageId: string;
  /** Request.correlationId === response.correlationId. */
  correlationId: string;
  /** Prior messageId — feeds dispatcher loop-detection. */
  causedBy?: string;
  from: AgentAddress;
  to: AgentAddress;
  /** Logical function name; maps to a skill on the receiver. */
  capability: string;
  /** Reply destination. Omit for `kind: 'event'`. */
  replyTo?: BrokerAddress;
  /** Absolute ms-epoch deadline. Receivers MAY reject when now > deadline. */
  deadline?: number;
  /** Must match the bus scope on both sides; enforced on decode. */
  tenantId?: string;
  /** Opaque transport annotations (routing hints, trace headers). */
  headers?: Record<string, string>;
  /** Capability-specific JSON payload. */
  payload: unknown;
  auth?: RpcAuth;
}

// ── Zod schema ────────────────────────────────────────────────────────────

const AgentAddressSchema = z
  .string()
  .regex(/^agent:\/\/.+/, 'expected "agent://<id>"') as unknown as z.ZodType<AgentAddress>;

const BrokerAddressSchema = z
  .string()
  .regex(
    /^(kafka|nats|sqs|amqp|mqtt|memory):\/\/.+/,
    'expected "<transport>://<path>"',
  ) as unknown as z.ZodType<BrokerAddress>;

const RpcAuthSchema = z.union([
  z.object({ kind: z.literal('internal') }),
  z.object({
    kind: z.literal('hmac'),
    keyId: z.string().min(1),
    signature: z.string().min(1),
  }),
  z.object({
    kind: z.literal('oidc'),
    token: z.string().min(1),
    keyId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('oauth2-client'),
    token: z.string().min(1),
    scope: z.string().min(1).optional(),
  }),
]);

/**
 * Strict runtime validator. Unknown top-level fields are rejected to keep
 * v1 evolution strictly additive — a typo'd field name fails closed on
 * the receiver rather than being silently ignored.
 */
export const AgentRpcEnvelopeSchema = z
  .object({
    version: z.literal(1),
    kind: z.union([z.literal('request'), z.literal('response'), z.literal('event')]),
    messageId: z.string().min(1),
    correlationId: z.string().min(1),
    causedBy: z.string().min(1).optional(),
    from: AgentAddressSchema,
    to: AgentAddressSchema,
    capability: z.string().min(1),
    replyTo: BrokerAddressSchema.optional(),
    deadline: z.number().int().positive().optional(),
    tenantId: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    payload: z.unknown(),
    auth: RpcAuthSchema.optional(),
  })
  .strict();

export function parseEnvelope(raw: unknown): AgentRpcEnvelope {
  const result = AgentRpcEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new RpcEnvelopeValidationError(detail, result.error.issues);
  }
  // Zod's inferred type widens optional fields to `field | undefined`,
  // while `exactOptionalPropertyTypes` keeps the interface tight. Strip
  // the undefined-valued keys before narrowing.
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.data)) {
    if (value !== undefined) stripped[key] = value;
  }
  return stripped as unknown as AgentRpcEnvelope;
}

/**
 * Decode + validate a JSON-encoded envelope. `raw` may be a string or a
 * Uint8Array (UTF-8). Separate from {@link parseEnvelope} so transports
 * that hand us raw bytes don't have to JSON.parse themselves.
 */
export function decodeEnvelope(raw: string | Uint8Array): AgentRpcEnvelope {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new RpcEnvelopeValidationError(
      `envelope is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      [],
    );
  }
  return parseEnvelope(json);
}

/** Encode an envelope for the wire. Validates before stringifying. */
export function encodeEnvelope(envelope: AgentRpcEnvelope): string {
  // Round-trip through parse so callers can't ship a malformed envelope
  // that only the receiver will reject. This is cheap relative to broker
  // publish cost.
  return JSON.stringify(parseEnvelope(envelope));
}

/**
 * Canonical string form used by HMAC signing (minus the `auth` field
 * itself). Key ordering is deterministic: a JSON serialization of
 * `{ version, kind, messageId, correlationId, causedBy, from, to,
 *   capability, replyTo, deadline, tenantId, headers, payload }` in that
 * exact key order. Missing optional fields are skipped.
 *
 * Receivers run the same canonicalizer and compare the resulting
 * SHA-256 hex against `auth.signature`.
 */
export function canonicalizeForSigning(envelope: AgentRpcEnvelope): string {
  const ordered: Record<string, unknown> = {};
  const keys: (keyof AgentRpcEnvelope)[] = [
    'version',
    'kind',
    'messageId',
    'correlationId',
    'causedBy',
    'from',
    'to',
    'capability',
    'replyTo',
    'deadline',
    'tenantId',
    'headers',
    'payload',
  ];
  for (const key of keys) {
    const value = envelope[key];
    if (value !== undefined) ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

export class RpcEnvelopeValidationError extends Error {
  readonly issues: readonly unknown[];
  constructor(message: string, issues: readonly unknown[]) {
    super(`invalid agent-rpc envelope: ${message}`);
    this.name = 'RpcEnvelopeValidationError';
    this.issues = issues;
  }
}

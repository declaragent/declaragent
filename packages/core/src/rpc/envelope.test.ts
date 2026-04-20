import { describe, expect, test } from 'bun:test';
import {
  type AgentRpcEnvelope,
  RpcEnvelopeValidationError,
  canonicalizeForSigning,
  decodeEnvelope,
  encodeEnvelope,
  parseEnvelope,
} from './envelope.js';

function baseRequest(
  overrides: Partial<Record<keyof AgentRpcEnvelope, unknown>> = {},
): AgentRpcEnvelope {
  const base: AgentRpcEnvelope = {
    version: 1,
    kind: 'request',
    messageId: '11111111-1111-1111-1111-111111111111',
    correlationId: '22222222-2222-2222-2222-222222222222',
    from: 'agent://concierge',
    to: 'agent://pr-reviewer',
    capability: 'review-pr',
    replyTo: 'kafka://agents.concierge.responses',
    payload: { prUrl: 'https://github.com/acme/app/pull/1' },
  };
  return { ...base, ...overrides } as AgentRpcEnvelope;
}

describe('AgentRpcEnvelope', () => {
  test('accepts a minimal request envelope', () => {
    const env = baseRequest();
    const parsed = parseEnvelope(env);
    expect(parsed.kind).toBe('request');
    expect(parsed.capability).toBe('review-pr');
  });

  test('accepts a response envelope with no replyTo', () => {
    const env = baseRequest({ kind: 'response', replyTo: undefined, payload: { ok: true } });
    expect(() => parseEnvelope(env)).not.toThrow();
  });

  test('rejects version !== 1', () => {
    expect(() => parseEnvelope({ ...baseRequest(), version: 2 })).toThrow(
      RpcEnvelopeValidationError,
    );
  });

  test('rejects unknown top-level keys (strict mode)', () => {
    expect(() =>
      parseEnvelope({ ...baseRequest(), unknownField: 'foo' } as unknown as AgentRpcEnvelope),
    ).toThrow(RpcEnvelopeValidationError);
  });

  test('rejects malformed from/to addresses', () => {
    expect(() => parseEnvelope({ ...baseRequest(), from: 'not-an-agent-url' })).toThrow(
      RpcEnvelopeValidationError,
    );
  });

  test('rejects malformed replyTo scheme', () => {
    expect(() =>
      parseEnvelope({ ...baseRequest(), replyTo: 'http://not-a-broker' as never }),
    ).toThrow(RpcEnvelopeValidationError);
  });

  test('encode → decode round-trip preserves all fields', () => {
    const original = baseRequest({
      causedBy: 'prev-message-id',
      tenantId: 'acme-prod',
      headers: { traceparent: '00-abc-def-01' },
      deadline: Date.now() + 30_000,
      auth: { kind: 'internal' },
    });
    const wire = encodeEnvelope(original);
    const decoded = decodeEnvelope(wire);
    expect(decoded).toEqual(original);
  });

  test('decode tolerates Uint8Array input', () => {
    const env = baseRequest();
    const bytes = new TextEncoder().encode(JSON.stringify(env));
    expect(decodeEnvelope(bytes)).toEqual(env);
  });

  test('decode throws RpcEnvelopeValidationError on bad JSON', () => {
    expect(() => decodeEnvelope('not json')).toThrow(RpcEnvelopeValidationError);
  });

  test('hmac auth requires keyId + signature', () => {
    expect(() =>
      parseEnvelope({
        ...baseRequest(),
        auth: { kind: 'hmac', keyId: 'k1', signature: 'sig' },
      }),
    ).not.toThrow();

    expect(() =>
      parseEnvelope({
        ...baseRequest(),
        auth: { kind: 'hmac' } as never,
      }),
    ).toThrow(RpcEnvelopeValidationError);
  });

  test('canonicalizeForSigning omits auth and orders keys deterministically', () => {
    const env = baseRequest({
      auth: { kind: 'hmac', keyId: 'k1', signature: 'sig' },
      headers: { 'x-b': 'b', 'x-a': 'a' },
    });
    const canonical = canonicalizeForSigning(env);
    expect(canonical).not.toContain('"auth"');
    expect(canonical).not.toContain('"signature"');
    const firstKeyIdx = canonical.indexOf('"version"');
    const kindIdx = canonical.indexOf('"kind"');
    const messageIdIdx = canonical.indexOf('"messageId"');
    expect(firstKeyIdx).toBeLessThan(kindIdx);
    expect(kindIdx).toBeLessThan(messageIdIdx);
  });

  test('canonicalizeForSigning is stable across logically-equivalent envelopes', () => {
    const env1 = baseRequest();
    // Swap construction order; canonicalizer produces the same string.
    const env2: AgentRpcEnvelope = {
      to: env1.to,
      from: env1.from,
      kind: env1.kind,
      version: env1.version,
      messageId: env1.messageId,
      correlationId: env1.correlationId,
      capability: env1.capability,
      ...(env1.replyTo !== undefined && { replyTo: env1.replyTo }),
      payload: env1.payload,
    };
    expect(canonicalizeForSigning(env1)).toBe(canonicalizeForSigning(env2));
  });

  test('event kind does not require replyTo', () => {
    expect(() =>
      parseEnvelope({ ...baseRequest(), kind: 'event', replyTo: undefined }),
    ).not.toThrow();
  });

  test('deadline must be positive integer', () => {
    expect(() => parseEnvelope({ ...baseRequest(), deadline: -1 })).toThrow(
      RpcEnvelopeValidationError,
    );
    expect(() => parseEnvelope({ ...baseRequest(), deadline: 0 })).toThrow(
      RpcEnvelopeValidationError,
    );
  });
});

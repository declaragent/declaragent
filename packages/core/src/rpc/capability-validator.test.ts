import { describe, expect, test } from 'bun:test';
import {
  CapabilitySchemaCompileError,
  CapabilitySchemaViolationError,
  canonicalJson,
  compileCapabilityValidator,
  createCapabilityValidatorRegistry,
  hashSchema,
} from './capability-validator.js';

describe('compileCapabilityValidator', () => {
  test('accepts minimal type:object schema and validates required keys', () => {
    const v = compileCapabilityValidator({
      capabilityName: 'review',
      side: 'request',
      schema: {
        type: 'object',
        properties: { prUrl: { type: 'string' } },
        required: ['prUrl'],
      },
    });
    expect(v.validate({ prUrl: 'https://x' })).toEqual({ ok: true });
    const bad = v.validate({});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.violations[0]?.message).toContain('required');
  });

  test('rejects enum violations', () => {
    const v = compileCapabilityValidator({
      capabilityName: 'r',
      side: 'request',
      schema: {
        type: 'object',
        properties: {
          severity: { enum: ['low', 'med', 'high'] },
        },
        required: ['severity'],
      },
    });
    expect(v.validate({ severity: 'high' }).ok).toBe(true);
    const r = v.validate({ severity: 'critical' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]?.message).toContain('enum');
  });

  test('additionalProperties:false rejects unexpected keys', () => {
    const v = compileCapabilityValidator({
      capabilityName: 'r',
      side: 'request',
      schema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
    });
    expect(v.validate({ a: 'x' }).ok).toBe(true);
    const r = v.validate({ a: 'x', b: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]?.message).toContain('additional property "b"');
  });

  test('nested arrays with items', () => {
    const v = compileCapabilityValidator({
      capabilityName: 'r',
      side: 'response',
      schema: {
        type: 'object',
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity: { enum: ['blocker', 'major', 'minor', 'nit'] },
              },
              required: ['severity'],
            },
          },
        },
      },
    });
    expect(v.validate({ findings: [{ severity: 'blocker' }] }).ok).toBe(true);
    const r = v.validate({ findings: [{ severity: 'catastrophic' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations[0]?.path).toBe('/findings/0/severity');
    }
  });

  test('$ref to local definitions resolves', () => {
    const v = compileCapabilityValidator({
      capabilityName: 'r',
      side: 'request',
      schema: {
        definitions: {
          Severity: { enum: ['low', 'med', 'high'] },
        },
        type: 'object',
        properties: { severity: { $ref: '#/definitions/Severity' } },
      },
    });
    expect(v.validate({ severity: 'low' }).ok).toBe(true);
    expect(v.validate({ severity: 'extreme' }).ok).toBe(false);
  });

  test('unknown keyword throws at compile time', () => {
    expect(() =>
      compileCapabilityValidator({
        capabilityName: 'r',
        side: 'request',
        schema: { type: 'object', patternProperties: { '^x': { type: 'string' } } },
      }),
    ).toThrow(CapabilitySchemaCompileError);
  });

  test('tuple items[] not supported', () => {
    expect(() =>
      compileCapabilityValidator({
        capabilityName: 'r',
        side: 'request',
        schema: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] },
      }),
    ).toThrow(CapabilitySchemaCompileError);
  });

  test('unresolved $ref throws at compile time', () => {
    expect(() =>
      compileCapabilityValidator({
        capabilityName: 'r',
        side: 'request',
        schema: { $ref: '#/definitions/Missing' },
      }),
    ).toThrow(CapabilitySchemaCompileError);
  });

  test('format: uuid advisory check', () => {
    const v = compileCapabilityValidator({
      capabilityName: 'r',
      side: 'request',
      schema: { type: 'string', format: 'uuid' },
    });
    expect(v.validate('9cbc85e6-bd6d-4b47-9e34-6f9cc0a4b2a9').ok).toBe(true);
    expect(v.validate('not-a-uuid').ok).toBe(false);
  });

  test('oneOf enforces exact-one match', () => {
    const v = compileCapabilityValidator({
      capabilityName: 'r',
      side: 'request',
      schema: {
        oneOf: [
          { type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] },
          { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'] },
        ],
      },
    });
    expect(v.validate({ kind: 'a' }).ok).toBe(true);
    expect(v.validate({ kind: 'c' }).ok).toBe(false);
  });
});

describe('createCapabilityValidatorRegistry', () => {
  test('caches compiled validators by schema hash', () => {
    const reg = createCapabilityValidatorRegistry();
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const v1 = reg.get('cap', 'request', schema);
    const v2 = reg.get('cap', 'request', schema);
    expect(v1).toBe(v2); // same cached reference
    expect(reg.size()).toBe(1);
  });

  test('returns null for omitted schema (back-compat)', () => {
    const reg = createCapabilityValidatorRegistry();
    expect(reg.get('cap', 'request', undefined)).toBeNull();
    expect(reg.get('cap', 'response', null)).toBeNull();
    expect(reg.size()).toBe(0);
  });

  test('different schema ⇒ new compile', () => {
    const reg = createCapabilityValidatorRegistry();
    reg.get('cap', 'request', { type: 'string' });
    reg.get('cap', 'request', { type: 'integer' });
    expect(reg.size()).toBe(2);
  });
});

describe('canonicalJson + hashSchema', () => {
  test('canonicalJson sorts keys (hash stable across key order)', () => {
    const a = { b: 1, a: 2, c: { z: 9, y: 8 } };
    const b = { a: 2, c: { y: 8, z: 9 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashSchema(a)).toBe(hashSchema(b));
  });

  test('different schema shapes ⇒ different hashes', () => {
    expect(hashSchema({ type: 'string' })).not.toBe(hashSchema({ type: 'integer' }));
  });
});

describe('CapabilitySchemaViolationError', () => {
  test('carries code + details', () => {
    const err = new CapabilitySchemaViolationError('review', 'request', [
      { path: '/severity', message: 'enum' },
    ]);
    expect(err.code).toBe('EAGENTRPC_SCHEMA_VIOLATION');
    expect(err.capabilityName).toBe('review');
    expect(err.side).toBe('request');
    expect(err.violations).toHaveLength(1);
    expect(err.message).toContain('/severity');
  });
});

import { describe, expect, test } from 'bun:test';
import { JsonPathError, isJsonPath, parseJsonPath, resolveJsonPath } from './jsonpath.js';

describe('parseJsonPath', () => {
  test('root-only path', () => {
    expect(parseJsonPath('$')).toEqual([]);
  });

  test('dot access', () => {
    expect(parseJsonPath('$.foo')).toEqual(['foo']);
    expect(parseJsonPath('$.foo.bar')).toEqual(['foo', 'bar']);
    expect(parseJsonPath('$.foo_bar.baz123')).toEqual(['foo_bar', 'baz123']);
  });

  test('numeric index', () => {
    expect(parseJsonPath('$.arr[0]')).toEqual(['arr', 0]);
    expect(parseJsonPath('$.a[10]')).toEqual(['a', 10]);
    expect(parseJsonPath('$[0]')).toEqual([0]);
  });

  test('bracket string access', () => {
    expect(parseJsonPath('$["weird key"]')).toEqual(['weird key']);
    expect(parseJsonPath("$['single']")).toEqual(['single']);
    expect(parseJsonPath("$.['dot-bracket']")).toEqual(['dot-bracket']);
  });

  test('mixed', () => {
    expect(parseJsonPath('$.orders[0].customer["id"]')).toEqual(['orders', 0, 'customer', 'id']);
  });

  test('rejects empty path', () => {
    expect(() => parseJsonPath('')).toThrow('non-empty');
  });

  test('requires leading $', () => {
    expect(() => parseJsonPath('foo.bar')).toThrow('must start with "$"');
  });

  test('rejects recursive descent', () => {
    expect(() => parseJsonPath('$..foo')).toThrow('recursive descent');
  });

  test('rejects wildcards', () => {
    expect(() => parseJsonPath('$.arr[*]')).toThrow('wildcard');
  });

  test('rejects predicates', () => {
    expect(() => parseJsonPath('$.arr[?(@.x)]')).toThrow('predicate');
  });

  test('unterminated bracket throws', () => {
    expect(() => parseJsonPath('$.arr[0')).toThrow(/expected "\]"|unterminated/);
  });

  test('unterminated quoted key throws', () => {
    expect(() => parseJsonPath('$["weird')).toThrow('unterminated');
  });

  test('throws JsonPathError with path + reason', () => {
    try {
      parseJsonPath('$..');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JsonPathError);
      if (err instanceof JsonPathError) {
        expect(err.path).toBe('$..');
        expect(err.code).toBe('EJSONPATH');
      }
    }
  });
});

describe('resolveJsonPath', () => {
  const doc = {
    order: {
      id: 'abc',
      items: [
        { sku: 'X', qty: 2 },
        { sku: 'Y', qty: 1 },
      ],
    },
    'weird key': 42,
    empty: null,
  };

  test('root identity', () => {
    expect(resolveJsonPath(doc, '$')).toBe(doc);
  });

  test('simple dot access', () => {
    expect(resolveJsonPath(doc, '$.order.id')).toBe('abc');
  });

  test('array index', () => {
    expect(resolveJsonPath(doc, '$.order.items[0].sku')).toBe('X');
    expect(resolveJsonPath(doc, '$.order.items[1].qty')).toBe(1);
  });

  test('bracket string access', () => {
    expect(resolveJsonPath(doc, '$["weird key"]')).toBe(42);
  });

  test('missing keys return undefined', () => {
    expect(resolveJsonPath(doc, '$.nope')).toBeUndefined();
    expect(resolveJsonPath(doc, '$.order.missing.chain')).toBeUndefined();
  });

  test('null guards stop traversal', () => {
    expect(resolveJsonPath(doc, '$.empty.anything')).toBeUndefined();
  });

  test('numeric index against non-array returns undefined', () => {
    expect(resolveJsonPath(doc, '$.order[0]')).toBeUndefined();
  });

  test('string key against non-object returns undefined', () => {
    expect(resolveJsonPath('hello', '$.x')).toBeUndefined();
  });
});

describe('isJsonPath', () => {
  test('detects $-prefixed strings', () => {
    expect(isJsonPath('$.foo')).toBe(true);
    expect(isJsonPath('$')).toBe(true);
  });
  test('rejects non-paths', () => {
    expect(isJsonPath('foo')).toBe(false);
    expect(isJsonPath('')).toBe(false);
    expect(isJsonPath(42)).toBe(false);
    expect(isJsonPath(null)).toBe(false);
  });
});

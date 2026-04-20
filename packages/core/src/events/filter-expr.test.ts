import { describe, expect, test } from 'bun:test';
import { FilterExpressionError, evaluateFilter, parseFilterExpression } from './filter-expr.js';

describe('parseFilterExpression', () => {
  test('literals parse', () => {
    expect(parseFilterExpression('true')).toEqual({ kind: 'literal', value: true });
    expect(parseFilterExpression('false')).toEqual({ kind: 'literal', value: false });
    expect(parseFilterExpression('null')).toEqual({ kind: 'literal', value: null });
    expect(parseFilterExpression('42')).toEqual({ kind: 'literal', value: 42 });
    expect(parseFilterExpression('"hi"')).toEqual({ kind: 'literal', value: 'hi' });
    expect(parseFilterExpression("'hi'")).toEqual({ kind: 'literal', value: 'hi' });
  });

  test('jsonpath parses', () => {
    expect(parseFilterExpression('$.foo')).toEqual({ kind: 'jsonpath', path: '$.foo' });
    expect(parseFilterExpression('$.arr[0]')).toEqual({ kind: 'jsonpath', path: '$.arr[0]' });
  });

  test('comparison binary', () => {
    expect(parseFilterExpression('$.x > 5')).toEqual({
      kind: 'binary',
      op: '>',
      left: { kind: 'jsonpath', path: '$.x' },
      right: { kind: 'literal', value: 5 },
    });
  });

  test('and/or precedence (and binds tighter than or)', () => {
    const ast = parseFilterExpression('$.a or $.b and $.c');
    expect(ast).toEqual({
      kind: 'binary',
      op: 'or',
      left: { kind: 'jsonpath', path: '$.a' },
      right: {
        kind: 'binary',
        op: 'and',
        left: { kind: 'jsonpath', path: '$.b' },
        right: { kind: 'jsonpath', path: '$.c' },
      },
    });
  });

  test('not parses as unary prefix', () => {
    expect(parseFilterExpression('not $.x')).toEqual({
      kind: 'unary',
      op: 'not',
      operand: { kind: 'jsonpath', path: '$.x' },
    });
  });

  test('parentheses override precedence', () => {
    const ast = parseFilterExpression('($.a or $.b) and $.c');
    expect(ast.kind).toBe('binary');
    if (ast.kind === 'binary') {
      expect(ast.op).toBe('and');
    }
  });

  test('in with array literal', () => {
    const ast = parseFilterExpression('$.kind in ["a", "b", "c"]');
    expect(ast).toEqual({
      kind: 'in',
      value: { kind: 'jsonpath', path: '$.kind' },
      arr: [
        { kind: 'literal', value: 'a' },
        { kind: 'literal', value: 'b' },
        { kind: 'literal', value: 'c' },
      ],
    });
  });

  test('throws on trailing junk', () => {
    expect(() => parseFilterExpression('$.x 5')).toThrow(FilterExpressionError);
  });

  test('throws on empty expression', () => {
    expect(() => parseFilterExpression('')).toThrow('empty expression');
  });

  test('throws on unterminated string', () => {
    expect(() => parseFilterExpression('$.x == "abc')).toThrow('unterminated');
  });
});

describe('evaluateFilter', () => {
  test('simple equality', () => {
    expect(evaluateFilter('$.x == 5', { x: 5 })).toBe(true);
    expect(evaluateFilter('$.x == 5', { x: 6 })).toBe(false);
  });

  test('string equality', () => {
    expect(evaluateFilter('$.status == "active"', { status: 'active' })).toBe(true);
    expect(evaluateFilter('$.status == "active"', { status: 'paused' })).toBe(false);
  });

  test('numeric ordering', () => {
    expect(evaluateFilter('$.amount > 100', { amount: 150 })).toBe(true);
    expect(evaluateFilter('$.amount > 100', { amount: 100 })).toBe(false);
    expect(evaluateFilter('$.amount >= 100', { amount: 100 })).toBe(true);
    expect(evaluateFilter('$.amount < 100', { amount: 99 })).toBe(true);
    expect(evaluateFilter('$.amount <= 100', { amount: 100 })).toBe(true);
  });

  test('truthiness of a JSONPath ref', () => {
    expect(evaluateFilter('$.urgent', { urgent: true })).toBe(true);
    expect(evaluateFilter('$.urgent', { urgent: false })).toBe(false);
    expect(evaluateFilter('$.urgent', {})).toBe(false);
  });

  test('boolean combinators', () => {
    expect(evaluateFilter('$.a and $.b', { a: true, b: true })).toBe(true);
    expect(evaluateFilter('$.a and $.b', { a: true, b: false })).toBe(false);
    expect(evaluateFilter('$.a or $.b', { a: false, b: true })).toBe(true);
    expect(evaluateFilter('not $.a', { a: false })).toBe(true);
    expect(evaluateFilter('not $.a', { a: true })).toBe(false);
  });

  test('"in" membership', () => {
    expect(evaluateFilter('$.kind in ["x", "y"]', { kind: 'x' })).toBe(true);
    expect(evaluateFilter('$.kind in ["x", "y"]', { kind: 'z' })).toBe(false);
    expect(evaluateFilter('$.n in [1, 2, 3]', { n: 2 })).toBe(true);
  });

  test('numeric string coercion for ==', () => {
    expect(evaluateFilter('$.x == 42', { x: '42' })).toBe(true);
    expect(evaluateFilter('$.x == "42"', { x: 42 })).toBe(true);
  });

  test('comparisons against undefined are false', () => {
    expect(evaluateFilter('$.missing > 5', {})).toBe(false);
    expect(evaluateFilter('$.missing == 5', {})).toBe(false);
  });

  test('parenthesized precedence', () => {
    // ($.x > 0) or ($.y > 0) — either side true ⇒ true
    expect(evaluateFilter('($.x > 0) or ($.y > 0)', { x: -1, y: 10 })).toBe(true);
    expect(evaluateFilter('($.x > 0) or ($.y > 0)', { x: -1, y: -1 })).toBe(false);
  });

  test('real-world MQTT-style filter drops normal readings', () => {
    const expr = '$.temperature > 80 or $.humidity > 95 or $.vibration > 3.0';
    expect(evaluateFilter(expr, { temperature: 70, humidity: 50, vibration: 1.0 })).toBe(false);
    expect(evaluateFilter(expr, { temperature: 85, humidity: 50, vibration: 1.0 })).toBe(true);
    expect(evaluateFilter(expr, { temperature: 50, humidity: 50, vibration: 4.0 })).toBe(true);
  });
});

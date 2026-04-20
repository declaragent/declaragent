import { describe, expect, test } from 'bun:test';
import { compareSemver, parseSemver, satisfies } from './semver.js';

describe('parseSemver', () => {
  test('parses x.y.z', () => {
    expect(parseSemver('0.7.0')).toEqual([0, 7, 0]);
    expect(parseSemver('1.0.0')).toEqual([1, 0, 0]);
    expect(parseSemver('10.20.30')).toEqual([10, 20, 30]);
    expect(parseSemver('v1.2.3')).toEqual([1, 2, 3]);
  });
  test('rejects malformed', () => {
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('1.2.3-beta')).toBeNull();
    expect(parseSemver('latest')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });
});

describe('compareSemver', () => {
  test('basic ordering', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareSemver('1.1.0', '1.0.99')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });
  test('NaN on bad inputs', () => {
    expect(compareSemver('1.0', '1.0.0')).toBeNaN();
    expect(compareSemver('1.0.0', 'nope')).toBeNaN();
  });
});

describe('satisfies', () => {
  test('wildcard + empty accept anything', () => {
    expect(satisfies('1.2.3', '*')).toBe(true);
    expect(satisfies('1.2.3', '')).toBe(true);
    expect(satisfies('1.2.3', undefined)).toBe(true);
  });

  test('exact match', () => {
    expect(satisfies('1.2.3', '1.2.3')).toBe(true);
    expect(satisfies('1.2.3', '=1.2.3')).toBe(true);
    expect(satisfies('1.2.3', '1.2.4')).toBe(false);
  });

  test('>= and <=', () => {
    expect(satisfies('1.0.0', '>=1.0.0')).toBe(true);
    expect(satisfies('0.9.9', '>=1.0.0')).toBe(false);
    expect(satisfies('2.0.0', '>=1.0.0')).toBe(true);
    expect(satisfies('1.0.0', '<=1.0.0')).toBe(true);
    expect(satisfies('1.0.1', '<=1.0.0')).toBe(false);
  });

  test('> and <', () => {
    expect(satisfies('1.0.1', '>1.0.0')).toBe(true);
    expect(satisfies('1.0.0', '>1.0.0')).toBe(false);
    expect(satisfies('0.9.9', '<1.0.0')).toBe(true);
  });

  test('^ compatible-within-major (major > 0)', () => {
    expect(satisfies('1.2.3', '^1.0.0')).toBe(true);
    expect(satisfies('1.9.9', '^1.0.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfies('0.9.9', '^1.0.0')).toBe(false);
  });

  test('^ special-cased for 0.x.y (minor fixed)', () => {
    expect(satisfies('0.7.1', '^0.7.0')).toBe(true);
    expect(satisfies('0.7.9', '^0.7.0')).toBe(true);
    expect(satisfies('0.8.0', '^0.7.0')).toBe(false);
    expect(satisfies('0.6.9', '^0.7.0')).toBe(false);
  });

  test('~ patch-flexible', () => {
    expect(satisfies('1.2.3', '~1.2.3')).toBe(true);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('1.2.2', '~1.2.3')).toBe(false);
  });

  test('compound ranges (space-separated AND)', () => {
    expect(satisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfies('0.5.0', '>=1.0.0 <2.0.0')).toBe(false);
  });

  test('malformed range returns false', () => {
    expect(satisfies('1.2.3', 'nonsense')).toBe(false);
    expect(satisfies('1.2.3', '>')).toBe(false);
  });
});

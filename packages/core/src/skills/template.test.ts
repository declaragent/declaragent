import { describe, expect, test } from 'bun:test';
import { interpolate } from './template.js';
import { SkillTemplateError } from './types.js';

describe('interpolate', () => {
  test('substitutes simple {{var}} references', () => {
    expect(interpolate('hi {{who}}!', { who: 'world' })).toBe('hi world!');
  });

  test('handles whitespace inside braces', () => {
    expect(interpolate('a={{  x  }}', { x: 1 })).toBe('a=1');
  });

  test('resolves dotted paths', () => {
    expect(interpolate('{{user.name}}', { user: { name: 'ada' } })).toBe('ada');
  });

  test('booleans, numbers, null serialize predictably', () => {
    expect(interpolate('{{n}} {{b}} {{x}}', { n: 42, b: true, x: null })).toBe('42 true null');
  });

  test('objects/arrays serialize as JSON', () => {
    expect(interpolate('{{xs}}', { xs: [1, 2, 3] })).toBe('[1,2,3]');
  });

  test('throws on missing var by default, listing every missing name (deduped)', () => {
    let err: unknown;
    try {
      interpolate('{{alpha}} {{beta}} {{alpha}}', {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SkillTemplateError);
    const message = (err as Error).message;
    // Extract the comma-separated list after the colon and dedupe-check.
    const list = message
      .split(':')
      .slice(1)
      .join(':')
      .trim()
      .split(/\s*,\s*/);
    expect(list.sort()).toEqual(['alpha', 'beta']);
  });

  test('onMissing: empty replaces with ""', () => {
    expect(interpolate('[{{x}}]', {}, { onMissing: 'empty' })).toBe('[]');
  });

  test('onMissing: preserve leaves the placeholder intact', () => {
    expect(interpolate('[{{x}}]', {}, { onMissing: 'preserve' })).toBe('[{{x}}]');
  });

  test('does not match malformed placeholders', () => {
    expect(interpolate('{{ }}', {}, { onMissing: 'empty' })).toBe('{{ }}');
    expect(interpolate('{x}', { x: 1 })).toBe('{x}');
  });
});

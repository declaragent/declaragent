import { describe, expect, test } from 'bun:test';
import { BlockKitValidationError, validateBlockKit } from './block-kit-validator.js';

describe('validateBlockKit', () => {
  test('accepts a well-formed block set', () => {
    expect(() =>
      validateBlockKit([
        { type: 'header', text: { type: 'plain_text', text: 'Hello' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*body*' } },
        { type: 'divider' },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Yes' }, action_id: 'a1' },
          ],
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'ctx' }] },
        { type: 'image', image_url: 'https://i', alt_text: 'img' },
      ]),
    ).not.toThrow();
  });

  test('rejects an unsupported block type', () => {
    expect(() => validateBlockKit([{ type: 'unknown_thing' }])).toThrow(BlockKitValidationError);
  });

  test('flags section text length overruns with a path pointer', () => {
    try {
      validateBlockKit([{ type: 'section', text: { type: 'mrkdwn', text: 'x'.repeat(3001) } }]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockKitValidationError);
      const typed = err as BlockKitValidationError;
      expect(typed.path).toBe('blocks[0].text.text');
      expect(typed.message).toContain('exceeds 3000');
    }
  });

  test('rejects header with wrong text type', () => {
    expect(() =>
      validateBlockKit([{ type: 'header', text: { type: 'mrkdwn', text: 'bad' } }]),
    ).toThrow(/plain_text/);
  });

  test('rejects actions block with zero or too many buttons', () => {
    expect(() => validateBlockKit([{ type: 'actions', elements: [] }])).toThrow(/non-empty/);
    const six = Array.from({ length: 6 }, (_, i) => ({
      type: 'button',
      text: { type: 'plain_text', text: `b${i}` },
      action_id: `a${i}`,
    }));
    expect(() => validateBlockKit([{ type: 'actions', elements: six }])).toThrow(/exceeds 5/);
  });

  test('rejects button without action_id', () => {
    expect(() =>
      validateBlockKit([
        {
          type: 'actions',
          elements: [{ type: 'button', text: { type: 'plain_text', text: 'x' } }],
        },
      ]),
    ).toThrow(/action_id is required/);
  });

  test('rejects button with overlong text', () => {
    expect(() =>
      validateBlockKit([
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'x'.repeat(80) },
              action_id: 'a',
            },
          ],
        },
      ]),
    ).toThrow(/exceeds 75/);
  });

  test('rejects image with missing url', () => {
    expect(() => validateBlockKit([{ type: 'image', alt_text: 'x' }])).toThrow(/image_url/);
  });

  test('rejects top-level non-array', () => {
    // @ts-expect-error deliberately wrong type
    expect(() => validateBlockKit('nope')).toThrow(/must be an array/);
  });
});

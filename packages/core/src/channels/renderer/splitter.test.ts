import { describe, expect, test } from 'bun:test';
import { splitLongText } from './splitter.js';

describe('splitLongText', () => {
  test('returns the input unchanged when under the cap', () => {
    expect(splitLongText('short', { maxLen: 100 })).toEqual(['short']);
  });

  test('splits at paragraph boundaries when possible', () => {
    const text = `para one.\n\n${'x'.repeat(30)}\n\npara three.`;
    const chunks = splitLongText(text, { maxLen: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk carries the (k/N) suffix once split.
    expect(chunks.every((c) => /\(\d+\/\d+\)$/.test(c))).toBe(true);
  });

  test('appends (k/N) suffixes when split', () => {
    const para = 'x'.repeat(50);
    const text = `${para}\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = splitLongText(text, { maxLen: 80 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toMatch(/\(1\/\d+\)$/);
    const last = chunks[chunks.length - 1] as string;
    expect(last).toMatch(/\(\d+\/\d+\)$/);
  });

  test('keeps a fenced code block intact even when oversized', () => {
    const code = `\`\`\`\n${'X'.repeat(200)}\n\`\`\``;
    const text = `before.\n\n${code}\n\nafter.`;
    const chunks = splitLongText(text, { maxLen: 80 });
    // Find the chunk containing the fence; it should include both ``` delimiters.
    const withFence = chunks.find((c) => c.includes('```\nX'));
    expect(withFence).toBeDefined();
    expect((withFence as string).match(/```/g)?.length).toBe(2);
  });

  test('emits fence as its own chunk when oversized', () => {
    const code = `\`\`\`ts\n${'Y'.repeat(500)}\n\`\`\``;
    const chunks = splitLongText(code, { maxLen: 100 });
    // Exactly one of the resulting chunks must carry both opening + closing fences.
    const fenceChunks = chunks.filter((c) => c.includes('```') && c.split('```').length >= 3);
    expect(fenceChunks.length).toBe(1);
  });

  test('respects the suffix reserve so final length stays under maxLen', () => {
    const longLine = 'z'.repeat(120);
    const text = `${longLine}\n${longLine}\n${longLine}`;
    const chunks = splitLongText(text, { maxLen: 60 });
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(60);
    }
  });

  test('prefers line boundary when no paragraph split is available', () => {
    const line = `${'y'.repeat(10)}\n`;
    const text = line.repeat(12);
    const chunks = splitLongText(text, { maxLen: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    // At least one non-final chunk ends at a newline — confirms preference.
    const endsOnLine = chunks.slice(0, -1).some((c) => /\n ?\(\d+\/\d+\)$/.test(c));
    expect(endsOnLine).toBe(true);
  });

  test('falls through to hard cut when no whitespace exists', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const chunks = splitLongText(text, { maxLen: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk ≤ cap.
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
  });

  test('throws on non-positive maxLen', () => {
    expect(() => splitLongText('x', { maxLen: 0 })).toThrow();
    expect(() => splitLongText('x', { maxLen: -1 })).toThrow();
  });
});

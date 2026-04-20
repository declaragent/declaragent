import { describe, expect, test } from 'bun:test';
import { escapeMarkdownV2 } from './escape-markdown-v2.js';

describe('escapeMarkdownV2', () => {
  test('escapes every char in the outside-escape set', () => {
    const raw = '_*[]()~`>#+-=|{}.!';
    const out = escapeMarkdownV2(raw);
    // Each special char gets a leading backslash.
    for (const ch of raw) {
      if (ch === '`') continue; // `` ` `` opens an inline code context
      expect(out).toContain(`\\${ch}`);
    }
  });

  test('leaves plain alphanumerics untouched', () => {
    expect(escapeMarkdownV2('hello world 42')).toBe('hello world 42');
  });

  test('does not double-escape inside a fenced code block', () => {
    const raw = 'before\n```\nx.y.z\n```\nafter.';
    const out = escapeMarkdownV2(raw);
    // Dots inside the code fence should NOT be escaped…
    expect(out).toContain('x.y.z');
    // …while the dot in "after." should be escaped.
    expect(out).toContain('after\\.');
  });

  test('preserves the language tag on a fence', () => {
    const raw = '```ts\nconst x = 1;\n```';
    const out = escapeMarkdownV2(raw);
    expect(out).toContain('```ts');
    expect(out).toContain('const x = 1;');
    // Triple-backtick closer stays intact.
    expect(out.endsWith('```')).toBe(true);
  });

  test('escapes backslashes and backticks inside code', () => {
    const raw = '```\na\\b`c\n```';
    const out = escapeMarkdownV2(raw);
    expect(out).toContain('a\\\\b\\`c');
  });

  test('handles inline code spans correctly', () => {
    const raw = 'call `x.y(.z)` now.';
    const out = escapeMarkdownV2(raw);
    expect(out).toContain('`x.y(.z)`');
    expect(out).toContain('now\\.');
  });

  test('treats an unbalanced fence as outside text', () => {
    const raw = 'prefix ``` unterminated';
    const out = escapeMarkdownV2(raw);
    // Every backtick is escaped since we fell back to outside mode.
    expect(out).toContain('\\`\\`\\`');
  });

  test('treats an unbalanced inline code span as outside text', () => {
    const raw = 'x `unclosed';
    const out = escapeMarkdownV2(raw);
    expect(out).toContain('\\`unclosed');
  });

  test('escapes a literal backslash outside code', () => {
    expect(escapeMarkdownV2('a\\b')).toBe('a\\\\b');
  });

  test('handles multiple fenced blocks in one message', () => {
    const raw = 'p1.\n```\nA.B\n```\nmiddle!\n```\nX.Y\n```\ntail?';
    const out = escapeMarkdownV2(raw);
    expect(out).toContain('p1\\.');
    expect(out).toContain('middle\\!');
    expect(out).toContain('A.B');
    expect(out).toContain('X.Y');
    expect(out).toContain('tail?');
  });

  test('fuzz: escaped form never contains a bare special char outside a code span', () => {
    const specialSet = new Set<string>([
      '_',
      '*',
      '[',
      ']',
      '(',
      ')',
      '~',
      '>',
      '#',
      '+',
      '-',
      '=',
      '|',
      '{',
      '}',
      '.',
      '!',
    ]);
    const alphabet = `ab \n${[...specialSet].join('')}\`\\`;
    for (let trial = 0; trial < 500; trial++) {
      let raw = '';
      const len = 1 + Math.floor(Math.random() * 30);
      for (let i = 0; i < len; i++) {
        raw += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      const out = escapeMarkdownV2(raw);
      // Walk the escaped string and ensure every special char is preceded
      // by a backslash OR lives inside a fenced/inline code region.
      let i = 0;
      let insideCode = false;
      let insideFence = false;
      while (i < out.length) {
        if (out.startsWith('```', i)) {
          insideFence = !insideFence;
          i += 3;
          continue;
        }
        const ch = out[i] as string;
        if (ch === '\\') {
          // Skip the escaped character.
          i += 2;
          continue;
        }
        if (ch === '`' && !insideFence) {
          insideCode = !insideCode;
          i += 1;
          continue;
        }
        if (!insideFence && !insideCode && specialSet.has(ch)) {
          throw new Error(
            `raw=${JSON.stringify(raw)} produced unescaped '${ch}' at ${i}: ${JSON.stringify(out)}`,
          );
        }
        i += 1;
      }
    }
  });
});

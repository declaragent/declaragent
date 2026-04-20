/**
 * Telegram Bot API's MarkdownV2 parse mode is strict: outside code blocks
 * every one of `_ * [ ] ( ) ~ \` > # + - = | { } . !` must be backslash-
 * escaped. Inside a fenced code block only `` ` `` and `\` need escaping.
 * A naive regex replace over the full string double-escapes inside code;
 * this module walks the string as a tiny fence-aware AST instead.
 *
 * See https://core.telegram.org/bots/api#markdownv2-style.
 */

/**
 * Chars that must be escaped outside code blocks. Order matters only
 * insofar as `\\` has to stay last so we don't double-escape our own
 * escapes.
 */
const OUTSIDE_ESCAPES = new Set<string>([
  '_',
  '*',
  '[',
  ']',
  '(',
  ')',
  '~',
  '`',
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

/** Chars that must be escaped inside a code span / code block. */
const INSIDE_CODE_ESCAPES = new Set<string>(['\\', '`']);

/**
 * Escape `raw` for safe inclusion in a MarkdownV2 message body. Handles
 * three zones:
 *   - Outside code: full escape set above.
 *   - Inline code (single backticks): escape only `\` and `` ` ``.
 *   - Fenced code blocks (triple backticks, optional language tag):
 *     escape only `\` and `` ` ``; the tag line passes through unchanged.
 *
 * Unbalanced fences and inline-code markers fall back to "treat as outside
 * text from the unmatched point to end-of-string". That produces a valid
 * (but degraded) MarkdownV2 body rather than a 400 from Telegram.
 */
export function escapeMarkdownV2(raw: string): string {
  const out: string[] = [];
  let i = 0;
  const len = raw.length;
  while (i < len) {
    // Fenced code block: ``` ... ``` (possibly multi-line, optional lang)
    if (raw.startsWith('```', i)) {
      const fenceEnd = raw.indexOf('```', i + 3);
      if (fenceEnd < 0) {
        // Unbalanced fence — escape the opening backticks + remainder as text.
        out.push(escapeOutside(raw.slice(i)));
        break;
      }
      const inner = raw.slice(i + 3, fenceEnd);
      out.push('```');
      out.push(escapeInsideCode(inner));
      out.push('```');
      i = fenceEnd + 3;
      continue;
    }
    // Inline code: `...`
    if (raw[i] === '`') {
      const closing = raw.indexOf('`', i + 1);
      if (closing < 0) {
        out.push(escapeOutside(raw.slice(i)));
        break;
      }
      out.push('`');
      out.push(escapeInsideCode(raw.slice(i + 1, closing)));
      out.push('`');
      i = closing + 1;
      continue;
    }
    // Outside code: chunk until the next backtick and escape.
    const nextTick = raw.indexOf('`', i);
    const stop = nextTick < 0 ? len : nextTick;
    out.push(escapeOutside(raw.slice(i, stop)));
    i = stop;
  }
  return out.join('');
}

function escapeOutside(segment: string): string {
  const parts: string[] = [];
  for (const ch of segment) {
    if (OUTSIDE_ESCAPES.has(ch) || ch === '\\') parts.push('\\');
    parts.push(ch);
  }
  return parts.join('');
}

function escapeInsideCode(segment: string): string {
  const parts: string[] = [];
  for (const ch of segment) {
    if (INSIDE_CODE_ESCAPES.has(ch)) parts.push('\\');
    parts.push(ch);
  }
  return parts.join('');
}

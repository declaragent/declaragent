/**
 * Long-message splitter.
 *
 * Each platform caps the body length of a single message:
 *   Telegram 4096, WhatsApp 4096, Slack 40000, Discord 2000.
 *
 * The splitter preserves two invariants:
 *   1. Fenced code blocks (triple backticks) are never fragmented across
 *      chunks — fragmenting mid-fence produces unrenderable output.
 *   2. Paragraph boundaries are preferred over line boundaries, which are
 *      preferred over word boundaries, which fall back to a hard cut.
 *
 * Each chunk is suffixed with `(k/N)` when more than one is produced so
 * users see continuation context. The cap budgets the suffix length
 * (worst case: 12 chars for `(100/100)`) so the final string stays under
 * `maxLen`.
 */

export interface SplitOptions {
  /** Hard cap per chunk including suffix. */
  maxLen: number;
  /**
   * Reserve this many chars for the `(k/N)` suffix. Default: 12 (worst
   * case 3-digit counts). Callers that know N < 10 can pass 8.
   */
  suffixReserve?: number;
}

const DEFAULT_SUFFIX_RESERVE = 12;

export function splitLongText(text: string, options: SplitOptions): string[] {
  const maxLen = options.maxLen;
  if (maxLen <= 0) throw new Error(`splitLongText: maxLen must be > 0 (got ${maxLen})`);
  const suffixReserve = options.suffixReserve ?? DEFAULT_SUFFIX_RESERVE;
  if (text.length <= maxLen) return [text];

  const budget = Math.max(1, maxLen - suffixReserve);
  const segments = segmentPreservingFences(text);

  interface Unit {
    text: string;
    /** When true, emit as its own chunk even if oversized. */
    oversized: boolean;
  }

  const units: Unit[] = [];
  for (const seg of segments) {
    if (seg.kind === 'fence') {
      units.push({ text: seg.text, oversized: seg.text.length > budget });
      continue;
    }
    // Text segment: break at paragraph > line > word > hard-cut so every
    // unit either fits the budget or is explicitly oversized.
    for (const para of splitKeepingSeparator(seg.text, '\n\n')) {
      if (para.length <= budget) {
        units.push({ text: para, oversized: false });
        continue;
      }
      for (const line of splitKeepingSeparator(para, '\n')) {
        if (line.length <= budget) {
          units.push({ text: line, oversized: false });
          continue;
        }
        for (const word of splitKeepingSeparator(line, ' ')) {
          if (word.length <= budget) {
            units.push({ text: word, oversized: false });
            continue;
          }
          // Hard-cut fallback.
          for (let j = 0; j < word.length; j += budget) {
            units.push({ text: word.slice(j, j + budget), oversized: false });
          }
        }
      }
    }
  }

  // Greedy pack.
  const chunks: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
  };
  for (const u of units) {
    if (u.oversized) {
      flush();
      chunks.push(u.text);
      continue;
    }
    if (buf.length > 0 && buf.length + u.text.length > budget) {
      flush();
    }
    buf += u.text;
  }
  flush();

  if (chunks.length === 1) return chunks;
  const n = chunks.length;
  return chunks.map((c, i) => `${c} (${i + 1}/${n})`);
}

interface TextSegment {
  kind: 'text';
  text: string;
}
interface FenceSegment {
  kind: 'fence';
  text: string;
}
type Segment = TextSegment | FenceSegment;

/**
 * Partition the input into alternating text and fenced-code segments.
 * An unbalanced fence is treated as plain text for splitting purposes —
 * we'd rather fragment malformed code than drop content.
 */
function segmentPreservingFences(text: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    const fenceStart = text.indexOf('```', i);
    if (fenceStart < 0) {
      out.push({ kind: 'text', text: text.slice(i) });
      break;
    }
    if (fenceStart > i) out.push({ kind: 'text', text: text.slice(i, fenceStart) });
    const fenceEnd = text.indexOf('```', fenceStart + 3);
    if (fenceEnd < 0) {
      out.push({ kind: 'text', text: text.slice(fenceStart) });
      break;
    }
    out.push({ kind: 'fence', text: text.slice(fenceStart, fenceEnd + 3) });
    i = fenceEnd + 3;
  }
  return out;
}

/**
 * Split `text` on `separator` while keeping the separator attached to
 * the preceding unit. Guarantees reassembly by `unit.join('')` equals
 * the original input.
 */
function splitKeepingSeparator(text: string, separator: string): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const next = text.indexOf(separator, cursor);
    if (next < 0) {
      out.push(text.slice(cursor));
      break;
    }
    out.push(text.slice(cursor, next + separator.length));
    cursor = next + separator.length;
  }
  return out;
}

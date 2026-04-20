import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_MAX_ENTRIES, appendHistory, loadHistory } from './history.js';

describe('history', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-history-'));
    path = join(dir, 'history.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('loadHistory returns empty when file is missing', () => {
    expect(loadHistory(path)).toEqual([]);
  });

  test('appendHistory writes JSONL and loadHistory reads back', () => {
    appendHistory('first', path);
    appendHistory('second', path);
    expect(loadHistory(path)).toEqual(['first', 'second']);
  });

  test('appendHistory ignores empty/whitespace entries', () => {
    appendHistory('', path);
    appendHistory('   ', path);
    expect(loadHistory(path)).toEqual([]);
  });

  test('loadHistory tolerates malformed lines', () => {
    writeFileSync(path, ['"valid"', 'not-json', '"also valid"', ''].join('\n'));
    expect(loadHistory(path)).toEqual(['valid', 'also valid']);
  });

  test('caps to HISTORY_MAX_ENTRIES on load', () => {
    const lines: string[] = [];
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 50; i += 1) {
      lines.push(JSON.stringify(`entry-${i}`));
    }
    writeFileSync(path, lines.join('\n'));
    const loaded = loadHistory(path);
    expect(loaded.length).toBe(HISTORY_MAX_ENTRIES);
    expect(loaded[loaded.length - 1]).toBe(`entry-${HISTORY_MAX_ENTRIES + 49}`);
  });

  test('round-trips multi-line entries', () => {
    appendHistory('line one\nline two', path);
    expect(loadHistory(path)).toEqual(['line one\nline two']);
    expect(readFileSync(path, 'utf8')).toContain('\\n');
  });
});

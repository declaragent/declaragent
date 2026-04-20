import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { historyFilePath } from './paths.js';

export const HISTORY_MAX_ENTRIES = 1000;

/**
 * Persistent input history. JSONL on disk, one entry per line. Loaded once
 * at REPL startup; new submissions append immediately so a crash doesn't
 * lose history.
 */
export function loadHistory(path = historyFilePath()): string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const parsed: string[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as unknown;
        if (typeof value === 'string') parsed.push(value);
      } catch {
        // Skip malformed lines silently.
      }
    }
    return parsed.slice(-HISTORY_MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function appendHistory(entry: string, path = historyFilePath()): void {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return;
  try {
    appendFileSync(path, `${JSON.stringify(trimmed)}\n`, 'utf8');
  } catch {
    // Non-fatal — losing one history entry is fine.
  }
}

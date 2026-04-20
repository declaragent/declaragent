import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceAdd, sourceList, sourceRemove } from './source-cli.js';

function tmpConfig(initial?: unknown): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'declaragent-source-cli-'));
  const path = join(dir, 'event-sources.json');
  if (initial !== undefined) {
    writeFileSync(path, JSON.stringify(initial, null, 2), 'utf-8');
  }
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function captureIO(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
  };
}

describe('sourceList', () => {
  test('prints "no sources" when the file is absent', async () => {
    const { path, cleanup } = tmpConfig();
    try {
      const { out, io } = captureIO();
      const code = await sourceList({ io, configPath: path });
      expect(code).toBe(0);
      expect(out.join('')).toContain('no sources configured');
    } finally {
      cleanup();
    }
  });

  test('lists existing sources by "<type>:<id>"', async () => {
    const { path, cleanup } = tmpConfig([
      { type: 'cron', config: { id: 'daily', schedule: '0 9 * * *' } },
      { type: 'webhook', config: { id: 'gh-pr' } },
    ]);
    try {
      const { out, io } = captureIO();
      const code = await sourceList({ io, configPath: path });
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('cron:daily');
      expect(text).toContain('webhook:gh-pr');
    } finally {
      cleanup();
    }
  });
});

describe('sourceAdd', () => {
  test('creates the config file with the new source', async () => {
    const { path, cleanup } = tmpConfig();
    try {
      const { out, io } = captureIO();
      const code = await sourceAdd(
        {
          type: 'cron',
          id: 'morning',
          configJson: '{"schedule":"0 9 * * 1-5","target":{"type":"broadcast"}}',
        },
        { io, configPath: path },
      );
      expect(code).toBe(0);
      expect(out.join('')).toContain('cron:morning');

      const saved = JSON.parse(readFileSync(path, 'utf-8'));
      expect(saved).toHaveLength(1);
      expect(saved[0].type).toBe('cron');
      expect(saved[0].config.id).toBe('morning');
      expect(saved[0].config.schedule).toBe('0 9 * * 1-5');
    } finally {
      cleanup();
    }
  });

  test('rejects duplicate keys', async () => {
    const { path, cleanup } = tmpConfig([
      { type: 'cron', config: { id: 'morning', schedule: '0 9 * * *' } },
    ]);
    try {
      const { err, io } = captureIO();
      const code = await sourceAdd(
        {
          type: 'cron',
          id: 'morning',
          configJson: '{"schedule":"0 10 * * *"}',
        },
        { io, configPath: path },
      );
      expect(code).toBe(1);
      expect(err.join('')).toContain('already exists');
    } finally {
      cleanup();
    }
  });

  test('rejects config.id that contradicts the <id> argument', async () => {
    const { path, cleanup } = tmpConfig();
    try {
      const { err, io } = captureIO();
      const code = await sourceAdd(
        {
          type: 'cron',
          id: 'morning',
          configJson: '{"id":"evening","schedule":"0 10 * * *"}',
        },
        { io, configPath: path },
      );
      expect(code).toBe(1);
      expect(err.join('')).toContain('must match');
    } finally {
      cleanup();
    }
  });

  test('requires either --config or --config-file', async () => {
    const { path, cleanup } = tmpConfig();
    try {
      const { err, io } = captureIO();
      const code = await sourceAdd({ type: 'cron', id: 'x' }, { io, configPath: path });
      expect(code).toBe(1);
      expect(err.join('')).toContain('provide either');
    } finally {
      cleanup();
    }
  });
});

describe('sourceRemove', () => {
  test('removes by "<type>:<id>"', async () => {
    const { path, cleanup } = tmpConfig([
      { type: 'cron', config: { id: 'morning' } },
      { type: 'webhook', config: { id: 'gh' } },
    ]);
    try {
      const { out, io } = captureIO();
      const code = await sourceRemove('cron:morning', { io, configPath: path });
      expect(code).toBe(0);
      expect(out.join('')).toContain('cron:morning');

      const saved = JSON.parse(readFileSync(path, 'utf-8'));
      expect(saved).toHaveLength(1);
      expect(saved[0].type).toBe('webhook');
    } finally {
      cleanup();
    }
  });

  test('removes by bare id when unambiguous', async () => {
    const { path, cleanup } = tmpConfig([{ type: 'cron', config: { id: 'morning' } }]);
    try {
      const { out, io } = captureIO();
      const code = await sourceRemove('morning', { io, configPath: path });
      expect(code).toBe(0);
      expect(out.join('')).toContain('cron:morning');
    } finally {
      cleanup();
    }
  });

  test('rejects ambiguous bare id', async () => {
    const { path, cleanup } = tmpConfig([
      { type: 'cron', config: { id: 'dup' } },
      { type: 'webhook', config: { id: 'dup' } },
    ]);
    try {
      const { err, io } = captureIO();
      const code = await sourceRemove('dup', { io, configPath: path });
      expect(code).toBe(1);
      expect(err.join('')).toContain('ambiguous');
    } finally {
      cleanup();
    }
  });

  test('reports when the key is not configured', async () => {
    const { path, cleanup } = tmpConfig([{ type: 'cron', config: { id: 'morning' } }]);
    try {
      const { err, io } = captureIO();
      const code = await sourceRemove('missing', { io, configPath: path });
      expect(code).toBe(1);
      expect(err.join('')).toContain('no source matches');
    } finally {
      cleanup();
    }
  });
});

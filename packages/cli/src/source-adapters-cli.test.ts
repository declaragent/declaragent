import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceAdaptersList } from './source-adapters-cli.js';

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

function installPackage(root: string, name: string, type: string): string {
  const dir = join(root, 'node_modules', '@declaragent', `source-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@declaragent/source-${name}`,
      version: '0.2.0',
      main: 'index.js',
      type: 'module',
      declaragent: { kind: 'event-source-adapter', type, agent_compat: '*' },
    }),
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export default {
  type: ${JSON.stringify(type)},
  validateConfig() {},
  async create() {
    return {
      id: 'x', type: ${JSON.stringify(type)},
      async start(){}, async stop(){}, async pause(){}, async resume(){},
      async health(){ return { status: 'healthy' }; },
      metrics(){ return { eventsPublished: 0, lastEventAt: null }; },
    };
  },
};
`,
  );
  return dir;
}

function tmpRoot(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-cli-sa-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe('sourceAdaptersList', () => {
  test('prints "no adapter packages" when nothing is installed', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      const { out, io } = captureIO();
      const code = await sourceAdaptersList({
        io,
        searchPaths: [path],
        coreVersion: '0.7.0',
      });
      expect(code).toBe(0);
      expect(out.join('')).toContain('no adapter packages');
    } finally {
      cleanup();
    }
  });

  test('lists installed adapters with package info', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installPackage(path, 'alpha', 'alpha');
      installPackage(path, 'beta', 'beta');
      const { out, io } = captureIO();
      const code = await sourceAdaptersList({
        io,
        searchPaths: [path],
        coreVersion: '0.7.0',
      });
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('adapters (2)');
      expect(text).toContain('alpha');
      expect(text).toContain('beta');
      expect(text).toContain('@declaragent/source-alpha@0.2.0');
    } finally {
      cleanup();
    }
  });

  test('returns 1 with error on discovery failure (duplicate types)', async () => {
    const { path, cleanup } = tmpRoot();
    try {
      installPackage(path, 'kafka-a', 'kafka');
      installPackage(path, 'kafka-b', 'kafka');
      const { err, io } = captureIO();
      const code = await sourceAdaptersList({
        io,
        searchPaths: [path],
        coreVersion: '0.7.0',
      });
      expect(code).toBe(1);
      expect(err.join('')).toContain('claimed by two packages');
    } finally {
      cleanup();
    }
  });
});

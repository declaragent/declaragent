import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventSourceAdapter,
  EventSourceInstance,
  SourceDependencies,
} from '@declaragent/core';
import { eventsConfigValidate } from './events-config-cli.js';

function tmpDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-events-config-cli-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
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

function fakeAdapter(type: string, validate: (cfg: unknown) => void): EventSourceAdapter<unknown> {
  return {
    type,
    validateConfig(cfg: unknown) {
      validate(cfg);
    },
    async create(): Promise<EventSourceInstance> {
      // Unused in validate-only paths.
      throw new Error('unreachable');
    },
  } satisfies EventSourceAdapter<unknown> & {
    create: (config: unknown, deps: SourceDependencies) => Promise<EventSourceInstance>;
  };
}

describe('eventsConfigValidate', () => {
  test('reports ✓ for a valid YAML config with secret substitution', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.yaml');
      writeFileSync(
        file,
        `- type: kafka
  config:
    id: orders
    bootstrap: \${env:KAFKA_BOOT}
`,
        'utf-8',
      );
      const { out, io } = captureIO();
      const code = await eventsConfigValidate(
        { path: file },
        {
          io,
          env: { KAFKA_BOOT: 'broker:9092' },
          adapters: {
            kafka: fakeAdapter('kafka', (cfg) => {
              const c = cfg as { bootstrap?: string };
              if (c.bootstrap !== 'broker:9092') throw new Error('bootstrap wrong');
            }),
          },
        },
      );
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('loaded 1 source');
      expect(text).toContain('YAML');
      expect(text).toContain('config is valid');
    } finally {
      cleanup();
    }
  });

  test('non-zero exit + prints error for unset env var', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.yaml');
      writeFileSync(
        file,
        `- type: kafka
  config:
    id: k
    secret: \${env:DEFINITELY_MISSING}
`,
        'utf-8',
      );
      const { err, io } = captureIO();
      const code = await eventsConfigValidate({ path: file }, { io, env: {}, adapters: {} });
      expect(code).toBe(1);
      expect(err.join('')).toContain('DEFINITELY_MISSING');
    } finally {
      cleanup();
    }
  });

  test('non-zero exit + surfaces malformed YAML error', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'bad.yaml');
      writeFileSync(file, '- type: kafka\n  config: [unterminated', 'utf-8');
      const { err, io } = captureIO();
      const code = await eventsConfigValidate({ path: file }, { io, adapters: {} });
      expect(code).toBe(1);
      expect(err.join('')).toMatch(/malformed YAML/);
    } finally {
      cleanup();
    }
  });

  test('adapter-level validation failures are collected and surface non-zero exit', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.json');
      writeFileSync(
        file,
        JSON.stringify([
          { type: 'kafka', config: { id: 'k' } },
          { type: 'unknown', config: {} },
        ]),
        'utf-8',
      );
      const { out, err, io } = captureIO();
      const code = await eventsConfigValidate(
        { path: file },
        {
          io,
          adapters: {
            kafka: fakeAdapter('kafka', () => {
              throw new Error('kafka: missing brokers');
            }),
          },
        },
      );
      expect(code).toBe(1);
      // Unknown types logged as informational (to stdout via `out`)
      expect(out.join('')).toContain('unknown types');
      expect(out.join('')).toContain('type="unknown"');
      // Semantic errors go to stderr.
      expect(err.join('')).toContain('kafka: missing brokers');
    } finally {
      cleanup();
    }
  });

  test('error when explicit path does not exist', async () => {
    const { err, io } = captureIO();
    const code = await eventsConfigValidate(
      { path: '/tmp/declaragent-missing-file.yaml' },
      { io, adapters: {} },
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('no event-sources config');
  });
});

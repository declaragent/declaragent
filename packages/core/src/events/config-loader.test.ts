import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventSourcesConfigError,
  loadEventSourcesConfig,
  validateEventSourcesConfig,
} from './config-loader.js';

function tmpDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-config-loader-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

function fakeAdapter(validate: (cfg: unknown) => void): { validateConfig: (cfg: unknown) => void } {
  return { validateConfig: validate };
}

describe('loadEventSourcesConfig — JSON', () => {
  test('reads a valid JSON array', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.json');
      writeFileSync(file, JSON.stringify([{ type: 'kafka', config: { id: 'k' } }]), 'utf-8');
      const out = await loadEventSourcesConfig({ path: file });
      expect(out.format).toBe('json');
      expect(out.sources).toEqual([{ type: 'kafka', config: { id: 'k' } }]);
    } finally {
      cleanup();
    }
  });

  test('malformed JSON surfaces as EventSourcesConfigError', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'bad.json');
      writeFileSync(file, '{ not valid json }', 'utf-8');
      await expect(loadEventSourcesConfig({ path: file })).rejects.toThrow(EventSourcesConfigError);
    } finally {
      cleanup();
    }
  });

  test('top-level non-array rejected', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'obj.json');
      writeFileSync(file, JSON.stringify({ not: 'an array' }), 'utf-8');
      await expect(loadEventSourcesConfig({ path: file })).rejects.toThrow(/array/);
    } finally {
      cleanup();
    }
  });

  test('entry without type is rejected with an index-based message', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'mix.json');
      writeFileSync(
        file,
        JSON.stringify([{ type: 'kafka', config: {} }, { config: { id: 'bad' } }]),
        'utf-8',
      );
      await expect(loadEventSourcesConfig({ path: file })).rejects.toThrow(/entry\[1\]\.type/);
    } finally {
      cleanup();
    }
  });
});

describe('loadEventSourcesConfig — YAML', () => {
  test('reads a valid YAML array', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.yaml');
      writeFileSync(
        file,
        `- type: kafka
  config:
    id: k
    transport:
      brokers:
        - localhost:9092
- type: webhook
  config:
    id: gh
`,
        'utf-8',
      );
      const out = await loadEventSourcesConfig({ path: file });
      expect(out.format).toBe('yaml');
      expect(out.sources).toHaveLength(2);
      expect(out.sources[0]?.type).toBe('kafka');
      expect(
        (out.sources[0]?.config as { transport: { brokers: string[] } }).transport.brokers[0],
      ).toBe('localhost:9092');
      expect(out.sources[1]?.type).toBe('webhook');
    } finally {
      cleanup();
    }
  });

  test('malformed YAML surfaces as EventSourcesConfigError', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'bad.yaml');
      writeFileSync(file, '- type: kafka\n  config:\n   id: x\n    bad: [unclosed', 'utf-8');
      await expect(loadEventSourcesConfig({ path: file })).rejects.toThrow(EventSourcesConfigError);
    } finally {
      cleanup();
    }
  });

  test('.yml extension also recognized as YAML', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'sources.yml');
      writeFileSync(file, '- type: cron\n  config:\n    id: c\n', 'utf-8');
      const out = await loadEventSourcesConfig({ path: file });
      expect(out.format).toBe('yaml');
    } finally {
      cleanup();
    }
  });
});

describe('loadEventSourcesConfig — secret substitution', () => {
  test('substitutes ${env:X} inside YAML values', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.yaml');
      writeFileSync(
        file,
        `- type: kafka
  config:
    id: k
    username: \${env:KAFKA_USER}
    password: \${env:KAFKA_PASS}
`,
        'utf-8',
      );
      const out = await loadEventSourcesConfig({
        path: file,
        secretResolver: { env: { KAFKA_USER: 'alice', KAFKA_PASS: 'wonder' } },
      });
      const cfg = out.sources[0]?.config as { username: string; password: string };
      expect(cfg.username).toBe('alice');
      expect(cfg.password).toBe('wonder');
    } finally {
      cleanup();
    }
  });

  test('unset env var produces a clear error pointing at the entry', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.yaml');
      writeFileSync(
        file,
        `- type: kafka
  config:
    id: k
    password: \${env:DEFINITELY_NOT_SET}
`,
        'utf-8',
      );
      await expect(
        loadEventSourcesConfig({
          path: file,
          secretResolver: { env: {} },
        }),
      ).rejects.toThrow(/entry\[0\].*DEFINITELY_NOT_SET/);
    } finally {
      cleanup();
    }
  });

  test('file: references resolve relative to the config directory', async () => {
    const { path, cleanup } = tmpDir();
    try {
      writeFileSync(join(path, 'token'), 'secret-token\n', 'utf-8');
      const file = join(path, 'event-sources.yaml');
      writeFileSync(
        file,
        `- type: webhook
  config:
    id: gh
    token: \${file:token}
`,
        'utf-8',
      );
      const out = await loadEventSourcesConfig({ path: file });
      const cfg = out.sources[0]?.config as { token: string };
      expect(cfg.token).toBe('secret-token');
    } finally {
      cleanup();
    }
  });
});

describe('validateEventSourcesConfig', () => {
  test('returns errors for entries whose adapter rejects the config', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.json');
      writeFileSync(
        file,
        JSON.stringify([
          { type: 'kafka', config: { id: 'k' } }, // invalid per our fake validator
          { type: 'webhook', config: { id: 'gh' } }, // valid
          { type: 'unknown', config: {} }, // not in the adapter map
        ]),
        'utf-8',
      );
      const report = await validateEventSourcesConfig({
        path: file,
        adapters: {
          kafka: fakeAdapter(() => {
            throw new Error('kafka: missing brokers');
          }),
          webhook: fakeAdapter(() => {
            // accepts anything
          }),
        },
      });
      expect(report.errors).toEqual([
        { index: 0, type: 'kafka', message: 'kafka: missing brokers' },
      ]);
      expect(report.unknownTypes).toEqual([{ index: 2, type: 'unknown' }]);
    } finally {
      cleanup();
    }
  });

  test('empty adapter map reports every entry as unknown', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const file = join(path, 'event-sources.json');
      writeFileSync(file, JSON.stringify([{ type: 'kafka', config: {} }]), 'utf-8');
      const report = await validateEventSourcesConfig({ path: file });
      expect(report.unknownTypes).toEqual([{ index: 0, type: 'kafka' }]);
      expect(report.errors).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('round-trips a multi-source YAML + secret config end-to-end', async () => {
    const { path, cleanup } = tmpDir();
    try {
      writeFileSync(join(path, 'token'), 'file-token', 'utf-8');
      const file = join(path, 'event-sources.yaml');
      writeFileSync(
        file,
        `- type: kafka
  config:
    id: orders
    bootstrap: \${env:KAFKA_BOOT}
- type: webhook
  config:
    id: gh
    secret: \${file:token}
`,
        'utf-8',
      );
      const report = await validateEventSourcesConfig({
        path: file,
        secretResolver: { env: { KAFKA_BOOT: 'broker:9092' } },
        adapters: {
          kafka: fakeAdapter((c) => {
            const cfg = c as { bootstrap?: string };
            if (cfg.bootstrap !== 'broker:9092') throw new Error('bootstrap wrong');
          }),
          webhook: fakeAdapter((c) => {
            const cfg = c as { secret?: string };
            if (cfg.secret !== 'file-token') throw new Error('secret wrong');
          }),
        },
      });
      expect(report.errors).toEqual([]);
      expect(report.unknownTypes).toEqual([]);
      expect(report.sources).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

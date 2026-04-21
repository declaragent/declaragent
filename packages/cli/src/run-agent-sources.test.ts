import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentSources } from './run-agent-sources.js';

const VALID_FILE_WATCH = `
- type: file-watch
  config:
    id: contracts-inbox
    paths:
      - {{INBOX}}/*.txt
    target:
      kind: skill
      name: extract
`;

const VALID_CRON = `
- type: cron
  config:
    id: morning-poke
    schedule: "0 9 * * *"
    target:
      kind: skill
      name: daily
`;

const UNKNOWN_TYPE = `
- type: kafka
  config:
    id: orders
    brokers: ["localhost:9092"]
    topic: orders
    target:
      kind: skill
      name: handle
`;

const INVALID_FILE_WATCH = `
- type: file-watch
  config:
    # missing required "paths" array
    id: bad
    target:
      kind: skill
      name: noop
`;

describe('startAgentSources', () => {
  let dir: string;
  let storePath: string;
  let sourcesPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-run-sources-'));
    storePath = join(dir, 'sessions.db');
    sourcesPath = join(dir, 'event-sources.yaml');
    mkdirSync(join(dir, 'inbox'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('starts a file-watch source + stops cleanly', async () => {
    writeFileSync(sourcesPath, VALID_FILE_WATCH.replace('{{INBOX}}', join(dir, 'inbox')));
    const res = await startAgentSources({ configPath: sourcesPath, storePath });
    expect(res.started).toHaveLength(1);
    expect(res.started[0]?.type).toBe('file-watch');
    expect(res.started[0]?.summary).toContain('file-watch');
    expect(res.unknownTypes).toHaveLength(0);
    expect(res.validationErrors).toHaveLength(0);
    await res.stop();
  });

  test('starts a cron source without binding anything external', async () => {
    writeFileSync(sourcesPath, VALID_CRON);
    const res = await startAgentSources({ configPath: sourcesPath, storePath });
    expect(res.started).toHaveLength(1);
    expect(res.started[0]?.type).toBe('cron');
    expect(res.started[0]?.summary).toContain('0 9 * * *');
    await res.stop();
  });

  test('skips unknown (external-broker) source types without failing', async () => {
    writeFileSync(sourcesPath, UNKNOWN_TYPE);
    const res = await startAgentSources({ configPath: sourcesPath, storePath });
    expect(res.started).toEqual([]);
    expect(res.unknownTypes).toHaveLength(1);
    expect(res.unknownTypes[0]?.type).toBe('kafka');
    await res.stop();
  });

  test('throws when adapter-level validation fails', async () => {
    writeFileSync(sourcesPath, INVALID_FILE_WATCH);
    await expect(startAgentSources({ configPath: sourcesPath, storePath })).rejects.toThrow(
      /validation failed/,
    );
  });

  test('multiple sources all start + stop', async () => {
    writeFileSync(
      sourcesPath,
      `${VALID_FILE_WATCH.replace('{{INBOX}}', join(dir, 'inbox'))}${VALID_CRON}`,
    );
    const res = await startAgentSources({ configPath: sourcesPath, storePath });
    expect(res.started).toHaveLength(2);
    const types = res.started.map((s) => s.type).sort();
    expect(types).toEqual(['cron', 'file-watch']);
    await res.stop();
  });

  test('stop() is idempotent within the same lifecycle', async () => {
    writeFileSync(sourcesPath, VALID_CRON);
    const res = await startAgentSources({ configPath: sourcesPath, storePath });
    await res.stop();
    // A second stop should not crash — instances track their own state
    await expect(res.stop()).resolves.toBeUndefined();
  });
});

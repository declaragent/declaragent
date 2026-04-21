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
      type: skill
      name: extract
`;

const VALID_CRON = `
- type: cron
  config:
    id: morning-poke
    schedule: "0 9 * * *"
    target:
      type: skill
      name: daily
`;

const UNKNOWN_TYPE = `
- type: kafka
  config:
    id: orders
    brokers: ["localhost:9092"]
    topic: orders
    target:
      type: skill
      name: handle
`;

const INVALID_FILE_WATCH = `
- type: file-watch
  config:
    # missing required "paths" array
    id: bad
    target:
      type: skill
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

// ── Slice 1 (0.5.0) — external adapter discovery ──────────────────────
//
// The happy path: a scaffolded agent dir contains
// `node_modules/@declaragent/source-<foo>/`, `startAgentSources` picks
// it up, the yaml's `type: foo` source binds successfully. The test
// builds a minimal adapter package in a tmpdir + points `agentDir` at
// that tmpdir so discovery scans it.
//
// Sad paths covered below: (a) broken-adapter package is skipped via
// `onPackageError` + healthy siblings still load; (b) two packages
// claiming the same type throw (strict, user-visible).

describe('startAgentSources — external adapter discovery', () => {
  let root: string;
  let agentDir: string;
  let storePath: string;
  let sourcesPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'declara-ext-discovery-'));
    agentDir = join(root, 'agent');
    mkdirSync(agentDir, { recursive: true });
    storePath = join(root, 'sessions.db');
    sourcesPath = join(agentDir, 'event-sources.yaml');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Drop a minimal adapter package under agentDir/node_modules/@declaragent/source-<type>/. */
  function writeFixtureAdapter(type: string, pkgSuffix = type): string {
    const pkgDir = join(agentDir, 'node_modules', '@declaragent', `source-${pkgSuffix}`);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: `@declaragent/source-${pkgSuffix}`,
          version: '0.0.1',
          main: './index.js',
          declaragent: {
            kind: 'event-source-adapter',
            type,
            agent_compat: '>=0.0.1',
          },
        },
        null,
        2,
      ),
    );
    // A live adapter: validateConfig always accepts; create returns a
    // no-op instance so bind/stop succeed cleanly. Emits one event on
    // start so the bus subscription exercises end-to-end if needed.
    writeFileSync(
      join(pkgDir, 'index.js'),
      `export default {
  type: '${type}',
  validateConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('config required');
    if (typeof config.id !== 'string') throw new Error('id required');
    if (!config.target || typeof config.target !== 'object') throw new Error('target required');
  },
  async create(config, deps) {
    return {
      id: config.id,
      type: '${type}',
      async start() {},
      async stop() {},
      async pause() {},
      async resume() {},
      async health() { return { status: 'healthy' }; },
      metrics() { return { eventsPublished: 0, errors: 0, lastEventAt: null, lastStatus: null }; },
    };
  },
};
`,
    );
    return pkgDir;
  }

  test('discovers a fixture adapter under agentDir/node_modules and binds it', async () => {
    writeFixtureAdapter('fake-broker');
    writeFileSync(
      sourcesPath,
      `- type: fake-broker
  config:
    id: faker
    target:
      type: skill
      name: greet
`,
    );

    const res = await startAgentSources({ configPath: sourcesPath, agentDir, storePath });
    expect(res.started).toHaveLength(1);
    expect(res.started[0]?.type).toBe('fake-broker');
    expect(res.started[0]?.id).toBe('faker');
    expect(res.unknownTypes).toHaveLength(0);
    await res.stop();
  });

  test('broken adapter package is skipped + healthy siblings still load', async () => {
    // Package A: valid. Package B: valid package.json shape, but its
    // entry-point throws on import. discovery must surface B's failure
    // via the logger (onPackageError) + keep A bound.
    writeFixtureAdapter('good-broker');
    const brokenDir = join(agentDir, 'node_modules', '@declaragent', 'source-broken');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(
      join(brokenDir, 'package.json'),
      JSON.stringify({
        name: '@declaragent/source-broken',
        version: '0.0.1',
        main: './index.js',
        declaragent: {
          kind: 'event-source-adapter',
          type: 'broken',
          agent_compat: '>=0.0.1',
        },
      }),
    );
    writeFileSync(join(brokenDir, 'index.js'), "throw new Error('i break on import');\n");

    writeFileSync(
      sourcesPath,
      `- type: good-broker
  config:
    id: ok
    target:
      type: skill
      name: greet
`,
    );

    const warns: Array<{ event: string; data?: unknown }> = [];
    const logger = {
      debug() {},
      info() {},
      warn(event: string, data?: unknown) {
        warns.push({ event, data });
      },
      error() {},
      child() {
        return this;
      },
    };

    const res = await startAgentSources({
      configPath: sourcesPath,
      agentDir,
      storePath,
      logger: logger as never,
    });
    expect(res.started).toHaveLength(1);
    expect(res.started[0]?.type).toBe('good-broker');
    // The failure must be visible in the logs, not silent.
    const failureLogs = warns.filter((w) => w.event === 'adapter-discovery.package-failed');
    expect(failureLogs).toHaveLength(1);
    await res.stop();
  });

  test('two packages claiming the same type throw (strict duplicate handling)', async () => {
    // Both packages claim type=dup. The core discovery's duplicate
    // check fires and throws an AdapterDiscoveryError — user-visible.
    writeFixtureAdapter('dup', 'dup-a');
    writeFixtureAdapter('dup', 'dup-b');

    writeFileSync(
      sourcesPath,
      `- type: dup
  config:
    id: x
    target:
      type: skill
      name: s
`,
    );

    await expect(
      startAgentSources({ configPath: sourcesPath, agentDir, storePath }),
    ).rejects.toThrow(/claimed by two packages/);
  });
});

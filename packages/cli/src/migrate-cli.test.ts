import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MigrateCliIO, MigrateFs } from './migrate-cli.js';
import { AGENT_YAML_SCHEMA_PLACEHOLDER, migrateConfig } from './migrate-cli.js';

function captureIo(): { io: MigrateCliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    out,
    err,
  };
}

function makeFs(files: Record<string, string>): MigrateFs {
  const store = new Map(Object.entries(files));
  return {
    exists: (p) => store.has(p),
    readFile: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, c) => {
      store.set(p, c);
    },
  };
}

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'declaragent-migrate-'));
}

describe('migrateConfig', () => {
  test('dry-run reports pending work on an unversioned agent.yaml', async () => {
    const cap = captureIo();
    const cfgDir = '/fake/cfg';
    const fs = makeFs({
      [join(cfgDir, 'agent.yaml')]: 'name: c\nmodel: sonnet\n',
    });
    const code = await migrateConfig({ configDir: cfgDir }, { io: cap.io, fs });
    expect(code).toBe(0);
    const out = cap.out.join('');
    expect(out).toContain('declaragent migrate (dry-run)');
    expect(out).toContain('agent.yaml');
    expect(out).toContain('pending');
    expect(out).toContain('run again with `--apply`');
    // Content unchanged in dry-run.
    expect(fs.readFile(join(cfgDir, 'agent.yaml'))).not.toContain('schemaVersion');
  });

  test('--apply rewrites the file with schemaVersion stamped', async () => {
    const cap = captureIo();
    const cfgDir = '/fake/cfg';
    const fs = makeFs({ [join(cfgDir, 'agent.yaml')]: 'name: c\nmodel: sonnet\n' });
    const code = await migrateConfig({ configDir: cfgDir, apply: true }, { io: cap.io, fs });
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('applied');
    expect(fs.readFile(join(cfgDir, 'agent.yaml'))).toContain('schemaVersion: 1');
  });

  test('no-op on an already-v1 agent.yaml', async () => {
    const cap = captureIo();
    const cfgDir = '/fake/cfg';
    const fs = makeFs({
      [join(cfgDir, 'agent.yaml')]: 'schemaVersion: 1\nname: c\nmodel: sonnet\n',
    });
    const code = await migrateConfig({ configDir: cfgDir, apply: true }, { io: cap.io, fs });
    expect(code).toBe(0);
    const out = cap.out.join('');
    expect(out).toContain('no-op');
    expect(out).not.toContain('applied');
  });

  test('idempotent: second --apply run is a no-op', async () => {
    const cfgDir = '/fake/cfg';
    const fs = makeFs({ [join(cfgDir, 'agent.yaml')]: 'name: c\n' });
    await migrateConfig({ configDir: cfgDir, apply: true }, { fs, io: captureIo().io });
    const cap2 = captureIo();
    const code = await migrateConfig({ configDir: cfgDir, apply: true }, { fs, io: cap2.io });
    expect(code).toBe(0);
    const out = cap2.out.join('');
    expect(out).not.toContain('applied');
    expect(out).toContain('no-op');
  });

  test('advises when multi-tenant hints are present but no tenants.yaml', async () => {
    const cap = captureIo();
    const cfgDir = '/fake/cfg';
    const fs = makeFs({
      [join(cfgDir, 'channels.json')]: '{"channels":[{"tenantId":"acme"}]}',
    });
    const code = await migrateConfig({ configDir: cfgDir }, { io: cap.io, fs });
    expect(code).toBe(0);
    const out = cap.out.join('');
    expect(out).toContain('advise');
    expect(out).toContain('hand-author');
  });

  test('emits JSON when --json is set', async () => {
    const cap = captureIo();
    const cfgDir = '/fake/cfg';
    const fs = makeFs({
      [join(cfgDir, 'agent.yaml')]: 'name: x\n',
    });
    const code = await migrateConfig({ configDir: cfgDir, json: true }, { io: cap.io, fs });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.apply).toBe(false);
    expect(parsed.configDir).toBe(cfgDir);
    expect(parsed.steps).toBeInstanceOf(Array);
    const ids = parsed.steps.map((s: { id: string }) => s.id);
    expect(ids).toContain('agent.yaml');
    expect(ids).toContain('tenants.yaml');
    expect(ids).toContain('sessions.db');
  });

  test('handles an unparseable agent.yaml without crashing', async () => {
    const cap = captureIo();
    const cfgDir = '/fake/cfg';
    const fs = makeFs({
      [join(cfgDir, 'agent.yaml')]: ': : not: valid : yaml :\n\t- [',
    });
    const code = await migrateConfig({ configDir: cfgDir, apply: true }, { io: cap.io, fs });
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('migrate finished with errors');
  });

  test('reports pending work against a pre-v1.0 sessions.db', async () => {
    const cfgDir = tmpConfigDir();
    const dbPath = join(cfgDir, 'sessions.db');
    // Create legacy schema on disk first so the default opener finds it.
    const seed = new Database(dbPath);
    seed.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         spec_json TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       );`,
    );
    seed.exec("INSERT INTO sessions VALUES ('legacy', '{}', 1, 1);");
    seed.close();

    // Minimal agent.yaml already-v1 so the only pending work is the DB.
    writeFileSync(join(cfgDir, 'agent.yaml'), 'schemaVersion: 1\nname: x\n');

    const cap = captureIo();
    const code = await migrateConfig({ configDir: cfgDir }, { io: cap.io });
    expect(code).toBe(0);
    const out = cap.out.join('');
    expect(out).toContain('sessions.db');
    expect(out).toContain('pre-v1.0');
    expect(out).toContain('pending');
  });

  test('exported placeholder is frozen + carries the schemaVersion', () => {
    expect(AGENT_YAML_SCHEMA_PLACEHOLDER.schemaVersion).toBe(1);
    expect(Object.isFrozen(AGENT_YAML_SCHEMA_PLACEHOLDER)).toBe(true);
  });
});

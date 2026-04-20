import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  AGENT_YAML_CURRENT_SCHEMA_VERSION,
  migrateAgentYaml,
  migrateSessionSchema,
  migrateTenantsYaml,
} from './migrate-transforms.js';

describe('migrateAgentYaml', () => {
  test('stamps schemaVersion onto a config that omits it', () => {
    const result = migrateAgentYaml({ name: 'concierge', model: 'sonnet' });
    expect(result.changed).toBe(true);
    expect(result.next.schemaVersion).toBe(AGENT_YAML_CURRENT_SCHEMA_VERSION);
    expect(result.notes.join('\n')).toContain('stamp schemaVersion');
  });

  test('is a no-op when the version already matches', () => {
    const input = { name: 'c', model: 'sonnet', schemaVersion: 1 };
    const result = migrateAgentYaml(input);
    expect(result.changed).toBe(false);
    expect(result.next).toBe(input);
    expect(result.notes.join(' ')).toContain('already at schemaVersion 1');
  });

  test('bumps pre-v1.0 numeric 0 up to 1', () => {
    const result = migrateAgentYaml({ name: 'x', schemaVersion: 0 });
    expect(result.changed).toBe(true);
    expect(result.next.schemaVersion).toBe(1);
    expect(result.notes[0]).toContain('bump schemaVersion 0 -> 1');
  });

  test('bumps pre-v1.0 string "0.9" up to 1', () => {
    const result = migrateAgentYaml({ name: 'x', schemaVersion: '0.9' });
    expect(result.changed).toBe(true);
    expect(result.next.schemaVersion).toBe(1);
    expect(result.notes[0]).toContain('bump schemaVersion "0.9" -> 1');
  });

  test('does not rewrite configs from future schema versions', () => {
    const result = migrateAgentYaml({ name: 'x', schemaVersion: 2 });
    expect(result.changed).toBe(false);
    expect(result.notes.join(' ')).toContain('newer than this CLI supports');
  });

  test('tolerates non-object inputs without throwing', () => {
    expect(migrateAgentYaml(null).changed).toBe(false);
    expect(migrateAgentYaml([] as unknown).changed).toBe(false);
    expect(migrateAgentYaml('nope' as unknown).changed).toBe(false);
  });

  test('is idempotent when run twice', () => {
    const pass1 = migrateAgentYaml({ name: 'x' });
    const pass2 = migrateAgentYaml(pass1.next);
    expect(pass2.changed).toBe(false);
  });
});

describe('migrateTenantsYaml', () => {
  test('no-op when the file already exists', () => {
    const r = migrateTenantsYaml({
      tenantsPath: '/cfg/tenants.yaml',
      tenantsExists: true,
      multiTenantInUse: true,
    });
    expect(r.action).toBe('no-op');
  });

  test('advises the user when multi-tenant features are in use but no file exists', () => {
    const r = migrateTenantsYaml({
      tenantsPath: '/cfg/tenants.yaml',
      tenantsExists: false,
      multiTenantInUse: true,
    });
    expect(r.action).toBe('advise');
    expect(r.notes.join(' ')).toContain('multi-tenant features detected');
    expect(r.notes.join(' ')).toContain('hand-author');
  });

  test('skips on single-tenant deployments', () => {
    const r = migrateTenantsYaml({
      tenantsPath: '/cfg/tenants.yaml',
      tenantsExists: false,
      multiTenantInUse: false,
    });
    expect(r.action).toBe('skip');
  });
});

describe('migrateSessionSchema', () => {
  test('reports an already-migrated schema unchanged', () => {
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         tenant_id TEXT NOT NULL DEFAULT '__default__',
         spec_json TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       );`,
    );
    db.exec(
      "INSERT INTO sessions VALUES ('s1', '__default__', '{}', 1, 1), ('s2', 'acme', '{}', 1, 1);",
    );
    const r = migrateSessionSchema(db);
    db.close();
    expect(r.alreadyMigrated).toBe(true);
    expect(r.tableMissing).toBe(false);
    expect(r.rowCount).toBe(2);
  });

  test('flags a pre-v1.0 schema as pending', () => {
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         spec_json TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       );`,
    );
    db.exec("INSERT INTO sessions VALUES ('legacy', '{}', 1, 1);");
    const r = migrateSessionSchema(db);
    db.close();
    expect(r.alreadyMigrated).toBe(false);
    expect(r.tableMissing).toBe(false);
    expect(r.rowCount).toBe(1);
    expect(r.notes.join(' ')).toContain('pre-v1.0');
  });

  test('notes when the sessions table is absent', () => {
    const db = new Database(':memory:');
    const r = migrateSessionSchema(db);
    db.close();
    expect(r.tableMissing).toBe(true);
    expect(r.alreadyMigrated).toBe(false);
    expect(r.rowCount).toBe(0);
  });
});

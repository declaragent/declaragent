import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEnvExampleEntry,
  createAddSecretTool,
  deriveEnvVar,
  runAddSecret,
} from './add-secret.js';
import { BuilderScopeError, BuilderSecretLeakError, BuilderValidationError } from './types.js';

describe('deriveEnvVar', () => {
  test('collapses path separators and uppercases', () => {
    expect(deriveEnvVar('kv/data/acme/gh-token', 'vault')).toBe('DECLARA_ACME_GH_TOKEN');
  });

  test('strips noise tokens kv and data', () => {
    expect(deriveEnvVar('kv/data/one/two', 'vault')).toBe('DECLARA_ONE_TWO');
  });

  test('keeps non-noise keywords', () => {
    expect(deriveEnvVar('prod/api/token', 'aws-sm')).toBe('DECLARA_PROD_API_TOKEN');
  });

  test('falls back to provider_SECRET when the ref has no usable parts', () => {
    expect(deriveEnvVar('/', 'vault')).toBe('DECLARA_VAULT_SECRET');
    expect(deriveEnvVar('kv/data', 'vault')).toBe('DECLARA_VAULT_SECRET');
  });

  test('provider "aws-sm" hyphen becomes underscore in the fallback', () => {
    expect(deriveEnvVar('/', 'aws-sm')).toBe('DECLARA_AWS_SM_SECRET');
  });
});

describe('appendEnvExampleEntry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-add-secret-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates .env.example when missing and writes a comment block', async () => {
    const p = join(dir, '.env.example');
    const res = await appendEnvExampleEntry(p, {
      envVar: 'DECLARA_GH_TOKEN',
      ref: 'ghp-token',
      provider: 'env',
    });
    expect(res.changed).toBe(true);
    const contents = readFileSync(p, 'utf-8');
    expect(contents).toContain('# Secret ref: ghp-token (provider: env).');
    expect(contents).toContain('DECLARA_GH_TOKEN=');
  });

  test('preserves pre-existing contents when appending', async () => {
    const p = join(dir, '.env.example');
    writeFileSync(p, '# existing\nEXISTING=value-here\n');
    await appendEnvExampleEntry(p, {
      envVar: 'DECLARA_GH_TOKEN',
      ref: 'ghp-token',
      provider: 'env',
    });
    const contents = readFileSync(p, 'utf-8');
    expect(contents.startsWith('# existing\nEXISTING=value-here\n')).toBe(true);
    expect(contents).toContain('DECLARA_GH_TOKEN=');
  });

  test('idempotent — second call with the same envVar does not re-append', async () => {
    const p = join(dir, '.env.example');
    await appendEnvExampleEntry(p, {
      envVar: 'DECLARA_X',
      ref: 'r',
      provider: 'env',
    });
    const before = readFileSync(p, 'utf-8');
    const res2 = await appendEnvExampleEntry(p, {
      envVar: 'DECLARA_X',
      ref: 'r',
      provider: 'env',
    });
    const after = readFileSync(p, 'utf-8');
    expect(res2.changed).toBe(false);
    expect(after).toBe(before);
  });

  test('includes usedBy and tenantScope lines when given', async () => {
    const p = join(dir, '.env.example');
    await appendEnvExampleEntry(p, {
      envVar: 'DECLARA_X',
      ref: 'r',
      provider: 'vault',
      usedBy: 'pr-review.slack channel',
      tenantScope: 'acme',
    });
    const contents = readFileSync(p, 'utf-8');
    expect(contents).toContain('# Used by: pr-review.slack channel.');
    expect(contents).toContain('# Tenant scope: acme.');
  });
});

describe('runAddSecret', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-add-secret-run-'));
    writeFileSync(join(dir, 'agent.yaml'), 'name: a\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('happy path: env provider appends placeholder and returns a hint', async () => {
    const out = await runAddSecret({ ref: 'GITHUB_TOKEN', provider: 'env' }, { scopeRoot: dir });
    expect(out.ok).toBe(true);
    expect(out.envVar).toBe('DECLARA_GITHUB_TOKEN');
    expect(out.hint).toContain('.env.example');
    expect(out.hint).toContain('${env:DECLARA_GITHUB_TOKEN}');
    const env = readFileSync(join(dir, '.env.example'), 'utf-8');
    expect(env).toContain('DECLARA_GITHUB_TOKEN=');
  });

  test('refuses to run when the ref looks like a pasted secret', async () => {
    await expect(
      runAddSecret({ ref: `ghp_${'a'.repeat(36)}`, provider: 'env' }, { scopeRoot: dir }),
    ).rejects.toBeInstanceOf(BuilderSecretLeakError);
  });

  test('rejects a prefix/provider mismatch', async () => {
    await expect(
      runAddSecret({ ref: 'vault:kv/data/foo', provider: 'env' }, { scopeRoot: dir }),
    ).rejects.toBeInstanceOf(BuilderValidationError);
  });

  test('refuses an out-of-scope agentPath without confirmOutsideScope', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'declara-secret-sibling-'));
    try {
      writeFileSync(join(sibling, 'agent.yaml'), 'name: s\n');
      await expect(
        runAddSecret({ ref: 'FOO', provider: 'env', agentPath: sibling }, { scopeRoot: dir }),
      ).rejects.toBeInstanceOf(BuilderScopeError);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('non-env provider without secrets.yaml surfaces a warning in the hint', async () => {
    const out = await runAddSecret(
      { ref: 'vault:kv/data/acme/gh', provider: 'vault' },
      { scopeRoot: dir },
    );
    expect(out.hint).toContain('no provider of type "vault"');
    expect(out.hint).toContain('DeclaraAuthPlaybook');
  });

  test('non-env provider with matching secrets.yaml provider elides the warning', async () => {
    writeFileSync(
      join(dir, 'secrets.yaml'),
      [
        'version: 1',
        'providers:',
        '  vault-prod:',
        '    type: vault',
        '    address: https://vault.test',
        '    auth:',
        '      method: token',
        '      token: ${env:VAULT_TOKEN}',
        '',
      ].join('\n'),
    );
    const out = await runAddSecret(
      { ref: 'vault:kv/data/acme/gh', provider: 'vault' },
      { scopeRoot: dir },
    );
    expect(out.hint).not.toContain('no provider of type');
    expect(out.hint).toContain('"vault" provider');
  });

  test('idempotent: running twice does not duplicate the entry', async () => {
    await runAddSecret({ ref: 'X', provider: 'env' }, { scopeRoot: dir });
    const firstEnv = readFileSync(join(dir, '.env.example'), 'utf-8');
    const out = await runAddSecret({ ref: 'X', provider: 'env' }, { scopeRoot: dir });
    const secondEnv = readFileSync(join(dir, '.env.example'), 'utf-8');
    expect(secondEnv).toBe(firstEnv);
    expect(out.writes).toHaveLength(0);
  });
});

describe('createAddSecretTool', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declara-builder-secret-tool-'));
    writeFileSync(join(dir, 'agent.yaml'), 'name: t\n');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('exposes the expected Tool metadata', () => {
    const tool = createAddSecretTool({ scopeRoot: dir });
    expect(tool.name).toBe('DeclaraAddSecret');
    expect(tool.readonly).toBe(false);
  });

  test('permissionKey includes provider + ref + scope', () => {
    const tool = createAddSecretTool({ scopeRoot: dir });
    expect(tool.permissionKey({ ref: 'X', provider: 'env' })).toBe('.:env:X');
  });

  test('execute yields a validation error for an invalid provider', async () => {
    const tool = createAddSecretTool({ scopeRoot: dir });
    const ctx = {
      session: {} as never,
      permissions: {} as never,
      abortSignal: new AbortController().signal,
      depth: 0,
      runAgent: (async () => ({}) as never) as never,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      } as never,
    };
    const events: unknown[] = [];
    for await (const ev of tool.execute({ ref: 'X', provider: 'not-a-provider' as never }, ctx)) {
      events.push(ev);
    }
    expect((events[0] as { type: string }).type).toBe('error');
  });
});

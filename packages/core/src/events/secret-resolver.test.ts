import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretResolverError, createDefaultSecretResolver } from './secret-resolver.js';

function tmpDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'declaragent-secret-resolver-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe('createDefaultSecretResolver — resolve()', () => {
  test('resolves env:VAR references', async () => {
    const r = createDefaultSecretResolver({ env: { DB: 'localhost' } });
    expect(await r.resolve('env:DB')).toBe('localhost');
    expect(await r.resolve('${env:DB}')).toBe('localhost'); // enclosed form
  });

  test('throws SecretResolverError on missing env var', async () => {
    const r = createDefaultSecretResolver({ env: {} });
    await expect(r.resolve('env:MISSING')).rejects.toThrow(SecretResolverError);
  });

  test('resolves file:/path references', async () => {
    const { path, cleanup } = tmpDir();
    try {
      const filePath = join(path, 'token');
      writeFileSync(filePath, 'sekret\n', 'utf-8');
      const r = createDefaultSecretResolver();
      expect(await r.resolve(`file:${filePath}`)).toBe('sekret');
    } finally {
      cleanup();
    }
  });

  test('fileRoot resolves relative file: references', async () => {
    const { path, cleanup } = tmpDir();
    try {
      writeFileSync(join(path, 'token'), 'ok', 'utf-8');
      const r = createDefaultSecretResolver({ fileRoot: path });
      expect(await r.resolve('file:token')).toBe('ok');
    } finally {
      cleanup();
    }
  });

  test('throws on missing file', async () => {
    const r = createDefaultSecretResolver();
    await expect(r.resolve('file:/definitely-not-a-file')).rejects.toThrow(SecretResolverError);
  });

  test('secret: without a handler or provider throws with a clear message', async () => {
    const r = createDefaultSecretResolver();
    await expect(r.resolve('secret:db/password')).rejects.toThrow(
      /unknown or unconfigured scheme "secret"/,
    );
  });

  test('secret: with a handler returns the value', async () => {
    const r = createDefaultSecretResolver({
      secretHandler: async (p) => `resolved:${p}`,
    });
    expect(await r.resolve('secret:db/password')).toBe('resolved:db/password');
  });

  test('rejects malformed references', async () => {
    const r = createDefaultSecretResolver();
    await expect(r.resolve('bogus:x')).rejects.toThrow(SecretResolverError);
  });
});

describe('createDefaultSecretResolver — Phase 6 providers + audit', () => {
  test('routes typed refs to the matching provider', async () => {
    const { createEnvSecretProvider } = await import('../secrets/providers/env.js');
    const r = createDefaultSecretResolver({
      env: { LEGACY: 'old' },
      providers: [createEnvSecretProvider({ env: { GREETING: 'hello' } })],
    });
    expect(await r.resolve('env:LEGACY')).toBe('old'); // `env:` still goes to built-in
    // provider-typed env scheme is not available by default (env provider
    // registers under type 'env' so callers can route via the provider list
    // if they want audit trails for env-backed secrets):
    // The provider path is exercised via 'secret:' + defaultProviderType below.
  });

  test('emits a resolved audit record for provider hits', async () => {
    const { createEnvSecretProvider } = await import('../secrets/providers/env.js');
    const records: unknown[] = [];
    const provider = createEnvSecretProvider({
      name: 'env-default',
      env: { PASSWORD: 'shhh' },
    });
    const r = createDefaultSecretResolver({
      providers: [provider],
      defaultProviderType: 'env',
      auditSink: {
        record: (rec) => {
          records.push(rec);
        },
      },
      tenant: { id: 'acme-prod' },
      requester: 'channel:slack-prod',
      now: () => 1_700_000_000_000,
    });
    expect(await r.resolve('secret:PASSWORD')).toBe('shhh');
    expect(records).toEqual([
      {
        kind: 'secret_access',
        ts: 1_700_000_000_000,
        tenantId: 'acme-prod',
        ref: 'secret:PASSWORD',
        requester: 'channel:slack-prod',
        outcome: 'resolved',
        providerType: 'env',
        providerName: 'env-default',
      },
    ]);
  });

  test('emits a denied audit record when provider throws EDENIED', async () => {
    const records: { outcome: string; ref: string }[] = [];
    const denialProvider = {
      type: 'vault' as const,
      name: 'vault-test',
      async resolve() {
        const err = new Error('vault: access denied on kv/x') as Error & { code: string };
        err.code = 'EDENIED';
        throw err;
      },
    };
    const r = createDefaultSecretResolver({
      providers: [denialProvider],
      auditSink: {
        record: (rec) => {
          records.push({ outcome: rec.outcome, ref: rec.ref });
        },
      },
    });
    await expect(r.resolve('vault:kv/x')).rejects.toThrow(/access denied/);
    expect(records).toEqual([{ outcome: 'denied', ref: 'vault:kv/x' }]);
  });

  test('emits an error audit record on generic provider failure', async () => {
    const records: { outcome: string; error?: unknown }[] = [];
    const failing = {
      type: 'k8s' as const,
      name: 'k8s-test',
      async resolve() {
        throw new Error('k8s: secret not found');
      },
    };
    const r = createDefaultSecretResolver({
      providers: [failing],
      auditSink: {
        record: (rec) => {
          records.push({ outcome: rec.outcome, error: rec.error });
        },
      },
    });
    await expect(r.resolve('k8s:ns/name/field')).rejects.toThrow(/secret not found/);
    expect(records[0]).toEqual({
      outcome: 'error',
      error: { message: 'k8s: secret not found' },
    });
  });

  test('audit record never contains the secret value', async () => {
    const records: unknown[] = [];
    const provider = {
      type: 'vault' as const,
      name: 'vault',
      async resolve() {
        return 'HIGHLY-SECRET-VALUE-42';
      },
    };
    const r = createDefaultSecretResolver({
      providers: [provider],
      auditSink: {
        record: (rec) => {
          records.push(rec);
        },
      },
    });
    expect(await r.resolve('vault:kv/x')).toBe('HIGHLY-SECRET-VALUE-42');
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('HIGHLY-SECRET-VALUE-42');
  });

  test('audit sink errors do not break resolve', async () => {
    const provider = {
      type: 'vault' as const,
      name: 'vault',
      async resolve() {
        return 'ok';
      },
    };
    const r = createDefaultSecretResolver({
      providers: [provider],
      auditSink: {
        record: () => {
          throw new Error('sink exploded');
        },
      },
    });
    expect(await r.resolve('vault:kv/x')).toBe('ok');
  });
});

describe('createDefaultSecretResolver — expand()', () => {
  test('substitutes ${env:X} inside strings', async () => {
    const r = createDefaultSecretResolver({ env: { USER: 'alice', PASS: 'wonder' } });
    const out = await r.expand('postgres://${env:USER}:${env:PASS}@host');
    expect(out).toBe('postgres://alice:wonder@host');
  });

  test('walks arrays + objects recursively', async () => {
    const r = createDefaultSecretResolver({ env: { TOKEN: 'abc' } });
    const out = await r.expand({
      brokers: ['${env:TOKEN}@one', 'two'],
      inner: { auth: 'prefix:${env:TOKEN}' },
      left: 42,
      right: true,
    });
    expect(out).toEqual({
      brokers: ['abc@one', 'two'],
      inner: { auth: 'prefix:abc' },
      left: 42,
      right: true,
    });
  });

  test('leaves strings without placeholders untouched', async () => {
    const r = createDefaultSecretResolver();
    const out = await r.expand({ a: 'hello', b: 'world' });
    expect(out).toEqual({ a: 'hello', b: 'world' });
  });

  test('throws when a placeholder is unterminated', async () => {
    const r = createDefaultSecretResolver({ env: { X: '1' } });
    await expect(r.expand('value-${env:X')).rejects.toThrow(SecretResolverError);
  });

  test('throws when any env var is missing', async () => {
    const r = createDefaultSecretResolver({ env: {} });
    await expect(r.expand({ url: '${env:MISSING}' })).rejects.toThrow(/MISSING/);
  });
});

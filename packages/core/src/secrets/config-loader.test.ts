import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsConfigError, loadSecretsConfig } from './config-loader.js';

function withTmpDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'declaragent-secrets-'));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('loadSecretsConfig', () => {
  test('instantiates Vault + AWS SM + GCP SM + K8s providers from YAML', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'secrets.yaml');
      writeFileSync(
        path,
        `version: 1
default: vault-prod
providers:
  vault-prod:
    type: vault
    address: https://vault.test
    auth:
      method: token
      token: \${env:VAULT_TOKEN}
  aws-sm-prod:
    type: aws-sm
    defaultRegion: us-east-1
  gcp-sm-prod:
    type: gcp-sm
  k8s-default:
    type: k8s
    apiUrl: https://kube.test
rotationMonitor:
  enabled: true
  checkIntervalMs: 3600000
  warnAfterDays: 90
`,
        'utf-8',
      );
      const result = await loadSecretsConfig({
        path,
        env: { VAULT_TOKEN: 'tok-xyz', KUBERNETES_SERVICE_HOST: 'kube.test' },
      });
      expect(result.format).toBe('yaml');
      expect(result.providers.map((p) => p.type)).toEqual(['vault', 'aws-sm', 'gcp-sm', 'k8s']);
      expect(result.providers.map((p) => p.name)).toEqual([
        'vault-prod',
        'aws-sm-prod',
        'gcp-sm-prod',
        'k8s-default',
      ]);
      expect(result.defaultProviderType).toBe('vault');
      expect(result.rotationMonitor?.enabled).toBe(true);
      expect(result.rotationMonitor?.checkIntervalMs).toBe(3_600_000);
    });
  });

  test('expands ${env:...} inside auth blocks', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'secrets.yaml');
      writeFileSync(
        path,
        `version: 1
providers:
  vault-prod:
    type: vault
    address: https://vault.test
    auth:
      method: approle
      roleId: \${env:ROLE_ID}
      secretId: \${env:SECRET_ID}
`,
        'utf-8',
      );
      // Env expansion happens before Zod validation; if it didn't, the
      // strings would contain literal `${env:...}`.
      const result = await loadSecretsConfig({
        path,
        env: { ROLE_ID: 'role-123', SECRET_ID: 'sec-456' },
      });
      expect(result.providers).toHaveLength(1);
    });
  });

  test('throws when default points to a missing provider', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'secrets.yaml');
      writeFileSync(
        path,
        `version: 1
default: nonexistent
providers:
  vault-prod:
    type: vault
    address: https://vault.test
    auth:
      method: token
      token: t
`,
        'utf-8',
      );
      await expect(loadSecretsConfig({ path, env: {} })).rejects.toThrow(SecretsConfigError);
    });
  });

  test('rejects invalid provider types', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'secrets.yaml');
      writeFileSync(
        path,
        `version: 1
providers:
  bogus:
    type: made-up
    address: x
`,
        'utf-8',
      );
      await expect(loadSecretsConfig({ path, env: {} })).rejects.toThrow(SecretsConfigError);
    });
  });

  test('supports JSON format', async () => {
    await withTmpDir(async (dir) => {
      const path = join(dir, 'secrets.json');
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          providers: {
            env1: { type: 'env' },
          },
        }),
        'utf-8',
      );
      const result = await loadSecretsConfig({ path, env: {} });
      expect(result.format).toBe('json');
      expect(result.providers[0]?.type).toBe('env');
    });
  });
});

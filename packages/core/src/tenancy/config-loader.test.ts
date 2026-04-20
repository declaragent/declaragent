import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantsConfigError, loadTenantsConfig } from './config-loader.js';

function withTmp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'declaragent-tenants-'));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('loadTenantsConfig', () => {
  test('parses a canonical two-tenant YAML', async () => {
    await withTmp(async (dir) => {
      const path = join(dir, 'tenants.yaml');
      writeFileSync(
        path,
        `version: 1
strategy:
  bus: per-tenant
  secretProvider: vault
tenants:
  - id: acme-prod
    displayName: "ACME Production"
    residency: us
    auditRetentionDays: 90
    quotas:
      maxActiveSessions: 500
      dailyTokenUSD: 200
      maxConcurrentToolCalls: 20
    labels:
      env: production
      team: platform
    extensions:
      allow:
        - channel-telegram
        - source-kafka
      deny:
        - "plugin-experimental-*"
  - id: beta-tenant
    displayName: "Beta Partner"
    residency: eu
    auditRetentionDays: 30
    quotas:
      maxActiveSessions: 100
      dailyTokenUSD: 50
`,
        'utf-8',
      );
      const config = await loadTenantsConfig({ path, env: {} });
      expect(config.strategy.bus).toBe('per-tenant');
      expect(config.strategy.secretProvider).toBe('vault');
      expect(config.tenants).toHaveLength(2);
      const [acme, beta] = config.tenants;
      expect(acme?.context.id).toBe('acme-prod');
      expect(acme?.context.residency).toBe('us');
      expect(acme?.context.quotas?.maxActiveSessions).toBe(500);
      expect(acme?.extensions?.allow).toEqual(['channel-telegram', 'source-kafka']);
      expect(acme?.extensions?.deny).toEqual(['plugin-experimental-*']);
      expect(beta?.context.id).toBe('beta-tenant');
      expect(beta?.context.auditRetentionDays).toBe(30);
    });
  });

  test('defaults bus strategy to per-tenant', async () => {
    await withTmp(async (dir) => {
      const path = join(dir, 'tenants.yaml');
      writeFileSync(
        path,
        `version: 1
tenants:
  - id: only
    displayName: "only tenant"
`,
        'utf-8',
      );
      const config = await loadTenantsConfig({ path, env: {} });
      expect(config.strategy.bus).toBe('per-tenant');
    });
  });

  test('expands ${env:...} inside tenant fields', async () => {
    await withTmp(async (dir) => {
      const path = join(dir, 'tenants.yaml');
      writeFileSync(
        path,
        `version: 1
tenants:
  - id: acme
    displayName: "\${env:DISPLAY_NAME}"
`,
        'utf-8',
      );
      const config = await loadTenantsConfig({
        path,
        env: { DISPLAY_NAME: 'ACME from env' },
      });
      expect(config.tenants[0]?.context.displayName).toBe('ACME from env');
    });
  });

  test('rejects duplicate tenant ids', async () => {
    await withTmp(async (dir) => {
      const path = join(dir, 'tenants.yaml');
      writeFileSync(
        path,
        `version: 1
tenants:
  - id: dup
  - id: dup
`,
        'utf-8',
      );
      await expect(loadTenantsConfig({ path, env: {} })).rejects.toThrow(/duplicate tenant id/);
    });
  });

  test('rejects a tenant id with invalid chars', async () => {
    await withTmp(async (dir) => {
      const path = join(dir, 'tenants.yaml');
      writeFileSync(
        path,
        `version: 1
tenants:
  - id: "has spaces"
`,
        'utf-8',
      );
      await expect(loadTenantsConfig({ path, env: {} })).rejects.toThrow(TenantsConfigError);
    });
  });

  test('supports JSON format', async () => {
    await withTmp(async (dir) => {
      const path = join(dir, 'tenants.json');
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          tenants: [{ id: 'acme' }],
        }),
        'utf-8',
      );
      const config = await loadTenantsConfig({ path, env: {} });
      expect(config.format).toBe('json');
      expect(config.tenants[0]?.context.id).toBe('acme');
    });
  });
});

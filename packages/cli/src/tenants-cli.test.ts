import { describe, expect, test } from 'bun:test';
import type { LoadedTenantsConfig } from '@declaragent/core';
import type { TenantsCliDeps, TenantsCliIO } from './tenants-cli.js';
import { tenantsDiff, tenantsList, tenantsShow } from './tenants-cli.js';

function captureIo(): {
  io: TenantsCliIO;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
    },
    out,
    err,
  };
}

function fakeConfig(): LoadedTenantsConfig {
  return {
    strategy: { bus: 'per-tenant' },
    tenants: [
      {
        context: {
          id: 'acme-prod',
          displayName: 'ACME Production',
          residency: 'us',
          auditRetentionDays: 90,
          quotas: { maxActiveSessions: 500, dailyTokenUSD: 200 },
          labels: { env: 'production' },
        },
        extensions: {
          allow: ['channel-telegram', 'source-kafka'],
          deny: ['plugin-experimental-*'],
        },
      },
      {
        context: { id: 'beta-tenant' },
      },
    ],
    format: 'yaml',
    rawText: '',
  };
}

function mockDeps(): TenantsCliDeps & { out: string[]; err: string[] } {
  const cap = captureIo();
  return {
    io: cap.io,
    configPath: '/nonexistent/tenants.yaml',
    load: async () => fakeConfig(),
    out: cap.out,
    err: cap.err,
  };
}

describe('tenants-cli', () => {
  describe('tenantsList', () => {
    test('prints a human-readable table with strategy + per-tenant summary', async () => {
      const deps = mockDeps();
      const code = await tenantsList({}, deps);
      expect(code).toBe(0);
      const output = deps.out.join('');
      expect(output).toContain('strategy: bus=per-tenant');
      expect(output).toContain('acme-prod (ACME Production)');
      expect(output).toContain('residency=us');
      expect(output).toContain('beta-tenant');
      expect(deps.err.join('')).toBe('');
    });

    test('--json emits structured output matching the loaded shape', async () => {
      const deps = mockDeps();
      const code = await tenantsList({ json: true }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(deps.out.join(''));
      expect(parsed.strategy.bus).toBe('per-tenant');
      expect(parsed.tenants).toHaveLength(2);
      expect(parsed.tenants[0].id).toBe('acme-prod');
      expect(parsed.tenants[0].quotas.dailyTokenUSD).toBe(200);
    });

    test('error path: missing config file returns 1 with a fix hint', async () => {
      const cap = captureIo();
      const code = await tenantsList(
        {},
        { io: cap.io, configPath: '/definitely-does-not-exist.yaml' },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('no tenants config found');
    });
  });

  describe('tenantsShow', () => {
    test('prints full details for a matching tenant', async () => {
      const deps = mockDeps();
      const code = await tenantsShow({ id: 'acme-prod' }, deps);
      expect(code).toBe(0);
      const output = deps.out.join('');
      expect(output).toContain('tenant: acme-prod');
      expect(output).toContain('displayName: ACME Production');
      expect(output).toContain('residency:');
      expect(output).toContain('maxActiveSessions: 500');
      expect(output).toContain('allow: channel-telegram, source-kafka');
      expect(output).toContain('deny:  plugin-experimental-*');
    });

    test('--json emits a full tenant shape', async () => {
      const deps = mockDeps();
      const code = await tenantsShow({ id: 'acme-prod', json: true }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(deps.out.join(''));
      expect(parsed.id).toBe('acme-prod');
      expect(parsed.quotas.dailyTokenUSD).toBe(200);
      expect(parsed.extensions.allow).toContain('source-kafka');
    });

    test('error path: unknown tenant id returns 1', async () => {
      const deps = mockDeps();
      const code = await tenantsShow({ id: 'nope' }, deps);
      expect(code).toBe(1);
      expect(deps.err.join('')).toContain('tenant "nope" not found');
    });
  });

  describe('tenantsDiff', () => {
    test('config parses: reports the would-be tenant set', async () => {
      const deps = mockDeps();
      const code = await tenantsDiff({}, deps);
      expect(code).toBe(0);
      const output = deps.out.join('');
      expect(output).toContain('would load 2 tenants');
      expect(output).toContain('acme-prod');
      expect(output).toContain('beta-tenant');
    });

    test('--json reports status + tenant ids', async () => {
      const deps = mockDeps();
      const code = await tenantsDiff({ json: true }, deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(deps.out.join(''));
      expect(parsed.status).toBe('ok');
      expect(parsed.tenants).toEqual(['acme-prod', 'beta-tenant']);
    });

    test('error path: loader throws → returns 1', async () => {
      const cap = captureIo();
      const code = await tenantsDiff(
        {},
        {
          io: cap.io,
          configPath: '/nonexistent/tenants.yaml',
          load: async () => {
            throw new Error('tenants config validation failed: <details>');
          },
        },
      );
      expect(code).toBe(1);
      expect(cap.err.join('')).toContain('failed to load tenants config');
    });
  });
});

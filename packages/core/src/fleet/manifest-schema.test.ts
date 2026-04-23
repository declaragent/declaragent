import { describe, expect, test } from 'bun:test';
import { fleetManifestSchema } from './manifest-schema.js';

describe('fleetManifestSchema', () => {
  test('accepts a minimal valid manifest', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [{ id: 'a', path: './agents/a' }],
    });
    expect(result.success).toBe(true);
  });

  test('rejects unknown top-level keys (strict mode)', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [{ id: 'a', path: './agents/a' }],
      secretSauce: 'nope',
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown keys inside an agent entry', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [{ id: 'a', path: './agents/a', weight: 5 }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown keys inside an environment', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [{ id: 'a', path: './agents/a', env: 'shared' }],
      environments: { shared: { tenantsRef: './t.yaml', extraField: 1 } },
    });
    expect(result.success).toBe(false);
  });

  test('accepts deploy target passthrough fields', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [
        {
          id: 'a',
          path: './agents/a',
          deploy: { target: 'cloud-run-a' },
        },
      ],
      deploy: {
        strategy: 'rolling',
        targets: {
          'cloud-run-a': {
            kind: 'gcp-cloud-run',
            region: 'us-central1',
            serviceAccount: 'a@p.iam.gserviceaccount.com',
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts empty agents array (post-init, pre-add)', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [],
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid agent id', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [{ id: '-bad', path: './agents/bad' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects deploy strategy values outside the enum', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [{ id: 'a', path: './agents/a' }],
      deploy: { strategy: 'yolo' },
    });
    expect(result.success).toBe(false);
  });

  test('round-trip — schema.parse(data) == data', () => {
    const data = {
      version: 1 as const,
      name: 'acme',
      description: 'test',
      runtime: { declaragent: '^1.2.0', bun: '>=1.1' },
      agents: [
        { id: 'concierge', path: './agents/concierge', env: 'shared' },
        { id: 'pr-reviewer', path: './agents/pr-reviewer', env: 'shared' },
      ],
      environments: {
        shared: {
          peersRef: './rpc-peers.yaml',
          overrides: { 'pr-reviewer': { secretScopes: ['vault:kv/github'] } },
        },
      },
      rpc: { stampFleetVersion: true },
    };
    const parsed = fleetManifestSchema.parse(data);
    expect(parsed).toEqual(data);
  });

  // ── hosts: block (CONTROL_PLANE_PLAN.md Slice 3, #50) ────────────────
  test('accepts a hosts[] block for cross-host fan-out', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [{ id: 'a', path: './agents/a' }],
      hosts: [
        {
          name: 'prod-us-east-1',
          url: 'https://declaragent-a.internal:9464',
          auth: { bearer: 'env:DECLARA_TOKEN_USE1' },
          timeoutMs: 5000,
        },
        {
          name: 'prod-eu-west-1',
          url: 'http://10.0.0.5:9464',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('rejects duplicate host names', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [],
      hosts: [
        { name: 'a', url: 'http://1' },
        { name: 'a', url: 'http://2' },
      ],
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-URL-safe host names', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [],
      hosts: [{ name: 'has space', url: 'http://1' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects bogus host url', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [],
      hosts: [{ name: 'a', url: 'not-a-url' }],
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown keys inside a host entry (strict)', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [],
      hosts: [{ name: 'a', url: 'http://h', region: 'us' }],
    });
    expect(result.success).toBe(false);
  });

  // ── fleet-level controlPlane: (POST_ENTERPRISE_BACKLOG.md #17) ───────
  test('accepts a fleet-level controlPlane block', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [{ id: 'a', path: './agents/a' }],
      controlPlane: {
        bindAddress: '0.0.0.0',
        idleTimeout: 30,
        auth: {
          enabled: true,
          provider: 'oidc',
          issuer: 'https://id.acme.test',
          audience: 'declaragent',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test('accepts controlPlane with auth disabled', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [],
      controlPlane: {
        auth: { enabled: false },
      },
    });
    expect(result.success).toBe(true);
  });

  test('rejects unknown top-level keys inside controlPlane (strict)', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [],
      controlPlane: {
        bindAddress: '0.0.0.0',
        bogus: true,
      },
    });
    expect(result.success).toBe(false);
  });

  test('hosts[] and controlPlane are orthogonal — both accepted together', () => {
    const result = fleetManifestSchema.safeParse({
      version: 1,
      name: 'acme',
      agents: [],
      hosts: [{ name: 'a', url: 'http://1' }],
      controlPlane: {
        auth: {
          enabled: true,
          provider: 'oauth2-client',
          tokenEndpoint: 'https://id/token',
          clientId: 'cid',
          clientSecretRef: 'env:SECRET',
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

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
});

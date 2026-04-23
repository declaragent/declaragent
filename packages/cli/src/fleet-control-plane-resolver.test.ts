/**
 * Fleet-level `controlPlane:` precedence resolver tests.
 *
 * POST_ENTERPRISE_BACKLOG.md #17. Four ship-gate scenarios:
 *   - fleet-level block present → wins, per-agent blocks warned + dropped
 *   - fleet-level block absent → legacy first-agent fallback + warn rest
 *   - neither set → no middleware + no warnings
 *   - invalid fleet-level block → surfaces warning, falls back to per-agent
 */

import { describe, expect, test } from 'bun:test';
import type { FleetManifest, LoadedControlPlaneAuth } from '@declaragent/core';
import { resolveControlPlaneAuth } from './fleet-control-plane-resolver.js';

const BASE_MANIFEST: FleetManifest = {
  version: 1,
  name: 'test-fleet',
  agents: [{ id: 'a', path: './agents/a' }],
};

const OIDC_CFG: LoadedControlPlaneAuth = {
  provider: 'oidc',
  issuer: 'https://id.test',
  audience: 'declaragent',
};

const OIDC_CFG_ALT: LoadedControlPlaneAuth = {
  provider: 'oidc',
  issuer: 'https://other.test',
  audience: 'other',
};

describe('resolveControlPlaneAuth', () => {
  test('fleet-level block wins over per-agent blocks', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: {
        ...BASE_MANIFEST,
        controlPlane: {
          auth: {
            enabled: true,
            provider: 'oidc',
            issuer: 'https://fleet.test',
            audience: 'fleet-aud',
          },
        },
      },
      perAgentCandidates: [
        { id: 'a', cfg: OIDC_CFG },
        { id: 'b', cfg: OIDC_CFG_ALT },
      ],
    });
    expect(result.source).toBe('fleet');
    expect(result.cfg).toEqual({
      provider: 'oidc',
      issuer: 'https://fleet.test',
      audience: 'fleet-aud',
    });
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('fleet.yaml#controlPlane is set');
    expect(result.warnings[0]).toContain('a');
    expect(result.warnings[0]).toContain('b');
  });

  test('fleet-level block wins without warning when no per-agent blocks exist', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: {
        ...BASE_MANIFEST,
        controlPlane: {
          auth: {
            enabled: true,
            provider: 'oidc',
            issuer: 'https://fleet.test',
            audience: 'fleet-aud',
          },
        },
      },
      perAgentCandidates: [{ id: 'a', cfg: undefined }],
    });
    expect(result.source).toBe('fleet');
    expect(result.warnings).toEqual([]);
  });

  test('fleet-level block with auth disabled resolves to none', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: {
        ...BASE_MANIFEST,
        controlPlane: {
          auth: { enabled: false },
        },
      },
      perAgentCandidates: [{ id: 'a', cfg: OIDC_CFG }],
    });
    expect(result.source).toBe('none');
    expect(result.cfg).toBeUndefined();
    // The override-on-agent warning still fires — the fleet block exists
    // and takes precedence even when it disables auth.
    expect(result.warnings.length).toBe(1);
  });

  test('no fleet-level block → legacy first-agent fallback', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: BASE_MANIFEST,
      perAgentCandidates: [
        { id: 'a', cfg: OIDC_CFG },
        { id: 'b', cfg: OIDC_CFG_ALT },
      ],
    });
    expect(result.source).toBe('agent');
    expect(result.cfg).toBe(OIDC_CFG);
    expect(result.chosenAgentId).toBe('a');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('multiple agents set');
    expect(result.warnings[0]).toContain('b');
  });

  test('no fleet-level block + single per-agent → no warning', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: BASE_MANIFEST,
      perAgentCandidates: [{ id: 'a', cfg: OIDC_CFG }],
    });
    expect(result.source).toBe('agent');
    expect(result.cfg).toBe(OIDC_CFG);
    expect(result.warnings).toEqual([]);
  });

  test('no fleet manifest + no per-agent → none', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: undefined,
      perAgentCandidates: [{ id: 'a', cfg: undefined }],
    });
    expect(result.source).toBe('none');
    expect(result.cfg).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test('single-agent mode (no fleet manifest) honours the per-agent block', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: undefined,
      perAgentCandidates: [{ id: 'solo', cfg: OIDC_CFG }],
    });
    expect(result.source).toBe('agent');
    expect(result.cfg).toBe(OIDC_CFG);
  });

  test('invalid fleet-level block falls back to per-agent with a warning', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: {
        ...BASE_MANIFEST,
        controlPlane: {
          // Missing required `audience` on oidc branch.
          auth: {
            enabled: true,
            provider: 'oidc',
            issuer: 'https://id.test',
          },
        },
      },
      perAgentCandidates: [{ id: 'a', cfg: OIDC_CFG }],
    });
    expect(result.source).toBe('agent');
    expect(result.cfg).toBe(OIDC_CFG);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toContain('fleet.yaml#controlPlane.auth failed validation');
  });

  test('invalid fleet-level block + no per-agent → none with a warning', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: {
        ...BASE_MANIFEST,
        controlPlane: {
          auth: { enabled: true, provider: 'oidc' /* bad */ },
        },
      },
      perAgentCandidates: [{ id: 'a', cfg: undefined }],
    });
    expect(result.source).toBe('none');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('failed validation');
  });

  test('fleet-level oauth2-client config passes through', () => {
    const result = resolveControlPlaneAuth({
      fleetManifest: {
        ...BASE_MANIFEST,
        controlPlane: {
          auth: {
            enabled: true,
            provider: 'oauth2-client',
            tokenEndpoint: 'https://id/token',
            clientId: 'cid',
            clientSecretRef: 'env:SEC',
          },
        },
      },
      perAgentCandidates: [],
    });
    expect(result.source).toBe('fleet');
    expect(result.cfg).toEqual({
      provider: 'oauth2-client',
      tokenEndpoint: 'https://id/token',
      clientId: 'cid',
      clientSecretRef: 'env:SEC',
    });
  });
});

import { describe, expect, it } from 'bun:test';
import { TenantBoundaryError, isTenantBoundaryError } from './boundary-error.js';

describe('TenantBoundaryError', () => {
  it('carries the resource + tenant metadata', () => {
    const err = new TenantBoundaryError({
      sourceTenantId: 'acme-prod',
      targetTenantId: 'beta-tenant',
      resource: 'session',
      resourceId: 'sess-123',
    });

    expect(err.code).toBe('TENANT_BOUNDARY');
    expect(err.name).toBe('TenantBoundaryError');
    expect(err.sourceTenantId).toBe('acme-prod');
    expect(err.targetTenantId).toBe('beta-tenant');
    expect(err.resource).toBe('session');
    expect(err.resourceId).toBe('sess-123');
    expect(err.message).toContain('acme-prod');
    expect(err.message).toContain('beta-tenant');
    expect(err.message).toContain('sess-123');
  });

  it('isTenantBoundaryError narrows correctly', () => {
    const err = new TenantBoundaryError({
      sourceTenantId: 'a',
      targetTenantId: 'b',
      resource: 'event',
      resourceId: 'evt-1',
    });

    expect(isTenantBoundaryError(err)).toBe(true);
    expect(isTenantBoundaryError(new Error('generic'))).toBe(false);
    expect(isTenantBoundaryError('string')).toBe(false);
    expect(isTenantBoundaryError(null)).toBe(false);
  });
});

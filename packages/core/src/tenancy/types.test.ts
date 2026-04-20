import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_TENANT_CONTEXT,
  DEFAULT_TENANT_ID,
  isDefaultTenant,
  resolveTenant,
} from './types.js';

describe('tenancy primitives', () => {
  it('DEFAULT_TENANT_CONTEXT.id matches DEFAULT_TENANT_ID', () => {
    expect(DEFAULT_TENANT_CONTEXT.id).toBe(DEFAULT_TENANT_ID);
    expect(DEFAULT_TENANT_ID).toBe('__default__');
  });

  it('DEFAULT_TENANT_CONTEXT is frozen so reference-equality checks are safe', () => {
    expect(Object.isFrozen(DEFAULT_TENANT_CONTEXT)).toBe(true);
  });

  it('isDefaultTenant recognizes undefined + the DEFAULT_TENANT_ID sentinel', () => {
    expect(isDefaultTenant(undefined)).toBe(true);
    expect(isDefaultTenant(DEFAULT_TENANT_CONTEXT)).toBe(true);
    expect(isDefaultTenant({ id: DEFAULT_TENANT_ID })).toBe(true);
    expect(isDefaultTenant({ id: 'acme-prod' })).toBe(false);
  });

  it('resolveTenant folds undefined to the default context', () => {
    expect(resolveTenant(undefined)).toBe(DEFAULT_TENANT_CONTEXT);
  });

  it('resolveTenant passes through an explicit tenant untouched', () => {
    const ctx = { id: 'acme-prod', displayName: 'ACME Production' };
    expect(resolveTenant(ctx)).toBe(ctx);
  });
});

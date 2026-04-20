import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '../events/types.js';
import { stampTenantId } from './stamp.js';
import { DEFAULT_TENANT_CONTEXT } from './types.js';

function makeEvent(meta?: AgentEvent['meta']): AgentEvent {
  const base: AgentEvent = {
    id: 'evt-1',
    kind: 'user.input',
    source: { type: 'user', sessionId: 'sess-a' },
    target: { type: 'session', sessionId: 'sess-a', mode: 'inject' },
    timestamp: 0,
    payload: {},
    auth: { kind: 'internal' },
  };
  return meta ? { ...base, meta } : base;
}

describe('stampTenantId', () => {
  it('returns the input unchanged when tenant is undefined', () => {
    const event = makeEvent();
    expect(stampTenantId(event, undefined)).toBe(event);
  });

  it('returns the input unchanged when tenant matches and tenantId is already set', () => {
    const event = makeEvent({ tenantId: 'already-set' });
    expect(stampTenantId(event, DEFAULT_TENANT_CONTEXT)).toBe(event);
  });

  it('preserves an explicit tenantId even when it does not match the resolver tenant', () => {
    // Slice 1 does not enforce cross-tenant checks — that is slice 6.
    // Here we simply leave pre-set values untouched.
    const event = makeEvent({ tenantId: 'tenant-a' });
    const out = stampTenantId(event, { id: 'tenant-b' });
    expect(out).toBe(event);
    expect(out.meta?.tenantId).toBe('tenant-a');
  });

  it('stamps the tenant id when meta is absent', () => {
    const event = makeEvent();
    const out = stampTenantId(event, { id: 'acme-prod' });
    expect(out).not.toBe(event);
    expect(out.meta?.tenantId).toBe('acme-prod');
    expect(event.meta).toBeUndefined(); // input untouched
  });

  it('stamps the tenant id when meta is present but tenantId is unset', () => {
    const event = makeEvent({ correlationId: 'corr-1' });
    const out = stampTenantId(event, { id: 'acme-prod' });
    expect(out).not.toBe(event);
    expect(out.meta?.correlationId).toBe('corr-1');
    expect(out.meta?.tenantId).toBe('acme-prod');
    // original meta object untouched
    expect(event.meta?.tenantId).toBeUndefined();
  });

  it('stamps the DEFAULT_TENANT_ID sentinel when passed the default context', () => {
    const event = makeEvent();
    const out = stampTenantId(event, DEFAULT_TENANT_CONTEXT);
    expect(out.meta?.tenantId).toBe('__default__');
  });
});

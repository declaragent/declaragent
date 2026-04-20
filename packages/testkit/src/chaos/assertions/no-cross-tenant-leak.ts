import type { ChaosAssertion, ChaosAssertionResult, ChaosSnapshot } from '../types.js';

/**
 * Phase 6 slice-7 `no-cross-tenant-leak` assertion.
 *
 * Two invariants:
 *   1. When the snapshot is tenant-scoped (`snapshot.tenantId` set),
 *      every audit record belongs to that tenant.
 *   2. Zero `tenant_boundary_violation` records should surface during
 *      a well-behaved run. Any is a red-line event.
 */

export const noCrossTenantLeakAssertion: ChaosAssertion = {
  name: 'no-cross-tenant-leak',
  check(snapshot: ChaosSnapshot): ChaosAssertionResult {
    const scoped = snapshot.tenantId;
    const leaks: Array<{ seq: number; kind: string; tenant?: string }> = [];
    let boundaryViolations = 0;
    for (const entry of snapshot.auditRecords) {
      const record = entry.record;
      if (record.kind === 'tenant_boundary_violation') {
        boundaryViolations += 1;
        leaks.push({
          seq: entry.seq,
          kind: record.kind,
          tenant: `${record.sourceTenantId}→${record.targetTenantId}`,
        });
        continue;
      }
      if (scoped === undefined) continue;
      const recordTenant =
        record.kind === 'erased'
          ? record.tenantId
          : 'tenantId' in record
            ? record.tenantId
            : undefined;
      if (recordTenant !== undefined && recordTenant !== scoped) {
        leaks.push({ seq: entry.seq, kind: record.kind, tenant: recordTenant });
      }
    }
    if (leaks.length === 0) {
      return {
        name: 'no-cross-tenant-leak',
        ok: true,
        message: scoped
          ? `audit records all scoped to ${scoped} (${snapshot.auditRecords.length} checked)`
          : 'no tenant_boundary_violation records observed',
      };
    }
    return {
      name: 'no-cross-tenant-leak',
      ok: false,
      message: `${leaks.length} cross-tenant leak(s) observed (${boundaryViolations} boundary violations)`,
      details: { leaks: leaks.slice(0, 50) },
    };
  },
};

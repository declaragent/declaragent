# `TenantBoundaryViolationObserved`

**Severity:** critical.

## Symptom
A `tenant_boundary_violation` record appeared in the audit sink. One
tenant attempted to access another tenant's resource.

## Likely cause
1. Misconfigured skill or plugin holds a cached handle from a prior tenant.
2. A shared subscriber wasn't tenant-filtering events correctly.
3. Malicious / probing behavior inside a multi-tenant deployment.

## Immediate mitigation
The runtime ALREADY blocked the access — the throw of `TenantBoundaryError`
is the same signal that populates this alert. No further mitigation is
needed at the data-plane layer.

If the source tenant is a known-good tenant acting unexpectedly, pause
its runtime to stop further attempts while investigating:

```bash
declaragent tenants pause <sourceTenantId>
```

## Root-cause investigation
```bash
# Full violation record (includes resource + resource id):
declaragent audit query --kind tenant_boundary_violation --since -1h --json

# Correlate with the source tenant's recent activity:
declaragent audit query --tenant <sourceTenantId> --since -1h --json | head -200
```

If the violation came from a skill or plugin, audit that extension's
scope config — the one-line bug is usually a forgotten
`deps.tenant?.id` propagation.

## Post-incident
- Capture: violation details, offending extension, fix commit.
- Close when: no further violations observed for 24h.
- Post-mortem: **mandatory** for Phase-6 — every boundary violation is
  a red-line event and feeds into the phase's acceptance criteria.

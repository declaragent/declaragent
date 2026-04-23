---
'@declaragent/cli': patch
---

fleet render: ServiceMonitor splits into `agents/<id>-servicemonitor.yaml` so operators on vanilla Prometheus can delete the Prometheus Operator CRD without touching core workload manifests. Default-on preserved; `--no-servicemonitor` still opts out, and `--with-servicemonitor` is documented as the explicit positive form. (#31)

audit sink: `TenantAuditSink` handle is now ref-counted across `up` and `fleet run`. The new `acquireTenantAuditSink({ path, owner })` / `releaseTenantAuditSink({ path, owner })` API in `audit-sink-singleton.ts` keeps same-path callers on ONE SQLite connection; the underlying sink closes only after the last owner releases. (#40)

CI: `prod smoke — kafka source end-to-end` workflow was failing on every push-to-main because its inline `event-sources.yaml` lacked the `delivery` + `limits` blocks that the kafka source config validator has required since 0.6.x. Both blocks now supplied. (#47)

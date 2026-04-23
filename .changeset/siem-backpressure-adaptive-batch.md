---
'@declaragent/core': patch
---

feat(siem): back-pressure pause after backlog threshold + adaptive batch interval

- New `BackpressureController` (`createBackpressureController`) coordinates a pause on NEW audit writes when the SIEM export backlog (oldest unshipped row age) exceeds a configurable threshold (default 1 h). `createSqliteAuditSink` accepts the controller via a new `backpressure` option; `sink.record()` consults it before every write.
- Two policies — `fail-fast` (default; throws `AuditBackpressureError` so callers surface the outage) and `drop` (silently counts drops via Prometheus). The fail-fast default preserves the hash-chain invariant; `drop` is opt-in for callers that would rather shed load than back-pressure a hot path.
- `startAuditExportLoop` gains a `backpressure: { enabled, pauseAfterBacklogMs, evaluateIntervalMs, controller }` option. A separate timer evaluates the threshold (default every 30 s) via the new `TenantAuditSink.oldestUnshippedMs` method. Pause engages above threshold, resumes automatically once the queue drains back under.
- New metrics: `declaragent.audit.backpressure.paused_total`, `declaragent.audit.backpressure.active`, `declaragent.audit.backpressure.drops_total`, `declaragent.audit.backpressure.backlog_ms`.
- `startAuditExportLoop` gains a `batch: { minIntervalMs, maxIntervalMs, targetBatchRows }` option that turns the fixed tick cadence into a simple proportional controller. Bursts (batch hits `batchSize` cap) halve the interval toward `minIntervalMs`; idle queues relax toward `maxIntervalMs`; steady state where shipped ≈ target stays put. Solves the "10k tool-calls/sec produces 100k-row batches that OOM the shipper" problem called out in POST_ENTERPRISE_BACKLOG.md #12.
- New metrics: `declaragent.audit.batch.interval_ms` gauge + `declaragent.audit.batch.rows` histogram (geometric buckets up to 50k).
- Both features are opt-in; omitting the new options preserves pre-0.7.4 behaviour (unbounded intake, fixed 10 s cadence).

Backlog: POST_ENTERPRISE_BACKLOG.md #11, #12.

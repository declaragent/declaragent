---
'@declaragent/core': minor
'@declaragent/testkit': minor
---

Phase 6 slice 2: observability maturation.

- **Prometheus exposition**. New `createPrometheusRegistry()` +
  `startPrometheusExporter()` in `@declaragent/core`. Registry is a
  stateful `MetricsRegistry` that retains per-(metric, label-set) state
  so scrapes produce a point-in-time snapshot. Exporter binds a Bun
  HTTP server (default `127.0.0.1:9464/metrics`) with localhost-only
  gating. Metric-name normalization maps dotted internal identifiers
  (`source.messages.processed`) to Prometheus-valid wire names
  (`source_messages_processed`).
- **Alert rule files**. `packages/testkit/alerts/` ships six rule
  documents (channels, event-sources, whatsapp-windows, security,
  chaos-assertions, daemon) keyed on metrics emitted by Phase-4 and -5.
  Every alert includes `severity`, `summary`, `description`, and
  `runbook_url` — locked in by a new `packages/testkit/test/alerts.test.ts`.
- **Runbooks**. 23 operator runbooks under `docs/runbooks/` following
  the §4.4 Symptom → Cause → Mitigation → RCA → Post-incident template.
- **Correlation-id audit**. `ToolContext` grows an optional
  `correlationId` field; the engine threads `input.causedBy` through.
  The Agent tool now inherits the parent's correlation id on sub-agent
  spawn instead of re-rooting on the parent session id.
- Wires `yaml` (2.8.3) as a runtime dep of `@declaragent/testkit`.

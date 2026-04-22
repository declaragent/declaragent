---
'@declaragent/cli': minor
---

**Slice 1 of 0.6.0 production hardening — Prometheus `/metrics` endpoint wired into `declaragent up`.**

`up` now constructs a shared `PrometheusRegistry` and threads it through `startAgentSources` + `startChannelRuntime` via `deps.metrics`. Every source and channel adapter that already writes to `deps.metrics` (external broker adapters, `BaseChannelInstance` counters) automatically surfaces samples through `/metrics` with no adapter changes.

An HTTP exporter binds to `127.0.0.1:9464` (OTel convention) by default in detached mode (`up -d`). Foreground mode stays quiet unless `DECLARAGENT_METRICS_PORT` is set. Set `DECLARAGENT_METRICS_PORT=0` to disable entirely; any other valid port number overrides the default.

Exposition format is OpenMetrics text, served by the existing `startPrometheusExporter` from `@declaragent/core/observability/prometheus`. Remote scrapes are rejected by default (localhost only) — matches the Phase-3 daemon control-socket posture.

Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 1 (PR 1.2; PR 1.1 shipped previously as Phase 6 slice 2).

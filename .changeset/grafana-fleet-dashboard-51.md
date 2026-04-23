---
'@declaragent/cli': patch
---

docs(observability): ready-made Grafana dashboard aggregating the key fleet counters (#51)

Ships `docs/grafana/declaragent-fleet-dashboard.json` — a single importable Grafana dashboard with three rows: **MCP health** (`mcp_server_restarts_total`, `mcp_server_circuit_state`, `mcp_server_circuit_open_total`, `mcp_server_drain_duration_ms`, `mcp_server_rate_limited_total`), **Audit + SIEM** (back-pressure active + backlog_ms, adaptive batch interval + rows, export acked / failures / last_seq), and **Rate limits + dispatch** (provider + tool waits, `source_messages_*`, `source_inflight`). Default 15m range, 30s refresh, three template variables (`server_id` / `agent` / `source`).

Companion files:

- `docs/grafana/README.md` — UI / HTTP-API / grafana-operator ConfigMap import flavors, Prometheus scrape config for the CLI's `127.0.0.1:9464`, panel-by-panel alert thresholds keyed to the runbook index.
- `docs-site/docs/reference/observability.mdx` — canonical Prometheus metric index (MCP, audit, rate-limit, source, channel) with file:line source pointers, cross-linked to the dashboard.
- `docs/grafana/dashboard.test.ts` — lightweight structural validator (JSON parse, three expected row titles, every README-promised metric referenced by at least one panel target, template-variable presence).

Operators importing the dashboard only need `DS_PROMETHEUS` pointed at a Prometheus scraping `declaragent up`'s `/metrics` endpoint — no CLI flags added, no runtime behaviour change.

Naming call-out: the runtime exposes `declaragent_audit_backpressure_backlog_ms` (age of oldest unshipped audit row, in ms) as the time-based analogue to the backlog-row-name `audit_export_queue_depth` referenced in earlier planning docs. The dashboard + README call this out explicitly.

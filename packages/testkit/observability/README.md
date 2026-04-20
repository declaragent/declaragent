# Observability stack

Runnable OTel → Prometheus → Grafana + Jaeger fixture for local development. Referenced from `docs/OTEL_SETUP.md`.

```bash
docker compose up -d
```

| Component | URL | Purpose |
|---|---|---|
| OTel collector | `http://localhost:4318` (OTLP HTTP) | Host app exports metrics + spans here. |
| Prometheus | `http://localhost:9090` | Scrapes collector's Prometheus exporter on `:9464`. |
| Grafana | `http://localhost:3000` (admin/admin) | Pre-provisioned with Prometheus + the declaragent dashboards. |
| Jaeger | `http://localhost:16686` | Span browser for the `declaragent-host` service. |

Dashboards in `../dashboards/` are mounted into the Grafana container and auto-registered by the `grafana-dashboards.yml` provider. Drop new JSON files into `../dashboards/` and they'll appear in Grafana within 30 seconds.

## Pointing a declaragent host at this stack

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=declaragent-host
bun run your-entrypoint.ts
```

The host code that wires `createOtelBridge()` into `SourceDependencies` is in `docs/OTEL_SETUP.md` §2.

## Teardown

```bash
docker compose down -v
```

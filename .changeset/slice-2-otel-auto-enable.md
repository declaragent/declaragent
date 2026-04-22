---
'@declaragent/cli': minor
---

**Slice 2 of 0.6.0 production hardening — OpenTelemetry auto-enable.**

`declaragent up` now auto-wires `createOtelBridge()` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No code changes, no flags — install the peer deps (`@opentelemetry/api` + an SDK + OTLP trace exporter) and set the env var. Every source and channel receives the bridged tracer via `deps.tracer`, so `BaseSourceInstance`'s `source.message` spans export to your OTLP collector.

Fallback behavior: if the env var is set but `@opentelemetry/api` isn't installed, `up` prints a one-line warning with the exact `npm i` command and continues with the noop tracer. The boot loop never blocks on OTel.

Metrics stay in the Prometheus registry (Slice 1) — we keep OTel for tracing only. Operators who want metrics in OTel too should run an OTel collector with the Prometheus receiver in front; the existing `OTEL_SETUP.md` §5 recipe still applies.

Plan reference: `docs/RELEASE_0_6_0_PLAN.md` Slice 2. Docs: `docs/OTEL_SETUP.md` §1.

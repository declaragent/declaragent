# Prometheus alert rules

Six rule files shipped with Phase 6 slice 2. Every alert is paired with a
runbook under `docs/runbooks/` per the §4.4 template in `PHASE_6_PLAN.md`.

| File                              | What it watches                                                   |
| --------------------------------- | ----------------------------------------------------------------- |
| `channels.rules.yaml`             | Outbound failure rate, rate-limit sustained retries, p99 latency. |
| `event-sources.rules.yaml`        | Sustained lag, DLQ growth, connection-error storms, stalls.       |
| `whatsapp-windows.rules.yaml`     | Template reject spikes, conversation-window surges, tier health.  |
| `security.rules.yaml`             | Secret-access denial bursts, tenant boundary violations.          |
| `chaos-assertions.rules.yaml`     | Chaos-soak SLO assertions (`chaos_run="true"` label).             |
| `daemon.rules.yaml`               | Bus in-flight stalls, heartbeat timeouts, session spawn stalls.   |

## Loading

Every file is standard Prometheus alerting-rule YAML. Mount the directory
into your Prometheus config:

```yaml
rule_files:
  - /etc/declaragent/alerts/*.yaml
```

The `packages/testkit/observability/prometheus.yml` compose config does
this automatically when the container is started with the testkit's
docker-compose stack.

## Verification

Every rule parses cleanly via `promtool check rules` — run:

```bash
promtool check rules packages/testkit/alerts/*.yaml
```

If you don't have `promtool` locally, a convenience script lives at
`packages/testkit/scripts/check-alert-rules.ts` and fires the same
validation from within Bun (slice-2 follow-up if not yet present).

## Metric naming convention

Our source code uses dotted metric names (`source.messages.processed`,
`channel.outbound.latency_ms`). The Prometheus exporter normalizes these
to underscore form at scrape time (see
`packages/core/src/observability/prometheus.ts`). The rules reference the
normalized wire names, e.g. `source_messages_processed`.

## Late-binding metrics

A few rules (`security.rules.yaml`, `chaos-assertions.rules.yaml`, parts
of `whatsapp-windows.rules.yaml` and `daemon.rules.yaml`) reference
metrics that later Phase-6 slices emit (audit sink, secret resolver,
chaos harness). Prometheus treats a non-existent metric as an empty
vector, so nothing fires until the producer lands. This keeps the
operator config complete across the whole phase without landing a
rolling wave of PRs.

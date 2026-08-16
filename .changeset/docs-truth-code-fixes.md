---
"@declaragent/core": minor
"@declaragent/cli": patch
"@declaragent/plugin-agent-rpc": minor
"@declaragent/testkit": patch
---

Docs-truth pass — code fixes (the four places the docs wrote a check the code should cash):

- **`DECLARAGENT_CONFIG_DIR` is now honored** by `configDir()` (the deploy-generated Dockerfile always set it to `/etc/declaragent`, but the runtime never read it — the container config mount was dead weight). An explicit `root` argument (the test seam) still wins over the env var. The generated Dockerfile's `ENTRYPOINT` also fixed from the non-existent `run` verb to `up`.
- **`fleet run`'s provider is now rate-limited** with the same token bucket as `up` — the shared wrap lives in `packages/cli/src/provider-rate-limit.ts` (same per-provider defaults, same `DECLARAGENT_PROVIDER_RATE_LIMIT_{RPS,DISABLE}` escape hatches). Previously `fleet run` built a bare provider, so "token bucket wraps every provider" held for `up` only.
- **MCP stdio kill-on-close**: closing the adapter now sends `SIGTERM` immediately and falls back to `SIGKILL` after a 5-second grace (`STDIO_KILL_GRACE_MS`), so a hung server can no longer stall shutdown forever — making THREAT_MODEL's kill-on-shutdown mitigation true. Tested against a TERM-ignoring child.
- **Peer dependencies declared**: `@declaragent/core` declares `@opentelemetry/api` / `@opentelemetry/sdk-node` / `@opentelemetry/exporter-trace-otlp-http` as optional peerDependencies (the documented OTel setup previously relied on undeclared packages), and `@declaragent/plugin-agent-rpc` declares `kafkajs` / `@aws-sdk/client-sqs` / `amqplib` / `mqtt` as optional peers mirroring its existing `nats` entry.
- **Generated deploy README** now includes the binary/config staging steps the Dockerfile requires and the webhook-port note (`EXPOSE 8787` vs the source default 7777).
- Testkit dashboards + alert rules corrected to query metric names the exporter actually emits (no `_total` suffixing on counters); rules contracted on not-yet-emitted metrics are annotated in-file.

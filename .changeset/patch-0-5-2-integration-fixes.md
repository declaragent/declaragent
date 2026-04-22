---
'@declaragent/cli': patch
---

Patch 0.5.2 — three integration fixes surfaced by the fleet-test run against 0.5.1.

- **Bug 1 — `MessageNormalizer` missing from source deps.** `startAgentSources` now constructs a shared `createMessageNormalizer()` and threads it through `SourceDependencies.normalizer` when creating every adapter instance. Before this fix, `BaseSourceInstance.handleMessage()` saw `deps.normalizer === undefined`, logged `base-source.no-normalizer`, and silently ack'd + dropped every Kafka/NATS/SQS/AMQP/MQTT message — the event never reached the store. Built-in webhook/cron/file-watch adapters don't consume `deps.normalizer`, so the change is additive.

- **Bug 2 — compiled `declaragent` binary couldn't resolve external adapters.** `bun build --compile` produces a single-file executable whose internal resolver intercepts bare module specifiers and has no on-disk `node_modules` to walk. A dynamically-imported adapter's `import '@declaragent/core'` failed with `Cannot find module`. The npm launcher at `packages/cli/bin/declaragent.js` now prefers `bun dist/index.js` whenever `bun` is on `PATH` and the JS dist is present — that path runs against the real filesystem, so external adapters load. The compiled binary remains the fallback when Bun isn't installed. Override with `DECLARAGENT_USE_BINARY=1` to force the old path.

- **Bug 3 — new `prod-smoke-kafka.yml` CI workflow.** `npm install @declaragent/cli@latest @declaragent/source-kafka@latest`, scaffold a one-agent Kafka-source fleet, produce a JSON message on `smoke.input`, assert the event appears in `declaragent events list` within 30s. Triggers on push to main + a 6h cron + manual dispatch. The two pre-existing smoke workflows only exercised `declaragent --version`; this one is the first lane that exercises an adapter discovery + broker round-trip against the published tarballs.

---
"@declaragent/testkit": patch
---

0.8.0 mixed-version rolling-upgrade rehearsal (RELEASE_0_8_0_PLAN.md §5): `rolling-upgrade.test.ts` boots the PUBLISHED `@declaragent/cli` from npm (configurable via `DECLARAGENT_REHEARSAL_OLD_VERSION`, default `latest`) and the working-tree CLI as two single-agent fleets over a live Kafka broker, `rpc.auth` on with hmac on every peer, and asserts the mixed-version wire contract: signed round-trips to both sides (the old side's response-signing assertion is version-aware — `internal` at 0.7.7, required `hmac` from 0.7.8), and fail-closed `AUTH_REJECTED` for unsigned and unregistered senders (with the rejection itself signed when the destination is a registered peer). Dispatchable via the new `rolling-upgrade.yml` workflow; gated `ROLLING_UPGRADE=1` + `KAFKA_BROKERS`.

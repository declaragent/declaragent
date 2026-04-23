---
'@declaragent/plugin-agent-rpc': patch
---

`createNatsTransport` now accepts `queueGroups` as either a blanket string (same semantics as the legacy `queueGroup`) or a per-topic `Record<topic, group>` map. Real fleets routinely mix load-balanced and fan-out topologies on one NATS cluster — `agents.beta.requests` needs a shared queue so replicas load-balance, while `agents.broadcast.health` needs no queue so every replica sees the heartbeat. A single construction-time queue group can't express both; the new shape does.

Backward compatible: the pre-existing `queueGroup` option keeps working and now acts as the fallback for topics unlisted in `queueGroups`. An explicit empty-string entry opts that topic out of any queue group. Addresses post-enterprise backlog item #25.

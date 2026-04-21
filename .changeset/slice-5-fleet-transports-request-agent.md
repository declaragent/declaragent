---
'@declaragent/cli': minor
---

`declaragent fleet run` now respects every transport kind declared in `capabilities.yaml` and wires a `RequestAgent` built-in into each agent's engine.

**Transport dispatch**: the daemon builds a shared `transports: Map<RpcTransportKind, RpcTransport>` keyed on kind. `memory` is always present (the in-process dev loop still works). Other kinds (kafka/nats/sqs/amqp/mqtt) pull from a new `transportFactories?` option on `startFleetDaemon`. When a declared kind has no factory wired, the daemon warns + skips that kind instead of silently ignoring it — the 0.4.x behavior that made non-memory transports look supported when they weren't.

**Per-agent RPC context**: the `makeHandler` signature expanded from `(agent)` to `(agent, rpcContext)`. The new `FleetAgentRpcContext` carries `selfAddress`, the shared `transports` map, and — when `rpc-peers.yaml` was supplied — the parsed `LoadedPeers` table. The existing single-arg handler shape remains compatible.

**RequestAgent built-in**: when `rpc-peers.yaml` is present in the fleet root, `createLLMHandlerFactory` appends a `RequestAgent` tool to the per-agent tool list via `buildRuntimeTools({ extra })`. Skills can now call peers declaratively without any manual plugin wiring. A fresh pending-registry is constructed per handler for correlation bookkeeping.

**`fleetRun` verb**: loads `<fleet-root>/rpc-peers.yaml` when present; warns and continues when the file exists but is malformed.

Non-memory transport implementations (`@declaragent/plugin-agent-rpc-kafka`, etc.) are not published in this slice — the hooks let callers or a future slice plug them in.

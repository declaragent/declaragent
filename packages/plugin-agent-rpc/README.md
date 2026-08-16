# @declaragent/plugin-agent-rpc

Agent-to-agent RPC runtime for Declaragent.

This package provides:
- `RequestAgent` — the producer-side tool that calls capabilities on peer agents.
- `agent-inbox` — an `EventSourceAdapter` that subscribes to request / response
  topics and dispatches by envelope `kind`.
- `createRespondHook` — builds the `ctx.respond` helper wired into skills
  triggered by an RPC request.
- Broker transport factories — `createKafkaTransport`, `createNatsTransport`,
  `createJetStreamTransport`, `createSqsTransport`, `createAmqpTransport`,
  `createMqttTransport` (each loads its broker client as a dynamic peer dep).
- Auth providers — `createOidcAuthProvider`, `createOAuth2ClientAuthProvider`
  for verified inter-agent envelopes.
- `createMemoryTransport` / `createMemoryBus` — an in-memory `RpcTransport`
  for tests and single-process multi-agent demos.

The wire format, peer registry, and capabilities config are all declared in
`@declaragent/core` (under `src/rpc/`); this package never touches the wire
format directly except via those types.

See `docs/AGENT_RPC_PLAN.md` for the full spec.

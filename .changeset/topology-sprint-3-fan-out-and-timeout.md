---
'@declaragent/core': patch
'@declaragent/cli': patch
---

control-plane: multi-agent fan-out for `/events` + `/dlq` + `/logs` via
`?all=1`, plus `idleTimeout` narrowing so only `/logs` holds long-lived
streams (backlog #19, #20, #21).

- `/events` + `/dlq` accept `?all=1` when a `fanOut` provider is wired.
  Rows are merged DESC by timestamp across every hosted agent's store
  and tagged with `agentId`. Single-agent responses stay byte-identical
  to the pre-0.7.3 wire shape (no `agentId` key, back-compat).
- `/logs` accepts `?all=1` and enforces a `fanOutLimit` soft cap
  (default 50) — returns HTTP 413 with `{error, limit, requested}` when
  the hosted-agent count exceeds the cap. Operators raise the cap via
  `logs.fanOutLimit`. Per-agent chunk emission is coalesced within a
  configurable `coalescePerAgentMs` window (CLI default 25ms) so a
  chatty agent can't saturate the SSE socket during a fan-out.
- Fan-out scope gating: the server surfaces a synthetic
  `${path}?all=1` key to the auth middleware so operators can require
  a dedicated scope on the fan-out variant via
  `controlPlane.auth.routeScopes: { "/events?all=1": ["control:fan-out"] }`
  without tightening the single-agent floor.
- `idleTimeout` narrowed from a global `0` (every route) to `30s`
  server-level with `server.timeout(req, 0)` applied per-request only
  for streaming routes in `STREAMING_ROUTE_PATHS` (today just `/logs`).
  Short-lived JSON routes now get idle-abort protection back.

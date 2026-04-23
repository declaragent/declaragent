---
'@declaragent/core': patch
---

feat(mcp): graceful draining of in-flight tool calls across respawn + per-server aggregate rate-limit cap

**#13 — Graceful drain during respawn.** When the MCP supervisor triggers a
respawn (crash, ping-failure, config reload, probe), it now waits up to
`drainTimeoutMs` (default 5 s) for in-flight tool calls to complete before
tearing the client down. New supervisor state `draining` blocks new calls
during the window. Calls that finish inside the window return their response
normally. Calls that miss the window either (a) reject with a typed
`ToolCallDrainedError` (default — carries `toolName` + `argSnapshot` so the
caller can decide), or (b) are transparently re-issued against the fresh
client when `resubmitOnRespawn: true` is set (opt-in for idempotent tools).
Second respawn trigger arriving mid-drain cancels the drain cleanly and
supersedes — no queue, no hang. New histogram
`mcp_server_drain_duration_ms{server_id, outcome}` tracks completed vs.
timed-out drains.

**#27 — Per-MCP-server aggregate rate-limit cap.** Adds `rateLimit: { rps, burst }`
to `createMCPSupervisor`. A token bucket on the whole server sits ABOVE any
per-tool gate (`ToolRateLimitGate`) — a distributed spike across every tool
still gets shed with `MCPServerRateLimitedError` (code `MCP_RATE_LIMITED`)
before the per-tool gate is even consulted. Fails fast (no sleep), so the LLM
tool-use loop sees a typed error and can back off. New counter
`mcp_server_rate_limited_total{server_id, reason="aggregate"}`. Also exposes
the new `ProviderTokenBucket.tryTake()` non-blocking primitive used by the
aggregate gate.

New exports: `ToolCallDrainedError`, `MCPServerRateLimitedError`,
`MCPServerRateLimitConfig`, plus the extended `MCPSupervisorState`.

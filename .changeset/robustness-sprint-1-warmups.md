---
'@declaragent/core': patch
---

**Robustness warmups for `@declaragent/cli@0.7.1` — MCP + per-tool rate limit polish.**

Four small fixes bundled from the post-enterprise backlog (`docs/POST_ENTERPRISE_BACKLOG.md` rows #14, #28, #29, #30):

- **#14 Dedicated `mcp_server_circuit_open_total` counter.** The labeled `mcp_server_circuit_state` gauge is kept, but alertmanager rules are much simpler against a counter — `increase(mcp_server_circuit_open_total[5m]) > 0` fires exactly once per `closed | half-open → open` transition. Registered alongside the existing MCP supervisor metrics in `packages/core/src/mcp/supervisor.ts`.

- **#28 `burst = 2 × rps` default** for `createToolRateLimitGate` (per-tool rate limits, `packages/core/src/tools/rate-limit-gate.ts`). Matches classic token-bucket wisdom: one second of steady-state headroom plus one second of catch-up for transient spikes. Explicit `burst` values pass through unchanged. The provider-level limiter in `packages/core/src/providers/rate-limit.ts` is intentionally untouched.

- **#29 Audit threshold comparator `>` → `>=`.** Previously `rps=1` (1000 ms wait) sat silently on the 1 s default threshold and never emitted a `rate_limited` audit record. Now it does. Zero-ms (immediate) calls still never audit.

- **#30 `mcp.supervised` recipe** — new subsection in `docs-site/docs/reference/agent-yaml.mdx` showing how to use the list form to exclude a flaky server for debugging while the rest of the fleet keeps auto-recovering.

No user-facing config changes beyond the defaults; no peer-dep cascade.

---
'@declaragent/core': minor
'@declaragent/cli': minor
---

Add SSE (2024-11-05 spec) and streamable HTTP (2025-03-26 spec) MCP transports.

**SSE** — `createSSEMCPClient` opens a GET `text/event-stream` to the configured URL, waits for the server's `event: endpoint` frame, then POSTs outbound JSON-RPC messages to the discovered endpoint URL. Inbound responses + notifications flow back on the SSE stream. Covers the older remote transport that many 2024-era hosted MCP servers still use.

**Streamable HTTP** — `createStreamableHTTPMCPClient` uses a single URL for both directions. Each `request()` POSTs a message; the server responds with either `application/json` (single reply) or `text/event-stream` (one or more JSON-RPC frames bundled on the response — typically the matching reply plus any notifications the server wants to piggyback). `Mcp-Session-Id` response header is captured and echoed on subsequent requests for server-side session continuity.

`declaragent up`'s `defaultSpawn` dispatches across all four transports (stdio, http, sse, http-streamable). `PluginMCPServerSpec.transport` now uses the full `MCPTransportConfig` union.

Not yet implemented: session resumption via `Last-Event-Id`, dedicated server→client notification streams on streamable HTTP, OAuth PKCE auth (slice 2d).

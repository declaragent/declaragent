---
'@declaragent/core': minor
'@declaragent/cli': minor
---

Add HTTP transport for MCP clients. `createHTTPMCPClient` + `createHTTPConnection` in `@declaragent/core` implement plain JSON-RPC over HTTP POST — each request is one fetch, response body is the JSON-RPC reply. Custom headers from `transport.headers` are forwarded verbatim (covers static bearer-token auth; OAuth PKCE lands in slice 2d). Notifications are no-op on the client side since plain HTTP has no server→client push channel.

`declaragent up` now dispatches on `transport.type`: `stdio` servers spawn subprocesses (unchanged), `http` servers bind a remote endpoint. This lights up hosted MCP servers configured with `{ type: 'http', url: '...' }` in any of the three scopes.

SSE + streamable HTTP transports (needed for most 2026-era remote servers that push notifications) land in slice 2c; OAuth in 2d.

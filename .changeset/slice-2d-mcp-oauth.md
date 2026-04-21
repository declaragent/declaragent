---
'@declaragent/core': minor
'@declaragent/cli': minor
---

Add OAuth 2.1 + PKCE for remote MCP servers. Remote servers that require auth (Atlassian MCP, hosted github.com MCP, etc.) now work without users hand-crafting tokens.

**Flow** (matches Claude Code's MCP story):
1. `declaragent mcp login <name>` discovers the auth server via `/.well-known/oauth-protected-resource` → `/.well-known/oauth-authorization-server` (with OpenID Connect fallback).
2. If the server advertises a `registration_endpoint`, dynamic client registration (RFC 7591) happens automatically so users don't need to hand-register an app.
3. PKCE S256 flow against the advertised authorization endpoint with a localhost callback on ports 38700–38705.
4. Token persisted per-server in `~/.declaragent/mcp-oauth.json` (mode 0600).

**Runtime integration**: http / sse / http-streamable transports accept `getAuthHeader` (re-read on every request, enabling token rotation) and `onAuthError` (called on 401 to trigger refresh). `declaragent up` wires these automatically against the stored tokens. A 401 triggers a refresh_token grant; if that fails, the request propagates up so the user sees a clear error and can re-run `mcp login`.

**New verbs**: `declaragent mcp login <name>` + `declaragent mcp logout <name>`. `oauth-pkce.ts` extracts the PKCE primitives (code_verifier, code_challenge, callback server, browser open) into a provider-agnostic module so the same code path powers future OAuth flows.

Not yet implemented: automatic login on first-401 if no token exists (user must run `mcp login` once first), confidential clients (only `token_endpoint_auth_method: none` is supported today).

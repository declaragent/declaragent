---
'@declaragent/core': minor
'@declaragent/cli': minor
---

Add `@<server>:<uri>` MCP resource references. Skills (and REPL messages) can write tokens like `@github:issue://42` and have the referenced resource fetched + inlined as a fenced block at send-time — the same shape as `@<path>` file refs.

**Core additions**:
- `MCPClient.readResource(uri, signal?)` — new method on every transport (stdio/http/sse/streamable) that issues the MCP `resources/read` JSON-RPC call and returns the `MCPResourceContents[]` payload.
- `MCPResourceContents` type exported.

**CLI additions**:
- `MCPRuntime.getClient(serverName)` — look up a live MCP client so callers (REPL/pipeline) can expand resource refs on demand.
- `expandAgentRefs(text, options)` — async extension of `expandFileRefs` that handles BOTH `@<path>` and `@<server>:<uri>` in one pass. Composes a single "Attached references" block at the end of the message. Unknown server → ref is reported as a miss + original text preserved. Bodies cap at `MAX_ATTACHMENT_BYTES` (256 KB), same as file refs.

The file-ref regex now uses a negative lookahead `(?![A-Za-z0-9_./~:-])` so `@github:issue://1` is steered into the resource-ref parser instead of being truncated as a file ref at `@githu`.

Pipeline wiring (substituting `expandAgentRefs` for `expandFileRefs` at the builder REPL send-path + the dispatcher's skill-invocation path) lands in a follow-up once the engine's turn-input hook is touched; this slice ships the library primitives + tests.

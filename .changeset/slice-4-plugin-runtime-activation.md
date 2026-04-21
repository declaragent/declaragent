---
'@declaragent/cli': minor
---

`declaragent up` now activates consented plugins at boot. Every entry in `~/.declaragent/plugins.json` with a `consentedAt` timestamp gets loaded via the core `loadPlugin` machinery, and its contributions merge into the per-agent runtime:

- **Tools** — registered in the per-agent `ExtensionRegistry` and appended to the engine's tool array via `buildRuntimeTools({ extra })`, so the model can call them immediately.
- **Skills** — registered alongside scaffold skills; the dispatcher's skill lookup sees both kinds transparently.
- **Hooks** — subscribed to the shared `HookRegistry` that the engine now threads through `createEngine({ hookRegistry })`.
- **MCP servers** — activated via the plugin loader's stdio spawn (HTTP/SSE/streamable plugin-contributed servers still land in a follow-up; the scope-based slice-2a loader is the primary path for remote MCP).

An un-consented plugin (in the store but never approved) is skipped with a warning: the CLI banner prints `note: plugin "X" skipped — not consented — run \`declaragent plugin install\``. A broken plugin (missing module, activation error) is soft-failed so healthy siblings still activate. `stopAll` deactivates every plugin in reverse order alongside sources, MCP, and channels.

New module: `packages/cli/src/plugins-runtime.ts`. `attachDispatcherToAgent` now returns `{ detach, plugins }` so the caller can track plugin lifecycle in `RunningAgent.plugins` and close it on shutdown.

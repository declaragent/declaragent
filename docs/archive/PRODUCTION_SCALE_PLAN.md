# PRODUCTION_SCALE_PLAN.md

Implementation plan for closing the five runtime-wiring gaps between "well-designed component library" (current state, `@declaragent/cli@0.4.16`) and "production-deployable multi-agent platform end-to-end." Scope lifted directly from **AGENTS.md § Prioritized path**.

**Target release:** `@declaragent/cli@0.5.0` (minor — significant new user-visible capability).
**Target duration:** two focused weeks. Slice 2 (MCP) is the largest at ~1 week alone for full Claude-Code-parity; slices 1, 3, 4, 5 are ~1 day each. Every slice is plan-aligned with existing docs; no new design lands here.
**Shipping shape:** sub-sliced — each independently releasable on the `next` npm tag. 0.5.0 GA ships when all must-haves are green.

Status: **draft** (2026-04-21) — no implementation started. Revise freely before slice 1 begins.

---

## Why now

AGENTS.md audit showed the codebase is **component-complete but integration-sparse**. Every capability in the first-principles vision (agents with skills + MCP + plugins + channels, multi-agent deployment, monitoring) has code in `packages/core/` that's been unit-tested in isolation. None of it is loaded at runtime by `declaragent up` or `declaragent fleet run`. A user following the docs to wire a scaffolded agent to Slack gets a silent no-op.

Most of this doesn't need new architecture — slices 1, 3, 4, 5 are **~300 lines of wiring** calling existing APIs from the correct runtime hook. The exception is slice 2 (MCP), where hitting Claude-Code-parity requires new transport client implementations (HTTP, SSE, streamable), OAuth PKCE, and project-scope config. Slice 2 is the bulk of the release — see its dedicated sub-slicing below.

## Goals

- `declaragent up` in a scaffold with an MCP server, a channel, a plugin, and a Kafka source → all four wire in without any manual plumbing
- `declaragent fleet run` with peers declared over Kafka in `capabilities.yaml` → real Kafka envelopes cross between agents
- Every slice below lands with a real integration test against the corresponding backend (Redpanda via docker-compose for Kafka, an MCP test server for MCP, a mock channel for channels)

## Non-goals

- Push-button `gcloud` deploy (🔵 deferred by `PHASE_7_PLAN.md` §9, intentional)
- Default rate limiting enforcement (🔵 Phase 5)
- Circuit breakers wired into dispatcher (🔵 Phase 4)
- Prometheus `/metrics` HTTP endpoint (🔵 `PHASE_6_PLAN.md` §4.1 slice 2)
- New CLI verbs or scaffolding changes — slicing is on existing verbs only

Anything from the AGENTS.md 🔵 column stays deferred. This plan closes the 🟡 column.

## Slicing rationale

Order was chosen for:
1. **Independence first** — slices 1, 2, 3 touch disjoint files + can ship in any order
2. **Leverage** — external source discovery (slice 1) unlocks the most demanded capability (Kafka, which the fleet test was waiting on)
3. **Composability last** — plugin activation (slice 4) layers on top of 1/2/3; fleet-transport wiring (slice 5) depends on having tested per-slice integrations first

```
┌────────────────────────────────────────┐
│ Slice 1: External source discovery     │──┐
└────────────────────────────────────────┘  │
┌────────────────────────────────────────┐  │   ┌─────────────────────────┐
│ Slice 2: MCP runtime activation        │──┼──▶│ Slice 4: Plugins        │
└────────────────────────────────────────┘  │   │ (contributes to 1/2/3)  │
┌────────────────────────────────────────┐  │   └──────────────┬──────────┘
│ Slice 3: Channels + SendMessage        │──┘                  │
└────────────────────────────────────────┘                     ▼
                                               ┌─────────────────────────────┐
                                               │ Slice 5: Fleet transports + │
                                               │ RequestAgent built-in       │
                                               └─────────────────────────────┘
```

Each slice ends with a working green test. Slices 1–3 can land in parallel if parallelism is useful (different modules); they serialize here only for reviewability.

---

## Slice 1 — External source adapter discovery in `up`

**Goal:** When `up` loads a scaffold whose `event-sources.yaml` declares `type: kafka` (or `nats`/`sqs`/`amqp`/`mqtt`), the adapter is found, validated, and bound. No more `unknownTypes: [kafka]` at startup.

**Current gap:** `packages/cli/src/run-agent-sources.ts::builtinAdapters()` hardcodes three in-process adapters:
```ts
function builtinAdapters(): Record<InProcessType, EventSourceAdapter<unknown>> {
  return {
    webhook: createWebhookAdapter() as EventSourceAdapter<unknown>,
    cron: createCronAdapter() as EventSourceAdapter<unknown>,
    'file-watch': createFileWatchAdapter() as EventSourceAdapter<unknown>,
  };
}
```

External adapters registered under the `@declaragent/source-*` npm namespace are never discovered.

**Plan alignment:** `SPEC_AND_PLAN.md` §2.5 + `EVENT_SOURCE_REGISTRY.md` §3. The discovery machinery exists (`discoverAdapters()` in `packages/core/src/events/adapter-discovery.ts`). This slice only calls it from the right place.

**Implementation:**
1. `run-agent-sources.ts::builtinAdapters()` becomes `async loadAdapters(agentDir)`:
   - Always includes webhook/cron/file-watch (in-process)
   - Calls `discoverAdapters({ searchPaths: [agentDir, process.cwd(), configDir()] })`
   - Merges discovered adapters into the map (keyed by `adapter.type`)
   - Failed package loads (import error, version mismatch) → log a warning via the core logger + omit that adapter, don't crash
2. `startAgentSources()` becomes async on this path (already is)
3. Test: scaffold with a fake `@declaragent/source-fake` package under `node_modules/` of the tmp scaffold dir. Confirm `up` discovers it + binds an instance.

**Files touched:**
- `packages/cli/src/run-agent-sources.ts` (net ~40 lines)
- `packages/cli/src/run-agent-sources.test.ts` (+1 test for discovery)
- New: `packages/cli/test/fixtures/mock-source-package/` with a package.json + minimal adapter export

**Known-unknown:** adapter discovery uses `require` today, not dynamic `import`. Under Bun, both work; verify in test.

**Integration test (gated, `0.5.0-slice.1`):**
- `packages/cli/test/integration/kafka-source.test.ts` — boots Redpanda via docker-compose (existing fixture in `source-kafka/test/fixtures/`), scaffolds an agent with a Kafka source, `up -d`, produces a message, verifies `events list` shows the event with outcome `dispatched`
- Gated behind `KAFKA_INTEGRATION=1` same as `source-kafka`'s existing test

**Acceptance:** re-run the 3-agent Kafka fleet test the user asked about — agent A can consume from a Kafka topic. Producer side still pending (slice 5).

**Effort:** ~1 day. Ships as `0.5.0-slice.1`.

---

## Slice 2 — MCP server runtime activation

**Target: match the MCP story in Claude Code.** Users should be able to plug their agents into the existing MCP ecosystem (filesystem, github, postgres, atlassian, … — the same servers they'd plug into `claude mcp add`), across stdio + HTTP transports, with scope options (user / project / local) and the auth needed for hosted servers.

**This slice is genuinely ~1 focused week of work**, not 1 day as originally drafted. MCP parity is the most user-visible chunk of the 0.5.0 release and deserves its own sub-slicing. Every sub-slice independently releasable; ship them in order.

### What exists today (confirmed via file inspection)

`packages/core/src/mcp/` has:
- `jsonrpc.ts` — full JSON-RPC 2.0 framing + parser, tested
- `stdio-client.ts` — `createMCPClient` + `createStdioMCPClient` + auto-reconnect backoff, tested
- `tool-adapter.ts` — wraps an MCP `tool` as a declaragent `Tool` with namespaced `mcp__<server>__<tool>`, tested
- `server-extension.ts` — registers an MCP server into an `ExtensionRegistry`
- `types.ts` — `MCPServerConfig`, `StdioTransportConfig`, `HTTPTransportConfig` (schema present, no HTTP client impl)

Not in the codebase:
- HTTP transport client implementation (schema exists, client missing)
- SSE transport
- Streamable HTTP transport (newer MCP spec)
- OAuth PKCE flow for remote servers
- Project-scope `.mcp.json` discovery
- `@server:resource` prompt references
- Any code path in `up-cli.ts` / `fleet-run-llm-handler.ts` / `run-agent-cli.ts` that invokes the existing stdio client at runtime

**Plan alignment:** `EXTENDING_YOUR_AGENT.md` §3 covers stdio + HTTP conceptually. Claude Code's MCP docs (https://code.claude.com/docs/en/mcp) are the reference implementation target.

### Parity matrix vs Claude Code

| Capability | Claude Code | Declaragent today | Sub-slice |
| --- | --- | --- | --- |
| stdio local process servers | ✅ | ⚠ client impl exists, not wired | 2a |
| HTTP remote servers (plain) | ✅ | ⚠ schema only, no client | 2b |
| SSE transport | ✅ | ❌ | 2c |
| HTTP streamable transport | ✅ | ❌ | 2c |
| OAuth PKCE for remote servers | ✅ | ❌ | 2d |
| User scope (`~/.declaragent/mcp-servers.json`) | ✅ (`~/.claude.json`) | ✅ storage, no runtime | 2a |
| Project scope (shared `.mcp.json`, git-tracked) | ✅ | ❌ | 2a |
| Local scope (per-project, .gitignored) | ✅ | ❌ | 2a |
| `@server:resource` prompt references | ✅ | ❌ | 2e |
| Tool approval / consent gates (per-server) | ✅ | ⚠ plugin consent UI exists, not applied | 2a |
| Auto-restart on crash | ✅ | ⚠ client-level backoff exists, not surfaced | 2a |

### Sub-slices

#### 2a. Stdio MCP wiring + 3-scope config (~2 days)

**Goal:** `declaragent up` loads MCP servers from three scopes (user / project / local), spawns each stdio server via the existing `createMCPClient`, exposes their tools as `mcp__<server>__<tool>` in the per-agent tool registry, surfaces the consent gate, auto-reconnects on crash, cleans up on `down`.

**Scope precedence (match Claude Code):** local > project > user. Local overrides project, project overrides user. Duplicates resolved by name.

**Implementation:**
1. New loader in `packages/cli/src/mcp-runtime-loader.ts`:
   - Merges `~/.declaragent/mcp-servers.json` (user), `<scope-root>/.mcp.json` (project, git-tracked), `<scope-root>/.declaragent/mcp.local.json` (local, gitignored)
   - Returns a deduped array of `MCPServerConfig` with their source scope labeled
2. `up-cli.ts::bringUp` (right after `loadAgent`, before engine construction):
   - Calls the new loader
   - For each config, spawns via `createMCPClient({ transport: ..., protocolVersion: ... })`
   - Awaits `initialize()` + `listTools()` in parallel (timeout 10s per server; timeouts surface as warnings, skipped tools)
   - Wraps each returned MCP tool via `createMCPTool(client, tool)` — already exists
   - Collects into `mcpTools`, passes `buildRuntimeTools({ mcpTools, ... })` into the engine
3. `stop()` awaits each client's `shutdown()` in parallel
4. Reconnect: the stdio client already has backoff; surface reconnect attempts to the per-agent log
5. Consent: per-server consent stored in the same store as plugin consent (`~/.declaragent/consent.json`). First `up` with a new server prompts; reuse `PluginConsent` Ink UI adapted for the MCP case. Non-interactive (detached / CI) → fail closed with an actionable error.

**Files:**
- New: `packages/cli/src/mcp-runtime-loader.ts` (+ test) — ~150 lines
- `packages/cli/src/up-cli.ts` (~80 lines wiring)
- `packages/cli/src/builtin-tools.ts` extended to accept `mcpTools` (already planned in slice 3)
- CLI verb enhancements: `declaragent mcp add --scope user|project|local` (default: user)
- Scaffold template additions: init writes `.mcp.json` shell (empty `{version: 1, servers: []}`) so projects can share MCPs immediately

**Integration test (`0.5.0-slice.2a`):**
- `packages/cli/test/integration/mcp-stdio.test.ts` — boots the reference `@modelcontextprotocol/server-filesystem` (npx'd), verifies a skill can call `mcp__fs__read_file` and the contents flow into the transcript
- Gated behind `MCP_INTEGRATION=1`

**Effort:** 2 days.

#### 2b. HTTP transport client (~1.5 days)

**Goal:** Add a `createHTTPMCPClient` so remote MCP servers configured with `transport: { type: 'http', url: '...' }` can be called. Plain HTTP request/response (not SSE yet; that's 2c). Wire into the loader from 2a.

**Implementation:**
- New: `packages/core/src/mcp/http-client.ts` mirroring `stdio-client.ts` shape. Uses `fetch()` for JSON-RPC over POST. Reconnect handled as re-attempt on next call.
- `createMCPClient` factory dispatches on `config.transport.type` → stdio or http
- Headers from config passed verbatim (for static bearer-token auth without OAuth — covers the simple case)

**Integration test:** mock HTTP server in `packages/core/src/mcp/` tests responding with MCP protocol JSON. Live-server test gated behind env var.

**Effort:** 1.5 days.

#### 2c. SSE + streamable HTTP transports (~1.5 days)

**Goal:** Support the two newer MCP transports Claude Code uses for remote servers. `transport: { type: 'sse', url: '...' }` and `transport: { type: 'http-streamable', url: '...' }`.

**Implementation:**
- SSE: new `packages/core/src/mcp/sse-client.ts`. Uses `eventsource` lib (or native `EventSource`) to stream server-sent events, mapped back to JSON-RPC messages.
- Streamable: `http-streamable-client.ts` — bidirectional stream over one HTTP connection per the MCP spec.
- Schema update: `MCPServerConfig` transport union expands.
- Loader 2a already accepts arbitrary transport configs; no changes there.

**Effort:** 1.5 days. (SSE alone is ~1 day; streamable spec still evolving so reserve extra.)

#### 2d. OAuth PKCE for remote MCP servers (~2 days)

**Goal:** Remote MCP servers that require OAuth (e.g. a hosted github.com MCP) work without the user hand-crafting a token. Flow matches what Claude Code does — PKCE against the server's advertised authorization endpoint, token stored per-server in `~/.declaragent/mcp-tokens.json` (mode 0600), auto-refreshed on 401.

**Implementation:**
- New: `packages/cli/src/mcp-oauth.ts` — PKCE flow, local callback server on a free port, token storage. Reuses patterns from existing `auth-openrouter.ts` OAuth PKCE impl.
- `declaragent mcp login <server-name>` verb to trigger the flow explicitly.
- Auto-trigger on first 401 during a `listTools()` or `callTool()`.

**Effort:** 2 days. (OAuth is always more than it looks — real flow + refresh + storage + UX.)

#### 2e. `@server:resource` references in skills (~1 day)

**Goal:** Skills can reference MCP resources inline via `@<server>:<resource-uri>` in the prompt — Claude Code's pattern. At send-time, the runtime fetches the resource and inlines the content (similar to the `@<path>` file-ref expansion we shipped in 0.4.1).

**Implementation:**
- Extend the existing `file-refs.ts` module (or parallel it) to recognize `@server:uri` tokens
- At `runUserMessage` / skill-invocation time, for each matched ref:
  - Look up the server's MCP client from the per-agent tool registry
  - Call `resources/read` via JSON-RPC (new method to support in the client)
  - Inline as a fenced block at end of the user message, same shape as file refs
- Fallback for unknown servers or missing resources — same warn-and-continue pattern as file refs

**Effort:** 1 day.

### Aggregate timing + release shape for slice 2

- **2a** (~2 days) — stdio + 3-scope config + consent + auto-restart wiring. Ships `0.5.0-slice.2a`. **This is the minimum to match "users can plug agents into MCP servers like Claude Code."** Covers ~80% of real usage since most MCP servers are stdio.
- **2b** (~1.5 days) — HTTP transport. Ships `0.5.0-slice.2b`. Needed for hosted MCP servers without SSE.
- **2c** (~1.5 days) — SSE + streamable HTTP. Ships `0.5.0-slice.2c`. Needed for most 2026-era remote servers (Claude's own MCP hosts use these).
- **2d** (~2 days) — OAuth. Ships `0.5.0-slice.2d`.
- **2e** (~1 day) — resource references. Ships `0.5.0-slice.2e`.

Total: **~8 days** for full Claude-Code-parity MCP. Conservative; 6 days for an experienced hand.

### What actually ships in 0.5.0 GA

- **Must-have**: 2a (stdio + scopes + consent + restart) — this is the user-perceivable baseline
- **Strongly-want**: 2b (HTTP plain) — simple hosted servers work
- **Nice-to-have**: 2c (SSE/streamable), 2d (OAuth), 2e (resources) — can roll into 0.5.x minor updates after GA

If the 1-week total budget for the whole production-scale plan is firm, ship only **2a + 2b** in 0.5.0 and schedule 2c/2d/2e for 0.5.x.  If the budget flexes, land everything.

---

## Slice 3 — Channels + `SendMessage` built-in

**Goal:** `BUILTIN_TOOLS` gains a `SendMessage` tool. `declaragent up` reads `~/.declaragent/channels.json`, instantiates the configured channel adapters, builds a `ChannelOutboundBridge`, and passes that bridge to `SendMessage`. A skill can call `SendMessage({ channel: 'support-slack', text: '...' })` and the message actually ships.

**Current gap:** `createSendMessageTool` is exported from `packages/core/src/index.ts` line 139 but is never imported in the CLI package. `createChannelOutboundBridge` is exported but similarly unused. Channels sit inert in `channels.json`.

**Plan alignment:** `COMMUNICATION_CHANNELS.md` §4 — the outbound path (`send()`, bridge, tenant scoping) is fully specified and implemented. This slice wires it into `up`.

**Implementation:**
1. Extend `BUILTIN_TOOLS` composition to be a function of runtime context:
   - `packages/cli/src/builtin-tools.ts` → `buildRuntimeTools({ channelBridge?: ChannelOutboundBridge })`
   - When no bridge → returns the 7 current built-ins (same as today)
   - When bridge present → appends `createSendMessageTool({ bridge })`
   - Every callsite updated: `up-cli.ts`, `run-agent-cli.ts`, `fleet-run-llm-handler.ts`
2. `up-cli.ts::bringUp`:
   - `loadChannelsConfig()` from `~/.declaragent/channels.json` (gracefully missing → no bridge)
   - For each configured channel, find the adapter via `discoverChannelAdapters()` (already exists in core)
   - Instantiate → wrap in a `ChannelOutboundBridge` scoped to the per-agent tenant
   - Pass to `buildRuntimeTools`
3. Bridge close on `stop()` — existing pattern from other cleanup paths

**Files touched:**
- `packages/cli/src/builtin-tools.ts` (~20 lines, small refactor from constant to function)
- `packages/cli/src/up-cli.ts` (~60 lines)
- All `buildRuntimeTools` callsites (3 files, one-line changes)
- Existing tests need `buildRuntimeTools()` instead of `BUILTIN_TOOLS`
- New test: `packages/cli/src/channel-runtime.test.ts` with a mock channel adapter

**Integration test (`0.5.0-slice.3`):**
- `packages/cli/test/integration/slack-channel.test.ts` — uses the Slack-adapter's existing mock server harness. Scaffold agent + Slack channel config, run a skill that calls `SendMessage`, assert the mock received a `chat.postMessage` call

**Acceptance:** the `concierge` template (which mentions Slack in its system prompt) actually delivers to Slack out of the box after the user runs `declaragent channels add slack ...`.

**Effort:** ~1 day. Ships as `0.5.0-slice.3`.

---

## Slice 4 — Plugin runtime activation

**Goal:** When `declaragent up` starts and `~/.declaragent/plugins.json` lists consented plugins, each is activated: its contributed tools, skills, commands, hooks, and MCP servers all merge into the per-agent runtime. After slice 4, installing a plugin and running `up` is indistinguishable from hand-scaffolding everything the plugin contributes.

**Current gap:** `loadPluginManifest` / `createPluginStore` are called only from the builder's `add-plugin.ts` + the `plugin install` CLI verb. Never from `up` / `fleet run`. Plugin contributions are inert at runtime.

**Plan alignment:** `EXTENDING_YOUR_AGENT.md` §6 documents the `PluginLoader` with scoped registries and hot-reload deferrals. Matches the existing extension-registry primitive.

**Implementation depends on slices 1–3.** A plugin can contribute:
- A source adapter (layers on slice 1's discovery) — plugin registers `@declaragent/source-fake` dynamically
- An MCP server (reuses slice 2's spawn path)
- A channel adapter (reuses slice 3's bridge)
- A tool (adds to the runtime tool array via `buildRuntimeTools`)
- A skill (registered into the per-agent extension registry alongside scaffold skills)
- A hook (attached to the dispatcher's hook registry)

**Implementation:**
1. `up-cli.ts::bringUp`, before sources/MCP/channels:
   - Load `~/.declaragent/plugins.json` entries
   - For each plugin with `consentedPermissions` present:
     - `loadPluginManifest(entry.dir)`
     - Apply permission check against the per-agent `PermissionGate` (reject if any declared permission isn't granted)
     - Activate via a new `activatePlugin({ manifest, dir, registry, permissionGate })` helper in `packages/core/src/plugins/activator.ts` (new file; see below)
2. `activatePlugin` in core:
   - Imports `manifest.contributes.tools` paths (dynamic `import`), each exporting a `Tool[]` → appended to runtime tool array
   - Registers `manifest.contributes.skills` paths into the extension registry
   - Registers `manifest.contributes.mcpServers` alongside user-global MCP servers from slice 2
   - Subscribes `manifest.contributes.hooks` paths to the dispatcher's hook registry
   - Returns a `deactivate()` closure called on `stop()`
3. Plugin-contributed sources handled by passing the plugin's advertised adapter list into slice 1's `loadAdapters()` call

**Files touched:**
- `packages/cli/src/up-cli.ts` (~80 lines)
- New: `packages/core/src/plugins/activator.ts` + test (~150 lines)
- `packages/core/src/index.ts` export
- Integration test with the existing fixture plugin under `packages/core/src/plugins/fixtures/`

**Integration test (`0.5.0-slice.4`):**
- `packages/cli/test/integration/plugin-runtime.test.ts` — installs the fixture plugin, runs `up`, triggers the skill that the plugin contributes, asserts it ran
- Tests both happy path and the "declined permission" path

**Acceptance:** install `@declaragent/plugin-github` (when it ships), `up` against a scaffolded pr-review agent, receive a real GitHub webhook, skill calls plugin-contributed tools. End-to-end.

**Effort:** ~1 day. Ships as `0.5.0-slice.4`.

---

## Slice 5 — Non-memory transports in `fleet run` + `RequestAgent` built-in

**Goal:** `declaragent fleet run` reads each agent's `capabilities.yaml` transport declaration. When `kind: kafka` (or nats/sqs/amqp/mqtt), it instantiates the matching transport from `plugin-agent-rpc` instead of ignoring it. `BUILTIN_TOOLS` gains `createRequestAgentTool(...)` so skills can call other agents' capabilities without manual plumbing.

**Current gap:**
1. `packages/cli/src/fleet-run.ts` line ~235: `createMemoryTransport({ bus })` hardcoded for every transport kind
2. The comment in-file: *"Non-memory transports (kafka, nats, etc.) are ignored in slice 3 — the dev loop is memory-only."*
3. `BUILTIN_TOOLS` has no `RequestAgent` — skills must have the tool contributed via plugin (slice 4) OR callers must manually inject

**Plan alignment:** `AGENT_RPC_PLAN.md` §1 places the producer tool in `@declaragent/plugin-agent-rpc`; registering it in `BUILTIN_TOOLS` crosses the plan's Phase 8 line. **Open design question resolved here:** does `RequestAgent` stay plugin-exclusive (aligns with plan), or become a first-class built-in (better UX)? Recommendation: first-class built-in in slice 5, since the plugin package is first-party and the dedicated plugin approach buys nothing for agents that need to communicate. If later a user-contributed version needs to override the default, the tool composition from slice 3 handles it.

**Implementation:**
1. `fleet-run.ts::startAgentWorker`:
   - Replace `createMemoryTransport({ bus })` with a factory that inspects `t.kind`:
     - `memory` → `createMemoryTransport({ bus })` (existing)
     - `kafka` → dynamic import `@declaragent/plugin-agent-rpc-kafka` (or wherever the transport lives; verify path) + instantiate
     - `nats`, `sqs`, etc. — same pattern
   - Each transport instance lives until shutdown; detach/close on `shutdown()`
2. `buildRuntimeTools` (from slice 3) accepts an optional `rpcTools` argument:
   - Built via a new `buildRpcTools({ selfAgent, peers, transports, pending })` helper in `packages/cli/src/rpc-runtime.ts`
   - Callsites in `up-cli.ts` / `fleet-run-llm-handler.ts` construct peers + transport map from `capabilities.yaml` + `rpc-peers.yaml`
3. `rpc-peers.yaml` becomes a real runtime file — builder's `DeclaraAddPeer` already writes it; this slice adds the reader

**Files touched:**
- `packages/cli/src/fleet-run.ts` (~80 lines)
- `packages/cli/src/up-cli.ts` (~30 lines for peers loader)
- New: `packages/cli/src/rpc-runtime.ts` (~60 lines)
- `packages/cli/src/builtin-tools.ts` (add `rpcTools` branch)
- Fleet-run tests + integration tests

**Integration test (`0.5.0-slice.5`):**
- `packages/cli/test/integration/kafka-rpc-fleet.test.ts` — boots Redpanda, scaffolds 3 agents with Kafka transport peering, `up` each, triggers agent A's skill → agent A calls RequestAgent → agent B's skill runs → returns up the chain. Same shape as the 3-agent Kafka test the user asked for.
- Gated behind `KAFKA_INTEGRATION=1`

**Acceptance:** the user's original "3 agents talking via Kafka" test passes without any manual plumbing — scaffold each agent with `capabilities.yaml` + `rpc-peers.yaml`, `up` all three in separate terminals, trigger A, see the chain propagate. Also: the in-memory fleet test still passes (memory transport untouched).

**Effort:** ~1 day. Ships as `0.5.0` (the final slice ships the GA tag).

---

## Test strategy across slices

Every slice lands a **focused unit test + a real-backend integration test** (gated env var). The integration tests together form a "production smoke" suite:

| Slice | Unit | Integration | Backend needed |
| --- | --- | --- | --- |
| 1 | mock adapter loader | Kafka source bind + event fire | Redpanda (docker-compose) |
| 2a | 3-scope loader + consent stubs | reference `@modelcontextprotocol/server-filesystem` via stdio | npm + ref server |
| 2b | mock HTTP MCP server | live hosted MCP endpoint (optional) | local HTTP mock |
| 2c | mock SSE + streamable handlers | live Claude-hosted MCP endpoint (optional) | local mocks |
| 2d | mock OAuth provider | live OAuth against hosted MCP | local PKCE mock |
| 2e | `@server:resource` token tests | resource-read against fixture server | fixture |
| 3 | mock channel adapter | Slack mock HTTP server | local HTTP mock |
| 4 | fixture plugin | real fixture plugin activation | none (repo fixture) |
| 5 | transport factory unit | 3-agent Kafka RPC chain | Redpanda |

A new CI workflow `prod-smoke.yml` runs the integration suite nightly (or on `prod-smoke` label PRs). Red is investigated; green means the happy path for production-backend scenarios is intact. The existing `ci.yml` stays lean on mocks — slow backends stay gated.

## Release shape

- Each slice (and sub-slice) ships on the `next` npm tag with a pre-release version: `0.5.0-slice.1`, `0.5.0-slice.2a`, `0.5.0-slice.2b`, …
- **0.5.0 GA (latest tag) ships when the "must-have" set is complete:** slice 1, slice 2a + 2b, slice 3, slice 4, slice 5. 2c/2d/2e roll into 0.5.1+ unless the calendar allows.
- CHANGELOG documents each slice's user-visible delta
- Migration: none. Existing 0.4.x users upgrade cleanly — all additions, no behavior changes to existing paths

## Risks + known unknowns

1. **Adapter discovery perf** (slice 1) — scanning `node_modules/@declaragent/source-*` at every `up` startup could slow cold-start. Mitigation: cache the discovery result across invocations in `~/.declaragent/adapter-cache.json`, invalidate on `npm install` via mtime check.

2. **MCP spawn ordering** (slice 2) — MCP servers can take seconds to come up + list tools. If `up` blocks on each sequentially, a 5-MCP-server agent takes 10+ seconds to start. Mitigation: spawn in parallel via `Promise.all`; on bind, await only the ones the current skill actually needs (future optimization).

3. **Channel tenant scoping** (slice 3) — the `ChannelOutboundBridge` expects a `TenantContext`. Single-tenant default works; multi-tenant needs care. Test with both.

4. **Plugin activation order** (slice 4) — plugin-contributed MCP servers should activate before plugin-contributed skills (skills may reference MCP tools). Implement as a topological pass over contribution types: sources → MCP → channels → tools → skills → hooks.

5. **Kafka transport path** (slice 5) — `plugin-agent-rpc` today has kafka transport code but I haven't verified it's export-ready. May need a follow-up to expose a `createKafkaTransport` factory. Resolve at start of slice 5, before committing to the slice's 1-day estimate.

6. **`RequestAgent` as built-in crosses plan line** — `AGENT_RPC_PLAN.md` positions it as plugin-exclusive. Worth a short doc update to the plan OR revert this subslice to a plugin-only wiring if review disagrees. Decision: keep as built-in (first-party plugin, DX benefit) but flag in the release notes + amend `AGENT_RPC_PLAN.md` §1 to reflect the choice.

## Out of scope (tracked separately)

These are real gaps AGENTS.md identifies but aren't part of "first-principles vision":
- `declaragent fleet deploy` multi-agent rollout orchestration (`fleet-deploy-cli.ts` exists but thin; follow-up plan)
- Event-dispatch DLQ for non-Kafka sources
- Prometheus `/metrics` HTTP endpoint (🔵 Phase 6 slice 2 — tracked)
- Real `gcloud` push-button deploy (🔵 intentional non-goal)
- Push-hosted signed artifacts in the tarball supply chain

## Acceptance for `0.5.0` GA

All four conditions true:
1. Every item on AGENTS.md's "What doesn't work at CLI 0.4.16" list is ✅ except those marked 🔵
2. The nightly prod-smoke suite has been green for 7 consecutive days
3. The user's 3-agent Kafka fleet test (from the 0.4.16 session) runs clean end-to-end, producing `dispatched→<sessionId>` outcomes on every hop
4. AGENTS.md is re-run against the 0.5.0 tree + every previously-🟡 row flips to ✅

When those four are true, tag `v0.5.0`, update the npm `latest` tag, refresh docs-site `/intro.mdx` "What's new" section.

---

## Methodology

This plan was written by mapping AGENTS.md's five 🟡 gaps to their runtime entry points in `packages/cli/src`. Every "implementation" section names specific files + estimated line counts. No new design — all five slices are wiring existing core APIs into the hot path.

If estimates are wrong, update them + re-sort. The one-week total is optimistic; double for safety in a shared calendar.

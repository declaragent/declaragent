# Phase 2 — Extensibility: Implementation Plan

**Status:** Draft for review. Scoped to Phase 2 of `SPEC_AND_PLAN.md` (Extensibility, target v0.3 private beta).
**Last updated:** 2026-04-16.

The Phase 1 core is a closed system: a fixed engine, a fixed set of seven tools, and a CLI that calls one of two providers. Phase 2 opens it up. Third parties (and the user themselves) get to add tools, skills, MCP servers, hooks, and CLI commands — without touching `@declaragent/core`. The **acceptance bar** from `SPEC_AND_PLAN.md §8`: an external developer installs `@declaragent/plugin-github`, adds the GitHub MCP server, and writes a `pr-review.md` skill, using only the README.

This doc lays out the architecture, contracts, slice ordering, and known sharp edges so we ship without painting ourselves into a corner.

---

## 1. Goals and non-goals

**Goals.**
- One unified extension spine (`ExtensionRegistry`) that everything plugs into — tools, skills, MCP, hooks, CLI commands. Lifecycle is shared.
- MCP client that speaks the Model Context Protocol against any compliant server (stdio at minimum; HTTP a stretch goal).
- Skills as portable markdown + frontmatter files; precedence-resolved across user/team/plugin/built-in.
- Plugins as composable distribution units that bundle the above + a manifest.
- Permission/consent model that scales: every new tool source still flows through the existing gate; new things plugins can do require user approval at install time.

**Non-goals (Phase 2).**
- Event-driven runtime (`EventBus`, `EventSourceAdapter`) — that's Phase 3.
- Cloud deployment, daemon mode, control plane — Phase 3+.
- Prompt-engineering on the skill format (e.g. evaluation harness) — out of scope.
- Sandboxing JavaScript plugin code — plugins run in-process. Permission gate + install-time consent are the only safeguards. Document the trust model clearly.
- MCP protocol version migration tooling (`my-agent migrate`) — defer to Phase 7.

---

## 2. Conceptual architecture

```
                       ┌──────────────────────┐
                       │  ExtensionRegistry   │
                       │  (the spine)         │
                       └──────────┬───────────┘
                                  │
       ┌──────────────┬───────────┼────────────┬────────────────┐
       ▼              ▼           ▼            ▼                ▼
┌────────────┐  ┌──────────┐  ┌────────┐  ┌─────────┐     ┌────────────┐
│ Built-in   │  │   MCP    │  │ Skills │  │  Hooks  │     │  Plugin    │
│ Tools      │  │  Client  │  │ Loader │  │Registry │     │  Loader    │
│ (Phase 1)  │  │          │  │        │  │         │     │            │
└────────────┘  └────┬─────┘  └────┬───┘  └────┬────┘     └─────┬──────┘
                     │             │           │                │
                     ▼             ▼           ▼                ▼
                MCP Tool       Skill         Hook         Plugin Manifest
                Wrappers       Files       Subscribers    (declares all
                                                           of the above)
```

**Single registry.** Every extension type funnels through one `ExtensionRegistry`. It tracks `ExtensionDescriptor`s (id, kind, source, manifest) so:
- conflict detection is centralized (`mcp__github__pr` declared by two MCP servers → loud error)
- `activate`/`deactivate` is uniform (used by hot reload)
- `/extensions` slash command can list everything in one place
- audit trail: who registered what

**Composition flow at startup:**
1. Built-in tools register themselves
2. User config (`agent.yaml` later, CLI flags now) lists installed plugins
3. For each plugin: load manifest → register its declared tools/skills/MCP servers/hooks/commands
4. MCP servers are spawned, handshake, their tools wrap into our `Tool` contract and register
5. Skills loader walks user/team/plugin/built-in dirs, registers
6. Engine starts with the union of all registered tools

**Permission gate is unchanged.** Every tool — built-in, MCP-wrapped, plugin-contributed — flows through `PermissionGate.check()`. This is the load-bearing safety guarantee from Phase 1; Phase 2 must not weaken it.

---

## 3. Core contracts

These live in `@declaragent/core/src/types/extension.ts` and are added in slice 1.

```ts
export type ExtensionKind = 'tool' | 'skill' | 'mcp-server' | 'hook' | 'command';

export interface ExtensionDescriptor {
  id: string;                      // globally unique, e.g. "mcp:github" or "skill:user:pr-review"
  kind: ExtensionKind;
  source: ExtensionSource;
  declaredPermissions?: string[];  // glob patterns; surfaced at consent time
}

export type ExtensionSource =
  | { type: 'built-in' }
  | { type: 'user' }
  | { type: 'plugin'; pluginId: string; pluginVersion: string }
  | { type: 'team'; path: string };

export interface ExtensionContext {
  registry: ExtensionRegistry;
  logger: Logger;
  permissions: PermissionGate;     // for read-only inspection; mutation only via consent
  configDir: string;               // ~/.declaragent
}

export interface Extension {
  descriptor: ExtensionDescriptor;
  activate(ctx: ExtensionContext): Promise<void>;
  deactivate?(): Promise<void>;
}

export interface ExtensionRegistry {
  register(ext: Extension): void;
  unregister(id: string): Promise<void>;
  list(): ExtensionDescriptor[];
  byKind<K extends ExtensionKind>(kind: K): Extension[];
  get(id: string): Extension | undefined;
  /** Reload an extension in place — used by hot reload. */
  reload(id: string): Promise<void>;
}
```

**MCP-specific contracts** (added in slice 2, live in `@declaragent/core/src/mcp/`):

```ts
export interface MCPServerConfig {
  name: string;                    // user-chosen short id; namespaces tools as mcp__<name>__<tool>
  transport: { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
           | { type: 'http'; url: string; headers?: Record<string, string> };
  protocolVersion: string;         // pinned, e.g. "2024-11-05"
}

export interface MCPClient {
  initialize(): Promise<MCPServerInfo>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, input: unknown, signal: AbortSignal): Promise<MCPToolResult>;
  listResources?(): Promise<MCPResource[]>;
  listPrompts?(): Promise<MCPPrompt[]>;
  shutdown(): Promise<void>;
  readonly status: 'starting' | 'ready' | 'reconnecting' | 'failed' | 'stopped';
}
```

**Skill format** (slice 4):

```ts
export interface SkillFrontmatter {
  name: string;
  description: string;
  triggers?: string[];             // optional regex/glob — used for auto-suggest later
  inputs?: Record<string, JSONSchema>;
  outputs?: JSONSchema;
  model?: string;                  // override session model just for this skill
}

export interface Skill {
  descriptor: ExtensionDescriptor;
  frontmatter: SkillFrontmatter;
  prompt: string;                  // markdown body
  filePath: string;                // for diagnostics
}
```

**Plugin manifest** (slice 6, lives in `plugin.json` at the plugin root):

```json
{
  "name": "@declaragent/plugin-github",
  "version": "1.0.0",
  "description": "GitHub MCP + skills for PR review and triage",
  "permissions": [
    "Bash:gh *",
    "Read:**",
    "mcp:github"
  ],
  "contributes": {
    "tools": ["./dist/tools/index.js"],
    "skills": ["./skills/"],
    "mcpServers": [
      {
        "name": "github",
        "transport": { "type": "stdio", "command": "npx", "args": ["@modelcontextprotocol/server-github"] },
        "protocolVersion": "2024-11-05"
      }
    ],
    "hooks": ["./dist/hooks/index.js"],
    "commands": ["./dist/commands/index.js"]
  }
}
```

---

## 4. MCP protocol details

This is the only piece of Phase 2 with a sharp wire-format spec to follow. Worth being explicit so slice 2 doesn't over-design.

**Spec target:** [Model Context Protocol 2024-11-05](https://spec.modelcontextprotocol.io/specification/2024-11-05/) (or the current latest at implementation time). We pin one version per release; `MCPServerConfig.protocolVersion` is checked against server-reported version during handshake.

**Stdio transport:**
- We spawn the server as a child process.
- Both sides exchange JSON-RPC 2.0 messages, **one per line** (newline-delimited JSON, not LSP framing).
- We write requests to the child's stdin, read responses from stdout. Stderr is forwarded to our debug logger.

**Lifecycle:**
1. Spawn → `initialize` request with our client info + protocol version
2. Server responds with `initialize` result (capabilities, server info)
3. We send `initialized` notification
4. Steady state: `tools/list`, `resources/list`, `prompts/list` called once and cached
5. `tools/call` invoked per tool use
6. On shutdown: send `shutdown` notification, wait for stdout close, kill if it exceeds grace period

**Auto-restart:**
- Track `consecutiveFailures` per server
- Exponential backoff: 500ms × 2^N up to 30s cap (mirrors `withRetry`)
- After 5 consecutive failures, mark server `failed` and surface to user via `/mcp status`
- Tools registered by a failed server return synthetic ENOENT-style errors until reconnect

**Notifications:** Servers can push notifications (`notifications/tools/list_changed` etc.). We re-list and refresh registrations.

---

## 5. Skills format

Skills are markdown files with YAML frontmatter:

```markdown
---
name: pr-review
description: Review a GitHub pull request and suggest changes
triggers:
  - "review pr"
  - "check this pull request"
inputs:
  prUrl:
    type: string
    description: GitHub PR URL
outputs:
  type: object
  properties:
    summary: { type: string }
    suggestions: { type: array, items: { type: string } }
model: claude-opus-4-6
---

You are reviewing PR {{prUrl}}.
Use the github MCP tools to fetch the diff and discuss changes.
Report a structured summary in JSON.
```

**Three-tier search paths** (precedence: highest first):
1. **User-local:** `~/.declaragent/skills/`
2. **Team:** `./.declaragent/skills/` (in cwd, for repo-shared skills)
3. **Plugin:** `<plugin>/skills/` (declared in manifest)
4. **Built-in:** `@declaragent/core/skills/` (none ship in Phase 2)

**Namespacing.** Skills from plugins are addressed as `plugin-name:skill-name`. User/team skills are unqualified. The loader emits a warning on any unqualified collision and resolves to the highest-precedence one.

**Invocation.** `/skill <name> [args...]` slash command. The skill's prompt body becomes the user message; the engine runs it as a sub-agent. `model` from frontmatter overrides the session model for that turn.

**Templating.** Mustache-style `{{var}}` interpolation against `inputs`. We use a minimal in-house impl (no Handlebars dep).

---

## 6. Hooks integration

Phase 1 stubbed `LoopHooks`. Phase 2 wires the hook *registry* — a Plugin can `ctx.registry.byKind('hook')` and add subscribers.

**Hook points** (live in slice 5):

| Point | When | Override semantics |
|---|---|---|
| `tool.before` | After permission, before execute | Can return `ToolCallOverride` to short-circuit (e.g. compliance intercept) |
| `tool.after` | After execute, before result append | Cannot override; observation only |
| `skill.before` / `skill.after` | Around skill invocation | `skill.before` can rewrite inputs |
| `event.before` / `event.after` | Phase 3 (no-op subscribers allowed in Phase 2) | — |
| `compact.before` | Before context compaction | Can rewrite the transcript snapshot the strategy sees |

**Composition.** Multiple subscribers per point, run in registration order. First non-undefined return value from a `before`-style hook wins (short-circuit). `after`-style hooks all run unconditionally (logging, metrics).

---

## 7. Plugin manifest + loader

**Discovery sources** (in order):
1. `~/.declaragent/plugins/<plugin-name>/plugin.json`
2. npm-installed under `@declaragent/plugin-*` scope (Phase 2.x — needs npm resolution)
3. Local: `./plugins/*/plugin.json` (relative to cwd)

**Install flow** (`declaragent plugin install <source>`):
1. Resolve source → npm tarball, GitHub repo, or local dir
2. Copy/extract to `~/.declaragent/plugins/<name>/`
3. Read manifest, show consent UI listing all `permissions` and `contributes`
4. On approval: write to `~/.declaragent/plugins.json` registry; mark active
5. Subsequent REPL launches load the plugin automatically

**Activation:**
- Run plugin's contributed JS modules (tools, hooks, commands) in our process
- Spawn declared MCP servers
- Register declared skills
- All registrations go through the same `ExtensionRegistry` as built-ins

**Trust model.** Plugins run in our Node/Bun process — no sandbox. The protections are:
- Install-time consent on `permissions` declared in manifest
- Permission gate enforces `permissions` at tool-call time (rules propagate from manifest into the gate)
- All file paths the plugin tries to read/write still go through `Read`/`Write` permission keys
- We document this clearly: "installing a plugin is trust equivalent to running its code directly"

---

## 8. CLI admin commands

| Command | Action |
|---|---|
| `declaragent plugin install <source>` | Resolve, copy, consent, register |
| `declaragent plugin list` | All installed plugins with id/version/status |
| `declaragent plugin remove <id>` | Deactivate, prompt confirm, remove from disk |
| `declaragent plugin info <id>` | Manifest + declared contributions |
| `declaragent skill list` | All skills across all sources, with precedence shown |
| `declaragent mcp add <name>` | Interactive: pick stdio/http, command, args |
| `declaragent mcp remove <name>` | Drop from config |
| `declaragent mcp list` | Configured + status (running/failed/etc.) |
| `declaragent extensions` | Everything in the registry, grouped by kind |

In-REPL slash equivalents: `/plugin list`, `/skill list`, `/mcp list`, `/extensions`.

---

## 9. Slice breakdown

Same approach as Phase 1: thin vertical slices, each independently mergeable.

### Slice 1 — `ExtensionRegistry` skeleton (~2 days)
- Types: `Extension`, `ExtensionDescriptor`, `ExtensionContext`, `ExtensionRegistry`
- In-memory impl with conflict detection on duplicate ids
- `register`/`unregister`/`reload` lifecycle
- Wire built-in Phase 1 tools through it (they get `source: { type: 'built-in' }` descriptors)
- Tests: registration, lookup by kind, conflict, lifecycle, reload preserves order

### Slice 2 — MCP client (stdio) (~5 days)
- JSON-RPC 2.0 framing (newline-delimited)
- `MCPClient` impl backed by `Bun.spawn`
- Handshake: `initialize` → `initialized`
- `tools/list`, `tools/call` (the core methods)
- Auto-restart with backoff
- Tests: in-process fake JSON-RPC server; canned message exchanges; restart on simulated crash

### Slice 3 — MCP tool wrapping (~2 days)
- Adapter: MCP tool definition → our `Tool` contract
- Naming: `mcp__<server>__<tool>`
- Permission key strategy: stable hash of input first non-system property, OR full `JSON.stringify(input)` (TBD — open question)
- Schema: pass through
- Engine consumes them with no changes
- Tests: end-to-end through engine + FakeProvider + fake MCP server

### Slice 4 — Skills loader (~3 days)
- Frontmatter parser (gray-matter dep, or minimal in-house — TBD)
- Three-tier search + precedence
- Namespacing for plugin skills
- Mustache `{{var}}` templating
- `/skill <name>` slash command — runs as a sub-agent
- Tests: load + lookup + namespace conflict + templating

### Slice 5 — Hooks registry (~2 days)
- Move Phase 1's no-op `LoopHooks` to a real registry
- Subscriber composition order
- `before`-style override / short-circuit semantics
- New hook points: `skill.before`/`skill.after`, `compact.before`
- Tests: subscriber order, short-circuit, async subscribers

### Slice 6 — Plugin manifest + loader (~4 days)
- Manifest schema (Zod or JSON Schema — TBD)
- Local-path loader (npm comes later)
- Activate: register all contributed extensions through the registry
- `~/.declaragent/plugins.json` registry of installed plugins
- Tests: load a sample fixture plugin; verify all extensions registered with right descriptors

### Slice 7 — CLI admin commands (~3 days)
- `plugin install/list/remove/info`
- `skill list`
- `mcp add/remove/list`
- `extensions`
- Each command is an Ink subcommand following the auth-flow pattern
- Tests: CLI integration against a fixture plugin dir

### Slice 8 — Plugin consent flow (~3 days)
- On install: render consent UI listing manifest's `permissions` and `contributes`
- Approval persisted in `~/.declaragent/plugins.json` per plugin
- Permission gate auto-allows the consented patterns at runtime (so the user isn't re-prompted)
- Revocation via `plugin remove` clears the consent
- Tests: consent flow, persistence, revocation

### (Optional) Slice 9 — MCP HTTP transport (~3 days)
- Same protocol over `fetch` + SSE for notifications
- Defer if we hit time pressure; stdio covers the v0.3 acceptance demo

**Critical path:** 1 → 2 → 3 → 6 (Plugin loader needs MCP wrapping). Slices 4 (Skills) and 5 (Hooks) can run in parallel with 2/3. Slices 7/8 sequence after 6.

**Total estimate:** ~24 days of focused work without slice 9, ~27 with. Matches the spec's 4–6 week guidance.

---

## 10. File layout

```
packages/core/src/
├── extension/                    # NEW (slice 1)
│   ├── types.ts
│   ├── registry.ts
│   ├── registry.test.ts
│   └── index.ts
├── mcp/                          # NEW (slices 2, 3)
│   ├── types.ts
│   ├── jsonrpc.ts
│   ├── jsonrpc.test.ts
│   ├── stdio-client.ts
│   ├── stdio-client.test.ts
│   ├── tool-adapter.ts
│   ├── tool-adapter.test.ts
│   ├── http-client.ts            # slice 9
│   └── index.ts
├── skills/                       # NEW (slice 4)
│   ├── types.ts
│   ├── frontmatter.ts
│   ├── loader.ts
│   ├── loader.test.ts
│   ├── template.ts
│   └── index.ts
├── hooks/                        # NEW (slice 5)
│   ├── registry.ts
│   ├── registry.test.ts
│   └── index.ts
└── plugins/                      # NEW (slice 6)
    ├── manifest.ts
    ├── loader.ts
    ├── loader.test.ts
    └── index.ts

packages/cli/src/
├── plugin-install.tsx            # slice 7
├── plugin-list.ts
├── plugin-remove.tsx
├── mcp-add.tsx                   # slice 7
├── consent-flow.tsx              # slice 8
└── slash-commands.ts             # extended for /plugin /skill /mcp /extensions
```

---

## 11. Engine and existing-code touch points

Phase 2 should be **mostly additive**. Specifically:

- `engine.ts`: change `tools: Tool[]` → `tools: Tool[] | ExtensionRegistry`. If a registry is passed, `byKind('tool')` is the source. Internal logic unchanged.
- `LoopHooks`: replaced by reading subscribers from `ExtensionRegistry.byKind('hook')`. Existing `hooks?: LoopHooks` config kept as a back-compat shim that auto-registers a single `hook` extension.
- `Tool` contract: unchanged. MCP-wrapped tools and plugin tools satisfy the same interface.
- `PermissionGate`: unchanged. New plugins contribute new rules but the gate's logic is fixed.
- CLI: new subcommands; existing ones (`auth`, REPL) untouched.

This is intentional — the cost of any Phase 1 contract change is high, so Phase 2 designs *into* what already works.

---

## 12. Testing strategy

Three tiers, mirroring Phase 1:

1. **Pure unit tests** for each piece of the registry, MCP framing, skill parsing, manifest validation, hook composition.
2. **Integration tests** with fixtures:
   - Fake MCP server (in-process JSON-RPC) for slice 2/3
   - Fixture plugin in `packages/cli/src/__fixtures__/plugin-sample/` for slice 6/7/8
   - Skill fixtures under `packages/core/src/__fixtures__/skills/`
3. **End-to-end smoke** (gated by env, run nightly): real `@modelcontextprotocol/server-everything` + a real Anthropic call exercising one MCP tool through the engine.

---

## 13. Open questions

1. **MCP tool permission keying.** MCP tools accept arbitrary JSON inputs. What's the permission key? Options:
   - (a) Just the tool name: `mcp__github__create_pr` — coarse, but predictable rules
   - (b) Stable JSON hash of input — fine-grained, but rules are unwriteable by humans
   - (c) Per-server convention: ask servers to declare a `permissionKeyPath` (which input field to gate on) — requires extending the MCP spec, ugly
   - **My lean:** (a) for v0.3, with optional (c) when the protocol supports it.

2. **Skill prompt injection / templating safety.** A user-installed skill is trusted (you wrote it). A plugin-installed skill is not (some npm package's prompt). Should plugin skills run in a more constrained mode (e.g., can't call `Bash`)?
   - **My lean:** plugin skills inherit the plugin's manifest permissions; if a plugin needs `Bash`, it declares it and the user consents.

3. **Frontmatter parser dep.** Use `gray-matter` (battle-tested, ~50KB) or write a 50-line YAML-frontmatter parser ourselves?
   - **My lean:** `gray-matter`. Not worth the time saved by writing it.

4. **Manifest validation.** Zod, JSON Schema runtime, or hand-rolled?
   - **My lean:** Zod, since we'll have growing schemas (manifest, skill frontmatter, eventually `agent.yaml`).

5. **Plugin install source resolution.** Just `npm` for v0.3, or also git URLs / GitHub releases?
   - **My lean:** npm + local path for v0.3; git URLs in Phase 3.

6. **Hot reload (`SIGHUP`) — Phase 2 or Phase 3?**
   - Spec lists it under §2.4 (event-driven runtime, Phase 3).
   - **My lean:** keep `reload(id)` in the registry interface but defer the SIGHUP wiring.

7. **Built-in skills — ship any?**
   - Could ship `summarize`, `explain`, `commit-message` as starter skills.
   - **My lean:** no built-ins in Phase 2. Cleaner to keep skills as pure user/plugin contributions.

---

## 14. Risks

- **MCP protocol churn.** The spec evolves; pinning per release is the mitigation, but a major rev in the middle of Phase 2 could force a re-version.
- **Plugin sandboxing absence.** A malicious npm plugin can do anything our process can. Trust model is documented but it's a real risk for v1.0.
- **Tool name collisions across MCP servers.** Mitigated by `mcp__<server>__<tool>` namespacing — but if two MCP servers use the same `<server>` name, conflict at registration.
- **Permission rule explosion.** Each plugin contributes rules; the gate is currently O(n) per tool call. At ~100 plugins, this could matter. Profiling needed before slice 8 ships.

---

## 15. Acceptance check

Following Phase 1's pattern: declare Phase 2 done when the spec's exit bar is met:

> An external developer installs `@declaragent/plugin-github`, adds the GitHub MCP server, and writes a `pr-review.md` skill — using only the README.

Practically:
1. We publish `@declaragent/plugin-github` (or a fixture mock) with manifest declaring the github MCP server
2. A new user runs `declaragent plugin install @declaragent/plugin-github` → consent UI → approve
3. `declaragent` REPL starts; `mcp__github__*` tools are available
4. They drop a `~/.declaragent/skills/pr-review.md` file (frontmatter + prompt body)
5. `/skill pr-review --pr-url=https://github.com/...` runs the skill end-to-end

If that demo works without us holding their hand, Phase 2 ships.

---

## 16. Next step

Slice 1 (`ExtensionRegistry` skeleton) is the unblocker — small, isolated, no new deps. ~2 days, then everything else can fork.

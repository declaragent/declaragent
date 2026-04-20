# Extending Your Agent: Plugins, MCP, Skills, Sub-Agents

Companion to `BUILDING_A_GENERIC_AGENT.md`. That doc built the core; this one adds the four extension surfaces that make the agent actually useful and extensible by others.

---

## Table of Contents

1. [How the Four Surfaces Relate](#1-how-the-four-surfaces-relate)
2. [The Common Foundation: Extension Registry](#2-the-common-foundation)
3. [MCP Servers](#3-mcp-servers)
4. [Skills](#4-skills)
5. [Sub-Agents](#5-sub-agents)
6. [Plugins: The Container](#6-plugins-the-container)
7. [Worked Example: A "git-helper" Plugin](#7-worked-example)
8. [Security Considerations Per Surface](#8-security)
9. [Build Order & Milestones](#9-build-order)
10. [Common Pitfalls](#10-common-pitfalls)

---

## 1. How the Four Surfaces Relate

First, clarify what each one **is** and **isn't**:

| Surface | What it is | Who invokes | Runs where | Language |
|---|---|---|---|---|
| **MCP Server** | An external process exposing tools/resources/prompts over stdio or HTTP | The model (as tools) | Separate process | Any |
| **Skill** | A reusable prompt+workflow bundle (markdown + frontmatter) | User *or* model | Spawns a sub-agent | N/A (declarative) |
| **Sub-Agent** | A nested `runAgent()` invocation with isolated context | The model (via AgentTool) | In-process, isolated | Same as host |
| **Plugin** | A package that bundles any combination of tools, commands, skills, MCP configs, hooks | Loaded at startup | In-process | Same as host |

### The nesting relationship

```
┌─ Plugin ──────────────────────────────────────┐
│  Can bundle:                                    │
│   ├─ Native tools                              │
│   ├─ Slash commands                            │
│   ├─ Skills ──► spawn Sub-Agent                │
│   ├─ MCP server configs ──► MCP tools           │
│   └─ Hooks (pre/post tool-use)                 │
└────────────────────────────────────────────────┘

Sub-Agent = runAgent() recursion, invoked by a tool
MCP Server = external process whose tools get proxied into the registry
Skill = high-level workflow, spawns a sub-agent under the hood
Plugin = the distribution unit that packages any of the above
```

### When to use which

| Use case | Best surface |
|---|---|
| "I want a tool implemented in Python" | MCP server |
| "I want a team-sharable GitHub tool" | MCP server |
| "I want a reusable workflow: scan repo, draft PR description, post it" | Skill |
| "I want to delegate a noisy task without burning parent tokens" | Sub-agent (via AgentTool) |
| "I want to ship a namespaced bundle of tools + commands + workflows" | Plugin |
| "I need to intercept every Bash call for compliance logging" | Plugin with a hook |

**Rule of thumb**: if a user or another machine writes it, it's probably a skill or MCP server. If a developer writes it in your codebase, it's a tool or plugin.

---

## 2. The Common Foundation

All four surfaces eventually funnel into the same registries. Build this spine first:

```typescript
// src/extensions/context.ts
export type ExtensionContext = {
  tools: ToolRegistry;
  commands: CommandRegistry;
  skills: SkillRegistry;
  hooks: HookRegistry;
  mcpConnections: Map<string, McpConnection>;

  // Lifecycle
  register(ext: Extension): void;
  unload(extId: string): Promise<void>;

  // Shared services
  llm: LLMClient;
  config: Config;
  logger: Logger;
};
```

### The extension lifecycle hooks

Every loadable extension implements a common interface:

```typescript
// src/extensions/types.ts
export interface Extension {
  id: string;                     // "git-helper", "mcp__github", "skill:pr-review"
  type: 'plugin' | 'mcp' | 'skill';
  version: string;

  /** Called once at load. Register tools/commands/skills. */
  activate(ctx: ExtensionContext): Promise<void>;

  /** Called on unload/reload. Clean up processes, handlers, state. */
  deactivate?(ctx: ExtensionContext): Promise<void>;
}
```

This uniform lifecycle means your agent can hot-reload a skill, restart a crashed MCP server, and unload a plugin using the same machinery.

---

## 3. MCP Servers

The **Model Context Protocol** is how external tools plug in. Any language, any runtime. Build this before you invent your own plugin system — your users likely already know MCP.

### 3.1 The shape of an MCP server

An MCP server is a process that speaks JSON-RPC 2.0 over one of:

- **stdio** — child process, JSON-RPC framed on stdin/stdout. 95% of servers use this.
- **HTTP + SSE** — for remote/hosted servers. Rare but increasing.
- **WebSocket** — niche.

Capabilities it can offer:

| Capability | What it provides |
|---|---|
| `tools` | Callable functions (your agent calls these like native tools) |
| `resources` | Named read-only data (files, DB records, API results) |
| `prompts` | Parameterized prompt templates |
| `sampling` | Server asks *your* agent's LLM on its behalf (rarely used) |
| `elicitation` | Server requests mid-call user input |

For a first implementation, support `tools` + `resources`. Add `prompts` later.

### 3.2 Config format

```json
// ~/.youragent/mcp.json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" },
      "disabled": false
    },
    "postgres": {
      "command": "mcp-postgres",
      "args": ["--connection-string", "${env:DATABASE_URL}"]
    },
    "hosted-analytics": {
      "transport": "http",
      "url": "https://mcp.example.com/v1",
      "headers": { "Authorization": "Bearer ${env:ANALYTICS_TOKEN}" }
    }
  }
}
```

Support **env var substitution** (`${env:NAME}`) — users shouldn't commit secrets.

### 3.3 Client implementation

```typescript
// src/services/mcp/client.ts
import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class McpClient extends EventEmitter {
  private proc?: ChildProcess;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private nextId = 1;
  private buffer = '';

  constructor(public config: McpServerConfig) { super(); }

  async connect(): Promise<void> {
    if (this.config.transport === 'http') return this.connectHttp();
    return this.connectStdio();
  }

  private async connectStdio(): Promise<void> {
    this.proc = spawn(this.config.command!, this.config.args ?? [], {
      env: { ...process.env, ...expandEnvVars(this.config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk) => this.onData(chunk.toString()));
    this.proc.stderr!.on('data', (chunk) => {
      this.emit('log', { level: 'warn', msg: chunk.toString() });
    });
    this.proc.on('exit', (code) => {
      this.emit('exit', code);
      this.rejectAllPending(new Error(`MCP server exited with code ${code}`));
    });

    await this.handshake();
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    // MCP framing: line-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.handleMessage(JSON.parse(line)); }
      catch (e) { this.emit('error', e); }
    }
  }

  private handleMessage(msg: any) {
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new McpError(msg.error));
      else pending.resolve(msg.result);
    } else if (msg.method === 'notifications/progress') {
      this.emit('progress', msg.params);
    } else if (msg.method === 'notifications/message') {
      this.emit('log', msg.params);
    }
  }

  async request(method: string, params?: any, opts?: { timeoutMs?: number }): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      if (opts?.timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`MCP timeout: ${method}`));
        }, opts.timeoutMs);
      }

      this.proc!.stdin!.write(payload);
    });
  }

  private async handshake() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: 'my-agent', version: '0.1.0' },
    }, { timeoutMs: 10_000 });

    this.capabilities = result.capabilities;
    await this.request('notifications/initialized');  // notification, no response
  }

  async close() {
    this.proc?.kill('SIGTERM');
    setTimeout(() => this.proc?.kill('SIGKILL'), 5000);
  }
}
```

### 3.4 Discovering and wrapping MCP tools

```typescript
// src/services/mcp/discovery.ts
export async function discoverMcpTools(
  serverName: string,
  client: McpClient,
): Promise<Tool[]> {
  const { tools } = await client.request('tools/list');

  return tools.map((remote: McpToolDef) => wrapMcpTool(serverName, remote, client));
}

function wrapMcpTool(serverName: string, remote: McpToolDef, client: McpClient): Tool {
  // Convert JSON Schema to Zod for runtime validation
  const inputSchema = jsonSchemaToZod(remote.inputSchema);

  return {
    name: `mcp__${serverName}__${remote.name}`,
    description: remote.description ?? `(from ${serverName})`,
    inputSchema,

    isReadOnly: () => remote.annotations?.readOnlyHint ?? false,
    isDestructive: (input) => remote.annotations?.destructiveHint ?? false,

    async checkPermissions(input, ctx) {
      const ruleKey = `mcp__${serverName}`;
      if (matchRule(ctx.rules.deny, ruleKey, '*')) return { behavior: 'deny', message: 'Denied' };
      if (matchRule(ctx.rules.allow, ruleKey, '*')) return { behavior: 'allow' };
      return { behavior: 'ask' };  // default: prompt
    },

    async call(input, ctx, onProgress) {
      const progressToken = `mcp-${Math.random().toString(36).slice(2)}`;

      const onProgressMsg = (params: any) => {
        if (params.progressToken === progressToken) {
          onProgress?.({ type: 'progress', data: params });
        }
      };
      client.on('progress', onProgressMsg);

      try {
        const result = await client.request('tools/call', {
          name: remote.name,
          arguments: input,
          _meta: { progressToken },
        }, { timeoutMs: 120_000 });

        return {
          content: extractTextContent(result.content),
          isError: !!result.isError,
          data: result,
        };
      } finally {
        client.off('progress', onProgressMsg);
      }
    },
  };
}

function extractTextContent(content: McpContent[]): string {
  return content
    .map(c => c.type === 'text' ? c.text : `[${c.type} block]`)
    .join('\n');
}
```

### 3.5 Elicitation (mid-call user input)

Some MCP tools need to ask the user something mid-execution — a confirmation, a missing parameter. MCP represents this as a specific error code:

```typescript
// In wrapMcpTool's call() — catch elicitation errors:
} catch (e) {
  if (e instanceof McpError && e.code === -32042) {
    // Server requests elicitation
    const answer = await ctx.promptUser(e.data.message, e.data.schema);
    // Retry with answer
    return client.request('tools/call', {
      name: remote.name,
      arguments: { ...input, __elicitation__: answer },
    });
  }
  throw e;
}
```

### 3.6 Lifecycle: load, reload, crash recovery

```typescript
// src/services/mcp/manager.ts
export class McpManager {
  private connections = new Map<string, McpClient>();

  async loadAll(config: McpConfig, registry: ToolRegistry) {
    await Promise.all(
      Object.entries(config.servers)
        .filter(([, c]) => !c.disabled)
        .map(([name, c]) => this.load(name, c, registry).catch(e => {
          this.logger.warn(`Failed to load MCP server ${name}: ${e.message}`);
        })),
    );
  }

  async load(name: string, config: McpServerConfig, registry: ToolRegistry) {
    const client = new McpClient(config);

    client.on('exit', (code) => {
      this.logger.warn(`MCP server ${name} exited (${code}). Auto-restart in 5s...`);
      setTimeout(() => this.load(name, config, registry), 5000);
    });

    await client.connect();
    this.connections.set(name, client);

    const tools = await discoverMcpTools(name, client);
    for (const t of tools) registry.register(t);
  }

  async unload(name: string, registry: ToolRegistry) {
    const client = this.connections.get(name);
    if (!client) return;
    await client.close();
    this.connections.delete(name);
    registry.unregisterByPrefix(`mcp__${name}__`);
  }
}
```

### 3.7 Resources

MCP servers can also expose resources (named read-only data). These go in a **separate** registry, not the tool registry:

```typescript
// src/services/mcp/resources.ts
export async function discoverMcpResources(serverName: string, client: McpClient) {
  const { resources } = await client.request('resources/list');
  return resources.map(r => ({
    uri: r.uri,
    name: r.name,
    mimeType: r.mimeType,
    serverName,
    read: () => client.request('resources/read', { uri: r.uri }),
  }));
}
```

Expose these to the model via a built-in `ListResources` + `ReadResource` tool. Don't register each resource as a tool — that pollutes the tool list.

---

## 4. Skills

A **skill** is a reusable workflow: a prompt template, an optional tool allowlist, and metadata. Skills are *declarative* — a markdown file with frontmatter. No code.

### 4.1 Skill file format

```markdown
---
name: pr-review
description: Review a pull request against the project's conventions
model: claude-sonnet-4-6
tools: [Bash, Read, Grep, Glob]
requires_context:
  - current_branch
  - git_diff
inputs:
  pr_number:
    type: string
    description: "The PR number to review"
---

You are reviewing PR #{{pr_number}} on the current branch.

Steps:
1. Read the PR description with `gh pr view {{pr_number}}`.
2. Run the diff: `gh pr diff {{pr_number}}`.
3. Check the code against CONTRIBUTING.md conventions.
4. Look for the typical issues: missing tests, unhandled errors, leaked secrets.
5. Post your review to stdout as markdown.

Be concise. If there are no issues, say so in one line.
```

### 4.2 Skill discovery

Skills come from three sources (in priority order):

```typescript
// src/services/skills/discovery.ts
const SKILL_SEARCH_PATHS = [
  // 1. Project-local
  path.join(cwd, '.youragent', 'skills'),
  // 2. User-global
  path.join(os.homedir(), '.youragent', 'skills'),
  // 3. Bundled with the binary
  path.join(__dirname, '..', '..', 'skills', 'bundled'),
];

export async function discoverSkills(): Promise<Skill[]> {
  const skills = new Map<string, Skill>();

  for (const dir of SKILL_SEARCH_PATHS) {
    if (!await exists(dir)) continue;
    for (const file of await glob('**/*.md', { cwd: dir })) {
      const skill = await loadSkill(path.join(dir, file));
      // First-found wins (project overrides user overrides bundled)
      if (!skills.has(skill.name)) skills.set(skill.name, skill);
    }
  }

  return Array.from(skills.values());
}
```

### 4.3 Loading a skill

```typescript
// src/services/skills/loader.ts
import matter from 'gray-matter';
import { z } from 'zod';

const FrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  requires_context: z.array(z.string()).optional(),
  inputs: z.record(z.object({
    type: z.enum(['string', 'number', 'boolean']),
    description: z.string().optional(),
    required: z.boolean().optional().default(false),
  })).optional(),
});

export async function loadSkill(path: string): Promise<Skill> {
  const raw = await fs.readFile(path, 'utf-8');
  const { data, content } = matter(raw);
  const fm = FrontmatterSchema.parse(data);

  return {
    id: `skill:${fm.name}`,
    name: fm.name,
    description: fm.description,
    path,
    promptTemplate: content,
    model: fm.model,
    allowedTools: fm.tools,
    inputs: fm.inputs ?? {},
    requiresContext: fm.requires_context ?? [],
  };
}
```

### 4.4 Executing a skill

A skill executes as a **sub-agent** (§5). This is the reuse point:

```typescript
// src/services/skills/execute.ts
export async function* executeSkill(
  skill: Skill,
  inputs: Record<string, unknown>,
  parent: ExtensionContext,
): AsyncGenerator<EngineEvent> {
  // 1. Validate inputs against the skill's input schema
  for (const [key, def] of Object.entries(skill.inputs)) {
    if (def.required && !(key in inputs)) {
      throw new Error(`Skill ${skill.name} requires input: ${key}`);
    }
  }

  // 2. Substitute variables in the prompt template
  const prompt = substituteTemplate(skill.promptTemplate, inputs);

  // 3. Gather required context
  const contextMessages = await gatherContext(skill.requiresContext, parent);

  // 4. Filter tools to the skill's allowlist
  const toolsForSkill = skill.allowedTools
    ? parent.tools.filter(t => skill.allowedTools!.includes(t.name))
    : parent.tools.forSubagent();  // safe default subset

  // 5. Spawn a sub-agent
  yield* runAgent({
    messages: [...contextMessages, { role: 'user', content: prompt }],
    tools: toolsForSkill,
    permissions: createChildPermissions(parent),
    llm: parent.llm,
    model: skill.model ?? parent.config.defaultModel,
    abortSignal: parent.abortSignal,
  });
}
```

### 4.5 Invoking skills

Two invocation paths:

**From the user (as a slash command):**

```typescript
// src/commands/skillCommand.ts
export function buildSkillCommand(skill: Skill): Command {
  return {
    name: skill.name,
    description: skill.description,
    async run(ctx) {
      const inputs = parseArgs(ctx.args, skill.inputs);
      const events: EngineEvent[] = [];
      for await (const e of executeSkill(skill, inputs, ctx.extensions)) {
        events.push(e);
      }
      return { injectMessages: extractFinalMessages(events) };
    },
  };
}
```

**From the model (as a tool):**

```typescript
// src/tools/skillTool.ts — one tool, dispatches to any skill
export const SkillTool: Tool<{ name: string; inputs: Record<string, unknown> }> = {
  name: 'Skill',
  description: 'Run a named skill. Available skills are listed in the system prompt.',
  inputSchema: z.object({
    name: z.string(),
    inputs: z.record(z.unknown()).optional().default({}),
  }),
  isReadOnly: () => false,

  async checkPermissions(input, ctx) {
    const skill = ctx.skills.get(input.name);
    if (!skill) return { behavior: 'deny', message: `Unknown skill: ${input.name}` };
    return { behavior: 'ask' };
  },

  async call(input, ctx, onProgress) {
    const skill = ctx.skills.get(input.name)!;
    let finalText = '';
    for await (const event of executeSkill(skill, input.inputs, ctx.extensions)) {
      if (event.type === 'assistant_delta') finalText += event.text;
      onProgress?.({ type: 'progress', data: event });
    }
    return { content: finalText };
  },
};
```

### 4.6 Making skills discoverable to the model

Inject the skill catalog into the system prompt:

```typescript
function buildSkillsPromptSection(skills: Skill[]): string {
  if (skills.length === 0) return '';
  return `\n\n## Available Skills\n\n${
    skills.map(s => `- **${s.name}**: ${s.description}`).join('\n')
  }\n\nUse the \`Skill\` tool with \`{ "name": "<skill-name>" }\` to invoke.`;
}
```

### 4.7 Why skills beat custom tools for workflows

| | Custom tool | Skill |
|---|---|---|
| Written by | Developer (TypeScript) | User (Markdown) |
| Deployed by | Code release | Drop a file in `~/.youragent/skills/` |
| Shares parent context | Yes (directly) | No (sub-agent isolation) |
| Token cost | Low (one API call) | Higher (sub-agent loop) |
| Best for | Primitives | Compositions of primitives |

---

## 5. Sub-Agents

A **sub-agent** is a nested call to your core `runAgent()` with:

- A **restricted** toolset
- An **isolated** context (no shared mutable state with parent)
- A **scoped** result (only the final answer bubbles up)

### 5.1 The AgentTool

```typescript
// src/tools/agentTool.ts
const SUBAGENT_DEFAULT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];  // no Edit, no SpawnAgent

export const AgentTool: Tool<AgentInput, AgentOutput, AgentProgress> = {
  name: 'Agent',
  description: `Spawn a sub-agent to handle a focused task. The sub-agent has its own context
and returns only its final answer. Good for:
- Searches that would clutter your context
- Exploratory tasks with uncertain scope
- Parallel investigations (call multiple AgentTools in one response)`,

  inputSchema: z.object({
    task: z.string().min(10).describe('The full task description for the sub-agent'),
    tools: z.array(z.string()).optional().describe('Tool allowlist; defaults to read-only set'),
    model: z.string().optional(),
    max_turns: z.number().optional().default(20),
  }),

  isReadOnly: (input) => {
    // If the subagent has no write tools, it's read-only
    const tools = input.tools ?? SUBAGENT_DEFAULT_TOOLS;
    return !tools.some(t => ['Edit', 'Write', 'Bash'].includes(t));
  },

  async checkPermissions(input, ctx) {
    // Require explicit approval for destructive sub-agents
    if (input.tools?.includes('Edit') || input.tools?.includes('Bash')) {
      return { behavior: 'ask', message: 'Sub-agent with write tools' };
    }
    return ctx.mode === 'bypass' ? { behavior: 'allow' } : { behavior: 'ask' };
  },

  async call(input, ctx, onProgress) {
    const childCtx = createSubagentContext(ctx, {
      allowedTools: input.tools ?? SUBAGENT_DEFAULT_TOOLS,
      model: input.model,
      maxTurns: input.max_turns,
    });

    const childId = createAgentId();
    let finalAnswer = '';
    let turnCount = 0;
    const transcript: EngineEvent[] = [];

    try {
      for await (const event of runAgent({
        messages: [{ role: 'user', content: input.task }],
        tools: childCtx.tools,
        permissions: childCtx.permissions,
        llm: ctx.llm,
        model: childCtx.model,
        abortSignal: ctx.abortSignal,
      })) {
        transcript.push(event);

        if (event.type === 'assistant_delta') finalAnswer += event.text;
        if (event.type === 'turn_complete') {
          turnCount++;
          if (turnCount >= input.max_turns!) break;
        }

        // Forward selected progress to parent UI
        if (event.type === 'tool_use' || event.type === 'tool_progress') {
          onProgress?.({ type: 'progress', data: { childId, event } });
        }
      }
    } finally {
      // Always persist the sub-agent's transcript, even on error
      await persistSubagentTranscript(childId, transcript);
    }

    return {
      content: finalAnswer.trim(),
      data: { childId, turnCount },
    };
  },
};
```

### 5.2 Sub-agent context isolation

The critical rule: **the sub-agent cannot mutate the parent.**

```typescript
// src/agent/subagentContext.ts
export function createSubagentContext(
  parent: ToolContext,
  opts: { allowedTools: string[]; model?: string; maxTurns: number },
): {
  tools: ToolRegistry;
  permissions: PermissionContext;
  model: string;
} {
  return {
    // Filtered tools — no AgentTool by default (no recursive spawning)
    tools: parent.tools.filter(t =>
      opts.allowedTools.includes(t.name) && t.name !== 'Agent'
    ),

    permissions: {
      ...parent.permissions,
      // Child inherits rules but owns its denial counter
      denialCount: 0,
      // Child cannot change parent's permission mode
      onAsk: parent.permissions.onAsk,  // prompts still bubble to user
    },

    model: opts.model ?? parent.model,
  };
}
```

### 5.3 What the parent sees

```
PARENT SEES:                    PARENT DOES NOT SEE:
- The final answer string       - Sub-agent's thinking blocks
- Sub-agent session ID          - All intermediate tool calls
- Selected progress events      - Failed attempts
- Total turn count              - Raw tool outputs within sub-agent
```

This isolation is **how agents stay sane at scale**. A "find all callers of X" task might do 30 Greps and 10 Reads — the parent doesn't need 400KB of raw grep output polluting its context.

### 5.4 Abort propagation

Parent Ctrl+C must kill all descendants. The cleanest pattern:

```typescript
// Parent has one AbortController
const rootAbort = new AbortController();
process.on('SIGINT', () => rootAbort.abort());

// Every ctx.abortSignal derives from this:
function createSubagentContext(parent) {
  const childAbort = new AbortController();
  parent.abortSignal.addEventListener('abort', () => childAbort.abort());
  return { ...parent, abortSignal: childAbort.signal };
}
```

Each child can abort independently (e.g., if it exceeds `max_turns`), but if the parent aborts, everything aborts.

### 5.5 Parallel sub-agents

The killer feature: the model can fire multiple `AgentTool` calls in a single response, and they run in parallel (they're all read-only to the parent's state):

```typescript
// Back in the dispatcher from BUILDING_A_GENERIC_AGENT.md §4:
if (batch.readOnly) {
  const batchResults = await Promise.all(
    batch.uses.map(u => executeOne(u, tools, permissions, abortSignal, emit)),
  );
}
```

Three `AgentTool` calls = three sub-agents running concurrently. Each with its own LLM session, its own tool budget, its own transcript. The parent collects three answers in the time of one.

### 5.6 Persistence

Each sub-agent writes its own transcript:

```typescript
async function persistSubagentTranscript(childId: string, events: EngineEvent[]) {
  const path = `${sessionsDir()}/agents/${childId}.jsonl`;
  await fs.mkdir(path.dirname(path), { recursive: true });
  await fs.writeFile(path, events.map(e => JSON.stringify(e)).join('\n'));
}
```

Why? Because when a user asks "what did that agent do?", you need an answer. `/agent-log <childId>` becomes a debugging god-mode.

---

## 6. Plugins: The Container

A plugin packages **any combination** of tools, commands, skills, MCP configs, and hooks into a single distributable unit. Think of it as an npm package for your agent.

### 6.1 Plugin structure

```
git-helper/
├── plugin.json              # Manifest
├── src/
│   ├── tools/
│   │   ├── GitStatusTool.ts
│   │   └── GitLogTool.ts
│   ├── commands/
│   │   └── commit.ts
│   └── hooks/
│       └── preventForcePush.ts
├── skills/
│   ├── review-pr.md
│   └── write-release-notes.md
├── mcp/
│   └── github.json          # MCP server configs shipped with plugin
└── README.md
```

### 6.2 Plugin manifest

```json
{
  "id": "git-helper",
  "name": "Git Helper",
  "version": "0.3.0",
  "description": "Git workflows, PR reviews, commit assistance",
  "author": "you@example.com",
  "agent_compat": ">=0.5.0",
  "entrypoint": "./dist/index.js",
  "permissions": {
    "requires": ["Bash(git *)", "Read(**/*)"],
    "provides_tools": ["GitStatus", "GitLog"],
    "provides_commands": ["/pr", "/commit-ai"]
  },
  "skills_dir": "./skills",
  "mcp_configs": ["./mcp/github.json"]
}
```

**Declare everything up-front.** The manifest is the security contract — users can see what a plugin will do before they install it.

### 6.3 Plugin entrypoint

```typescript
// git-helper/src/index.ts
import type { Plugin, ExtensionContext } from 'my-agent/api';
import { GitStatusTool } from './tools/GitStatusTool';
import { GitLogTool } from './tools/GitLogTool';
import { commitCommand } from './commands/commit';
import { preventForcePushHook } from './hooks/preventForcePush';

const plugin: Plugin = {
  id: 'git-helper',
  type: 'plugin',
  version: '0.3.0',

  async activate(ctx: ExtensionContext) {
    // Register tools
    ctx.tools.register(GitStatusTool);
    ctx.tools.register(GitLogTool);

    // Register commands
    ctx.commands.register(commitCommand);

    // Register hooks
    ctx.hooks.register('preToolUse', preventForcePushHook);

    // Load bundled MCP servers from manifest
    for (const mcpConfigPath of ctx.pluginDir('mcp_configs')) {
      const config = JSON.parse(await fs.readFile(mcpConfigPath, 'utf-8'));
      await ctx.mcp.load(config.name, config, ctx.tools);
    }

    // Skills are auto-discovered from skills_dir by the host

    ctx.logger.info('git-helper loaded');
  },

  async deactivate(ctx) {
    ctx.tools.unregisterByPlugin('git-helper');
    ctx.commands.unregisterByPlugin('git-helper');
    ctx.hooks.unregisterByPlugin('git-helper');
    // MCP connections owned by this plugin get cleaned up
    for (const name of ['github']) {
      await ctx.mcp.unload(name, ctx.tools);
    }
  },
};

export default plugin;
```

### 6.4 Plugin loader

```typescript
// src/services/plugins/loader.ts
export class PluginLoader {
  private loaded = new Map<string, Plugin>();

  async loadFromDir(dir: string, ctx: ExtensionContext): Promise<Plugin> {
    const manifestPath = path.join(dir, 'plugin.json');
    const manifest = PluginManifestSchema.parse(
      JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    );

    // Compatibility check
    if (!semver.satisfies(ctx.agentVersion, manifest.agent_compat)) {
      throw new Error(`Plugin ${manifest.id} requires agent ${manifest.agent_compat}`);
    }

    // User consent — show declared permissions
    const consent = await ctx.promptConsent({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      permissions: manifest.permissions,
    });
    if (!consent) throw new Error(`User declined plugin ${manifest.id}`);

    // Load entrypoint
    const modulePath = path.resolve(dir, manifest.entrypoint);
    const module = await import(modulePath);
    const plugin: Plugin = module.default;

    // Scoped context — the plugin can only register with a tag
    const scopedCtx = {
      ...ctx,
      tools: ctx.tools.scoped(manifest.id),
      commands: ctx.commands.scoped(manifest.id),
      hooks: ctx.hooks.scoped(manifest.id),
      pluginDir: (subdir: string) => path.join(dir, subdir),
    };

    await plugin.activate(scopedCtx);
    this.loaded.set(manifest.id, plugin);

    // Auto-discover skills from manifest's skills_dir
    if (manifest.skills_dir) {
      const skillsDir = path.join(dir, manifest.skills_dir);
      for (const skill of await discoverSkillsIn(skillsDir)) {
        ctx.skills.register({ ...skill, pluginId: manifest.id });
      }
    }

    return plugin;
  }

  async unload(id: string, ctx: ExtensionContext) {
    const plugin = this.loaded.get(id);
    if (!plugin) return;
    await plugin.deactivate?.(ctx);
    ctx.skills.unregisterByPlugin(id);
    this.loaded.delete(id);
  }

  async reload(id: string, ctx: ExtensionContext) {
    const plugin = this.loaded.get(id);
    if (!plugin) throw new Error(`Not loaded: ${id}`);
    const dir = plugin.dir!;
    await this.unload(id, ctx);
    // Bust the require cache for hot reload
    delete require.cache[require.resolve(path.resolve(dir, 'index.js'))];
    await this.loadFromDir(dir, ctx);
  }
}
```

### 6.5 Plugin search paths

```typescript
const PLUGIN_SEARCH_PATHS = [
  path.join(cwd, '.youragent', 'plugins'),       // project-local
  path.join(os.homedir(), '.youragent', 'plugins'),  // user-global
  path.join(__dirname, '..', 'plugins', 'bundled'),  // built-in
];
```

### 6.6 The scoped registry pattern

Why scope every registration to a plugin ID? **Clean unloading.**

```typescript
export class ScopedToolRegistry {
  constructor(private parent: ToolRegistry, private pluginId: string) {}

  register(tool: Tool) {
    this.parent.register({ ...tool, _pluginId: this.pluginId });
  }
}

// In the parent:
unregisterByPlugin(pluginId: string) {
  for (const [name, tool] of this.tools) {
    if (tool._pluginId === pluginId) this.tools.delete(name);
  }
}
```

Now `plugin.deactivate()` doesn't need to know what it registered — the host tracks it.

### 6.7 Hooks: the plugin's cross-cutting power

Hooks let a plugin intercept tool calls without being a tool itself:

```typescript
export type Hook = {
  phase: 'preToolUse' | 'postToolUse' | 'preLLMCall';
  run(event: HookEvent): Promise<HookResult>;
};

type HookResult =
  | { action: 'continue' }
  | { action: 'deny'; message: string }
  | { action: 'mutate'; input: unknown };  // rewrite the tool input

// Example: prevent force-push
const preventForcePushHook: Hook = {
  phase: 'preToolUse',
  async run({ toolName, input }) {
    if (toolName === 'Bash' && /git\s+push.*--force/.test((input as any).command)) {
      return { action: 'deny', message: 'Force-push blocked by git-helper plugin' };
    }
    return { action: 'continue' };
  },
};
```

Hooks run inside `resolvePermission()` (see `BUILDING_A_GENERIC_AGENT.md` §5). They're the **single most useful extension point for compliance/safety plugins**.

---

## 7. Worked Example: A "git-helper" Plugin

Pulling all four surfaces together in one plugin.

### Structure

```
git-helper/
├── plugin.json
├── src/
│   ├── index.ts
│   ├── tools/
│   │   └── GitStatusTool.ts        # Native tool
│   ├── commands/
│   │   └── commitAi.ts              # Slash command
│   ├── hooks/
│   │   └── preventForcePush.ts      # Pre-tool-use hook
│   └── subagents/
│       └── spawnReviewAgent.ts      # Helper that uses AgentTool
├── skills/
│   └── pr-review.md                 # Skill (Markdown workflow)
└── mcp/
    └── github.json                  # MCP server config
```

### `plugin.json`

```json
{
  "id": "git-helper",
  "name": "Git Helper",
  "version": "0.1.0",
  "agent_compat": ">=0.5.0",
  "entrypoint": "./dist/index.js",
  "permissions": {
    "requires": ["Bash(git *)", "Bash(gh *)", "Read(**/*)"],
    "provides_tools": ["GitStatus"],
    "provides_commands": ["/commit-ai"]
  },
  "skills_dir": "./skills",
  "mcp_configs": ["./mcp/github.json"]
}
```

### `src/index.ts`

```typescript
import { GitStatusTool } from './tools/GitStatusTool';
import { commitAiCommand } from './commands/commitAi';
import { preventForcePushHook } from './hooks/preventForcePush';

export default {
  id: 'git-helper',
  type: 'plugin',
  version: '0.1.0',

  async activate(ctx) {
    ctx.tools.register(GitStatusTool);
    ctx.commands.register(commitAiCommand);
    ctx.hooks.register('preToolUse', preventForcePushHook);

    // MCP server config is auto-loaded by the host based on manifest.mcp_configs
    // Skills are auto-discovered from manifest.skills_dir
  },
};
```

### `src/tools/GitStatusTool.ts` (native tool)

```typescript
export const GitStatusTool: Tool<{}, GitStatus> = {
  name: 'GitStatus',
  description: 'Get structured git status (branch, staged, unstaged, untracked).',
  inputSchema: z.object({}),
  isReadOnly: () => true,

  async checkPermissions() { return { behavior: 'allow' }; },  // read-only, safe

  async call(_input, ctx) {
    const { stdout } = await execAsync('git status --porcelain=v2 --branch', { cwd: ctx.cwd });
    const parsed = parseGitStatus(stdout);
    return {
      content: JSON.stringify(parsed, null, 2),
      data: parsed,
    };
  },
};
```

### `src/commands/commitAi.ts` (slash command)

```typescript
export const commitAiCommand: Command = {
  name: 'commit-ai',
  description: 'Stage, analyze diff, write a commit message, create commit',

  async run(ctx) {
    // Inject a user message that tells the agent what to do
    const instruction = `
Run \`git add -A\`, then \`git diff --cached\`, analyze the changes,
craft a conventional-commits message, and create the commit.
    `.trim();

    return {
      injectMessages: [{ role: 'user', content: instruction }],
      shouldContinueQuery: true,  // the agent takes over from here
    };
  },
};
```

### `skills/pr-review.md` (skill — see §4.1)

```markdown
---
name: pr-review
description: Review a PR against project conventions
tools: [Bash, Read, Grep]
inputs:
  pr_number: { type: string, required: true }
---

Review PR #{{pr_number}}:
1. `gh pr view {{pr_number}}`
2. `gh pr diff {{pr_number}}`
3. Check against CONTRIBUTING.md
4. Flag missing tests, error handling, leaked secrets
5. Output a concise review
```

Invoked by user: `/pr-review 1234`. Invoked by model: `Skill({ name: "pr-review", inputs: { pr_number: "1234" } })`.

### `mcp/github.json` (MCP server config)

```json
{
  "name": "github",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" }
}
```

Auto-loaded at plugin activation. Exposes tools like `mcp__github__create_issue`, `mcp__github__list_prs`, etc.

### `src/hooks/preventForcePush.ts` (hook)

```typescript
export const preventForcePushHook: Hook = {
  phase: 'preToolUse',
  async run({ toolName, input }) {
    if (toolName === 'Bash' && /git\s+push\s+.*(-f|--force)/.test((input as any).command)) {
      return { action: 'deny', message: 'Force-push blocked by git-helper' };
    }
    return { action: 'continue' };
  },
};
```

### Sub-agents: using `AgentTool` from within a skill

Sub-agents aren't things *you register* — they're things the **model invokes** via `AgentTool` (which ships with the host). A skill that needs sub-agents just says so in its prompt:

```markdown
---
name: full-repo-audit
tools: [Read, Grep, Agent]  # allows spawning sub-agents
---

Audit this repo for security issues. For each of these areas, spawn a
sub-agent via the Agent tool and collect its findings:
- SQL injection risks (search for raw query building)
- XSS risks (search for unescaped template output)
- Secret leaks (search for hardcoded tokens)

Then synthesize the three findings into one report.
```

The skill prompt-directs the model to use `AgentTool`. No plugin code required for the sub-agent machinery itself — it's part of the host.

### The net result

After loading `git-helper`, the user has:

- A new native tool: `GitStatus` (code)
- A new slash command: `/commit-ai` (code)
- Access to ~30 GitHub tools: `mcp__github__*` (via MCP)
- A new skill: `/pr-review 1234` (markdown)
- A safety guardrail: force-pushes now blocked (hook)
- And the model can still spawn sub-agents as needed (host-provided AgentTool)

**All from a single plugin.**

---

## 8. Security Considerations Per Surface

Each surface has distinct risks. Handle them explicitly.

### MCP servers: **untrusted process execution**

| Risk | Mitigation |
|---|---|
| Malicious MCP server exfiltrates data | Explicit user consent on first `mcp.json` add; show `command` + `args` |
| MCP tools disguise destructive ops as read-only | Honor `annotations.readOnlyHint` **only as a hint** — always allow user to override |
| Rogue MCP server spams tool calls | Per-server rate limits + per-session call budgets |
| Server crashes mid-call | Auto-restart with backoff; surface errors clearly |
| Env var leakage via `${env:*}` | Explicit allowlist of env vars a server can request |

**Default posture**: every `mcp__*` tool prompts on first use, with the server name visible.

### Skills: **prompt injection via markdown**

| Risk | Mitigation |
|---|---|
| Malicious skill tricks model into exfiltrating | Skills run as sub-agents with inherited permission rules — they can't silently approve |
| Skill reads unbounded files | `tools` allowlist in frontmatter is **enforced**, not a hint |
| Team-shared skill compromised | Review before enabling; sign skills if it matters |

**Default posture**: skills can only use tools they explicitly list. No allowlist → read-only default set.

### Sub-agents: **token budget exhaustion**

| Risk | Mitigation |
|---|---|
| Recursive spawning → infinite cost | Disable `AgentTool` in sub-agent toolsets by default |
| Sub-agent makes destructive tool calls behind parent's back | Permission prompts still bubble to the user — they see every write |
| Long-running sub-agent hangs | `max_turns` cap + `abortSignal` propagation + per-sub-agent timeout |
| Sub-agent exfiltrates to external MCP | Sub-agents inherit parent's MCP allowlist (not a free-for-all) |

**Default posture**: sub-agents run with a read-only tool set unless the caller explicitly widens it, and writes still prompt the user.

### Plugins: **arbitrary code execution**

| Risk | Mitigation |
|---|---|
| Plugin runs malicious code at load time | Require explicit user consent with declared permissions shown |
| Plugin registers a tool that bypasses permission checks | Every tool call goes through `resolvePermission()` — plugins can't bypass |
| Plugin exfiltrates on deactivate | Log all extension lifecycle events |
| Plugin breaks host version compat | `agent_compat` in manifest, checked at load |

**Default posture**: plugins load from known directories only (no auto-install from URLs), declared permissions are shown before activation, every registered tool still funnels through the permission gate.

---

## 9. Build Order & Milestones

Don't build all four surfaces at once. Sequence matters.

### Milestone X1 — `AgentTool` first (2–3 days)

Sub-agents come first because they're just a tool. No new infrastructure.

- Implement `AgentTool` using the existing `runAgent()`.
- Context isolation, transcript persistence, abort propagation.
- DoD: model can call `AgentTool({ task: "..." })` and get back a summary.

### Milestone X2 — MCP client (4–6 days)

Biggest payoff for users. Tackle next.

- stdio transport only (skip HTTP/SSE).
- Tool discovery + wrapping.
- Auto-restart on crash.
- `mcp.json` config loading with env substitution.
- DoD: add `@modelcontextprotocol/server-github` via config, list issues.

### Milestone X3 — Skills (3–4 days)

Now that sub-agents work, skills are thin.

- Markdown + frontmatter loader.
- Skill registry + search paths.
- Template substitution.
- `SkillTool` for model invocation + slash-command binding for user invocation.
- DoD: write a `pr-review.md` skill and invoke it both ways.

### Milestone X4 — Hooks (2–3 days)

Foundation for plugins.

- `HookRegistry` with `preToolUse`/`postToolUse`/`preLLMCall` phases.
- Integration with `resolvePermission()`.
- DoD: a hook that logs every Bash command to a file.

### Milestone X5 — Plugin loader (4–6 days)

Bring it all together.

- Manifest parser + compat check.
- Consent flow.
- Scoped registries.
- Hot reload.
- DoD: build a 3-file plugin that registers a tool, a command, and a hook; load/unload/reload cleanly.

**Total: ~3 weeks to full extensibility** on top of the core agent from `BUILDING_A_GENERIC_AGENT.md`.

---

## 10. Common Pitfalls

### ❌ Registering MCP tools without a namespace prefix

If your MCP server exposes a `read` tool and you also have a native `Read` tool, collision. Always prefix: `mcp__<server>__<tool>`. Non-negotiable.

### ❌ Letting sub-agents spawn sub-agents by default

Infinite recursion in cost. Whitelist `Agent` in the child toolset explicitly, never as a default.

### ❌ Sharing the parent's tool registry with a sub-agent

Sub-agents get a **filtered view**, not the root registry. Otherwise a sub-agent sees tools the caller didn't intend to grant.

### ❌ Storing MCP connections in global state

When you add hot reload or multi-session, global state bites hard. Own connections in a `McpManager` owned by the session.

### ❌ Skills with no tool allowlist

A skill that says "here's the prompt" with no `tools:` frontmatter gets the **full agent toolset**. Default to a read-only subset if the skill author doesn't specify.

### ❌ Plugins that don't declare permissions

Force manifests to list what they'll use. If a plugin registers a tool whose name wasn't declared, refuse to load. Treat the manifest as a contract.

### ❌ Treating hooks like event listeners

Hooks are **blocking authoritative decisions**. They don't get called "after the fact for logging" — they decide whether the tool runs. Don't `.then()` them; `await` them and honor their response.

### ❌ Mixing skill invocation paths

Some teams make skills invokable only by the model, not the user. This is a mistake — users should be able to invoke any skill as a slash command. The reverse (user-only skills) is the only sensible restriction.

### ❌ Loading untrusted MCP servers from a URL

Don't let users paste a URL to install an MCP server. File-path install only, with an explicit command visible. If you must support remote install, require a signature and a consent dialog that shows the command it will run.

### ❌ Forgetting abort signal wiring

If the parent hits Ctrl+C, every MCP call, every sub-agent, every hook must terminate. Wire `abortSignal` from the root controller all the way down. Test it.

### ❌ Plugin activation that mutates global state without cleanup

Every mutation in `activate()` must be reversed in `deactivate()`. If your plugin caches something outside the scoped registries, hot-reload will leak.

---

## Closing Thought

The four extension surfaces exist at different **altitudes**:

- **Sub-agents** — lowest altitude, part of the execution model itself.
- **MCP** — mid-altitude, process boundary for external code.
- **Skills** — higher altitude, declarative workflows on top of tools.
- **Plugins** — highest altitude, distribution container for all of the above.

Build bottom-up. Sub-agents first (they're just a tool). Then MCP (external tools). Then skills (workflows). Then plugins (the package). If you invert this order, you'll design abstractions for layers that don't exist yet, and redo them later.

Once these four surfaces are in place, **your agent is no longer a product you ship — it's a platform**. Users build for it. Teams share skills. Vendors ship MCP servers. You become the host, not the author of every feature. That's the goal.

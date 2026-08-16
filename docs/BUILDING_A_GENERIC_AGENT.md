# Building a Generic AI Agent

> ⚠️ **Historical design doc — not maintained.** This document predates the shipped
> implementation and is kept for design context only; command names, config shapes,
> versions, and file paths in it may no longer match the code. `docs/SPEC_AND_PLAN.md`
> supersedes it for requirements; for live capability status see `AGENTS.md`, and for
> user-facing behavior see the docs site (`docs-site/`).


A practical guide to building your own agent CLI, patterned on Claude Code's architecture. Language-agnostic in principle; code samples are TypeScript because that's the reference implementation. Port to Python/Go/Rust mechanically.

---

## Table of Contents

1. [Philosophy: What An Agent Actually Is](#1-philosophy)
2. [The Minimal Core: 5 Pieces](#2-the-minimal-core)
3. [Layer 1 — The Tool Contract](#3-layer-1--the-tool-contract)
4. [Layer 2 — The Agent Loop](#4-layer-2--the-agent-loop)
5. [Layer 3 — The Permission Gate](#5-layer-3--the-permission-gate)
6. [Layer 4 — Streaming & Progress](#6-layer-4--streaming--progress)
7. [Layer 5 — State & Message Types](#7-layer-5--state--message-types)
8. [Layer 6 — Commands (User Extension Surface)](#8-layer-6--commands)
9. [Layer 7 — Sub-Agents](#9-layer-7--sub-agents)
10. [Layer 8 — Context Compaction](#10-layer-8--context-compaction)
11. [Layer 9 — External Tools via MCP](#11-layer-9--external-tools-via-mcp)
12. [Layer 10 — Persistence: History, Memory, Resume](#12-layer-10--persistence)
13. [Layer 11 — The UI Layer](#13-layer-11--the-ui-layer)
14. [Layer 12 — Observability & Telemetry](#14-layer-12--observability)
15. [Putting It Together: A Full Scaffold](#15-putting-it-together)
16. [Build Order & Milestones](#16-build-order--milestones)
17. [Anti-Patterns to Avoid](#17-anti-patterns)

---

## 1. Philosophy

### What an agent really is

An AI agent is **three things wired together**:

1. A **loop** that sends a conversation to an LLM, reads the response, and if the response says "use tool X", actually executes X and feeds the result back.
2. A **set of tools** — code the model can invoke, each with a schema, a permission check, and an execute function.
3. A **gate** between the model's intent and the tool's execution — the layer that decides whether the call is allowed.

Everything else (commands, sub-agents, memory, MCP, UI, persistence) is **optional scaffolding** around those three. Don't build it until the core works.

### The one invariant you must protect

**Every tool call passes through exactly one permission decision point.** No exceptions. Not even for "safe" tools. Not even in debug mode. The moment you add a bypass, you've lost the ability to reason about what your agent can do.

### Design principle: streaming-first

Build on **async generators** (or Rx / channels in your language of choice). Every output — token deltas, tool progress, assistant messages, final results — is yielded through the same pipe. This makes the difference between:

- Building a CLI, then a web UI, then an SDK, as three separate projects
- Building one streaming engine and swapping renderers

It's the single most consequential architectural decision you'll make.

---

## 2. The Minimal Core

For a working MVP you need exactly five modules:

```
src/
├── engine.ts         # The loop (~300 lines)
├── tools/
│   ├── types.ts      # Tool interface (~50 lines)
│   ├── registry.ts   # Registration + lookup (~30 lines)
│   ├── bash.ts       # Representative tool (~100 lines)
│   ├── read.ts       # Representative tool (~60 lines)
│   └── edit.ts       # Representative tool (~80 lines)
├── permissions.ts    # Gate (~100 lines)
├── llm.ts            # API client wrapper (~80 lines)
└── main.ts           # REPL / CLI (~150 lines)
```

Total: ~1,000 lines. That's a working agent. Everything else in this document is incremental capability on top of these five files.

---

## 3. Layer 1 — The Tool Contract

The tool contract is the spine of the whole system. Get this right and everything else falls into place.

### The interface

```typescript
// tools/types.ts
import { z } from 'zod';

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message?: string };

export type ToolContext = {
  sessionId: string;
  cwd: string;
  abortSignal: AbortSignal;
  mode: 'default' | 'plan' | 'bypass' | 'auto';
  rules: PermissionRules;
};

export type ToolResult<T = unknown> = {
  content: string;             // what the model sees
  data?: T;                    // structured data for the UI
  isError?: boolean;
};

export type ToolProgress<P = unknown> = {
  type: 'progress';
  data: P;
};

export interface Tool<Input = unknown, Output = unknown, Progress = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;

  /** Fast, synchronous-ish checks: path exists, size under limit, syntax ok. */
  validateInput?(input: Input, ctx: ToolContext): Promise<void>;

  /** The single choke point. Called before every execution. */
  checkPermissions(input: Input, ctx: ToolContext): Promise<PermissionDecision>;

  /** The actual work. Yields progress, returns final result. */
  call(
    input: Input,
    ctx: ToolContext,
    onProgress?: (p: ToolProgress<Progress>) => void,
  ): Promise<ToolResult<Output>>;

  /** Does this tool only read state? Enables concurrent batching. */
  isReadOnly(input: Input): boolean;

  /** Is this irreversible? Affects default permission behavior. */
  isDestructive?(input: Input): boolean;
}
```

### Why each field exists

| Field | Why it's separate |
|---|---|
| `inputSchema` | Runtime validation + JSON Schema for the LLM |
| `validateInput` | Fast-fail before permission prompt (don't ask the user about a tool call that would fail anyway) |
| `checkPermissions` | The security boundary — one function per tool |
| `call` | Mixing execution with validation/permissions makes testing hell |
| `isReadOnly` | Enables safe parallel batching (see §4) |
| `isDestructive` | In auto mode, destructive tools stay prompt-gated by default |

### Sample tool: `bash`

```typescript
// tools/bash.ts
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Tool } from './types';

const BashInput = z.object({
  command: z.string().min(1).max(10000),
  timeout: z.number().optional().default(30_000),
});

const DESTRUCTIVE_PATTERNS = [/\brm\s+-rf?\s+\//, /\bmkfs\b/, /\bdd\s+if=/];

export const BashTool: Tool<z.infer<typeof BashInput>, { exitCode: number }> = {
  name: 'Bash',
  description: 'Execute a shell command. Returns stdout, stderr, exit code.',
  inputSchema: BashInput,

  isReadOnly: () => false,
  isDestructive: (input) => DESTRUCTIVE_PATTERNS.some(p => p.test(input.command)),

  async validateInput(input) {
    if (input.command.includes('\0')) throw new Error('null bytes not allowed');
  },

  async checkPermissions(input, ctx) {
    if (ctx.mode === 'bypass') return { behavior: 'allow' };
    if (ctx.mode === 'plan') return { behavior: 'deny', message: 'Bash blocked in plan mode' };

    const rule = matchRule(ctx.rules, 'Bash', input.command);
    if (rule === 'allow') return { behavior: 'allow' };
    if (rule === 'deny') return { behavior: 'deny', message: 'Denied by rule' };
    return { behavior: 'ask' };
  },

  async call(input, ctx, onProgress) {
    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', input.command], { cwd: ctx.cwd });
      let stdout = '', stderr = '';

      const heartbeat = setInterval(() => {
        onProgress?.({ type: 'progress', data: { stdout: stdout.slice(-200) } });
      }, 2000);

      proc.stdout.on('data', (d) => stdout += d.toString());
      proc.stderr.on('data', (d) => stderr += d.toString());

      ctx.abortSignal.addEventListener('abort', () => proc.kill('SIGTERM'));

      proc.on('close', (exitCode) => {
        clearInterval(heartbeat);
        resolve({
          content: `exit ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
          data: { exitCode: exitCode ?? -1 },
          isError: exitCode !== 0,
        });
      });
    });
  },
};
```

Key patterns to notice:

- **Permission check uses the context**, never global state. Makes the tool testable.
- **Progress heartbeat every 2s** — matches Claude Code's UX for long-running commands.
- **Abort propagation** — the engine can cancel mid-execution.
- **Result includes both `content` (for the model) and `data` (for the UI)**.

### Registry

```typescript
// tools/registry.ts
import type { Tool } from './types';

export class ToolRegistry {
  private tools = new Map<string, Tool<any, any, any>>();

  register(tool: Tool<any, any, any>) {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<any, any, any> | undefined {
    return this.tools.get(name);
  }

  // Format the LLM expects — Anthropic tool-use shape
  toLLMSchema() {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.inputSchema),
    }));
  }
}
```

---

## 4. Layer 2 — The Agent Loop

The heart of the system. One function drives everything.

```typescript
// engine.ts
import Anthropic from '@anthropic-ai/sdk';

type EngineEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_progress'; id: string; data: unknown }
  | { type: 'tool_result'; id: string; content: string; isError: boolean }
  | { type: 'turn_complete'; usage: Usage }
  | { type: 'error'; message: string };

export async function* runAgent(params: {
  messages: Message[];
  tools: ToolRegistry;
  permissions: PermissionContext;
  llm: Anthropic;
  abortSignal: AbortSignal;
}): AsyncGenerator<EngineEvent> {
  const { messages, tools, permissions, llm, abortSignal } = params;

  // Outer loop: keeps going until the model says "end_turn"
  while (true) {
    const stream = llm.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      messages,
      tools: tools.toLLMSchema(),
    });

    // Stream tokens to the UI
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'assistant_delta', text: event.delta.text };
      }
    }

    const finalMsg = await stream.finalMessage();
    messages.push({ role: 'assistant', content: finalMsg.content });

    // Extract tool_use blocks
    const toolUses = finalMsg.content.filter(b => b.type === 'tool_use');

    if (toolUses.length === 0) {
      yield { type: 'turn_complete', usage: finalMsg.usage };
      return;  // Model is done
    }

    // Partition: read-only tools run concurrently, writes run serially
    const results = await dispatchTools({ toolUses, tools, permissions, abortSignal, emit: (e) => {/* forward */} });

    messages.push({
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError,
      })),
    });
    // Loop back to the LLM with tool results
  }
}
```

### The tool dispatcher — the read/write split

This is the most important detail in the whole engine:

```typescript
async function dispatchTools(params: {
  toolUses: ToolUseBlock[];
  tools: ToolRegistry;
  permissions: PermissionContext;
  abortSignal: AbortSignal;
  emit: (e: EngineEvent) => void;
}): Promise<ToolCallResult[]> {
  const { toolUses, tools, permissions, abortSignal, emit } = params;
  const results: ToolCallResult[] = [];

  // Group consecutive tool uses by read-only-ness
  const batches = groupByReadOnly(toolUses, tools);

  for (const batch of batches) {
    if (batch.readOnly) {
      // Concurrent — up to N in parallel
      const batchResults = await Promise.all(
        batch.uses.map(u => executeOne(u, tools, permissions, abortSignal, emit)),
      );
      results.push(...batchResults);
    } else {
      // Serial — each may mutate state the next one reads
      for (const u of batch.uses) {
        results.push(await executeOne(u, tools, permissions, abortSignal, emit));
      }
    }
  }

  return results;
}

function groupByReadOnly(uses: ToolUseBlock[], tools: ToolRegistry) {
  const batches: { readOnly: boolean; uses: ToolUseBlock[] }[] = [];
  for (const use of uses) {
    const tool = tools.get(use.name)!;
    const ro = tool.isReadOnly(use.input);
    const last = batches[batches.length - 1];
    if (last && last.readOnly === ro) last.uses.push(use);
    else batches.push({ readOnly: ro, uses: [use] });
  }
  return batches;
}
```

**Why this matters**: if the model fires 5 `Read` + 3 `Edit` + 2 `Read` in one response:

- `Read[1..5]` runs in parallel (all read-only).
- `Edit[1..3]` runs serially (each edit may affect the next's preconditions).
- `Read[6..7]` runs in parallel (back to read-only).

This gives you a 5× speedup on typical workloads without sacrificing correctness.

### Executing one tool use

```typescript
async function executeOne(
  use: ToolUseBlock,
  tools: ToolRegistry,
  permissions: PermissionContext,
  abortSignal: AbortSignal,
  emit: (e: EngineEvent) => void,
): Promise<ToolCallResult> {
  const tool = tools.get(use.name);
  if (!tool) return errorResult(use.id, `Unknown tool: ${use.name}`);

  // 1. Schema validation
  const parsed = tool.inputSchema.safeParse(use.input);
  if (!parsed.success) return errorResult(use.id, `Invalid input: ${parsed.error.message}`);

  // 2. Tool-specific validation
  try { await tool.validateInput?.(parsed.data, permissions.ctx); }
  catch (e) { return errorResult(use.id, `Validation: ${(e as Error).message}`); }

  // 3. Permission check — THE choke point
  const decision = await resolvePermission(tool, parsed.data, permissions);
  if (decision.behavior === 'deny') return errorResult(use.id, decision.message);

  // 4. Execute
  try {
    const result = await tool.call(parsed.data, permissions.ctx, (progress) => {
      emit({ type: 'tool_progress', id: use.id, data: progress.data });
    });
    return { id: use.id, content: result.content, isError: !!result.isError };
  } catch (e) {
    return errorResult(use.id, `Execution: ${(e as Error).message}`);
  }
}
```

---

## 5. Layer 3 — The Permission Gate

One function. Every tool call passes through it. No exceptions.

```typescript
// permissions.ts

export type PermissionMode = 'default' | 'plan' | 'bypass' | 'auto';

export type PermissionRules = {
  allow: string[];   // ["Bash(git *)", "Read(*)"]
  deny: string[];    // ["Bash(rm -rf *)"]
  ask: string[];
};

export type PermissionContext = {
  ctx: ToolContext;
  mode: PermissionMode;
  rules: PermissionRules;
  denialCount: number;
  hooks: Hook[];
  onAsk: (tool: string, input: unknown, message?: string) => Promise<'allow' | 'deny'>;
};

export async function resolvePermission<T>(
  tool: Tool<T, unknown, unknown>,
  input: T,
  permissions: PermissionContext,
): Promise<PermissionDecision> {
  // 1. Pre-execution hooks can short-circuit
  for (const hook of permissions.hooks) {
    const hookDecision = await hook.run({ tool: tool.name, input, phase: 'pre' });
    if (hookDecision) return hookDecision;
  }

  // 2. Tool's own checkPermissions
  const toolDecision = await tool.checkPermissions(input, permissions.ctx);

  if (toolDecision.behavior === 'allow') return toolDecision;
  if (toolDecision.behavior === 'deny') return toolDecision;

  // 3. 'ask' — prompt user unless in bypass
  if (permissions.mode === 'bypass') return { behavior: 'allow' };

  const userDecision = await permissions.onAsk(tool.name, input, toolDecision.message);

  if (userDecision === 'deny') {
    permissions.denialCount++;
    return { behavior: 'deny', message: 'User denied' };
  }

  permissions.denialCount = 0;
  return { behavior: 'allow' };
}
```

### Rule matching

```typescript
export function matchRule(rules: PermissionRules, toolName: string, input: string) {
  for (const r of rules.deny) if (ruleMatches(r, toolName, input)) return 'deny';
  for (const r of rules.allow) if (ruleMatches(r, toolName, input)) return 'allow';
  return null;
}

function ruleMatches(rule: string, toolName: string, input: string): boolean {
  const m = rule.match(/^(\w+)\((.*)\)$/);
  if (!m) return false;
  const [, tool, pattern] = m;
  if (tool !== toolName) return false;
  return globToRegex(pattern).test(input);
}
```

### Mode semantics

| Mode | Behavior |
|---|---|
| `default` | Ask user if no rule matches. Safe default. |
| `plan` | Read-only allowed, writes always deny. Model commits to a plan first. |
| `bypass` | Every tool auto-allows. Dangerous. Lock it behind a flag. |
| `auto` | Hooks + classifier decide; after K denials → fall back to prompting |

### The denial escalation trick

Track consecutive denials. After (say) 3 denials in a row, **auto-promote silent-deny to user-prompt** for the next call. Reason: a silently-failing agent confuses users. If the rules are wrong, the system should notice and force a conversation.

---

## 6. Layer 4 — Streaming & Progress

Everything yields. Everything.

### Single event stream

Don't have separate callback APIs for "token delta" vs "tool progress" vs "final result". **One event enum, one generator.** Consumers filter for what they care about.

```typescript
type EngineEvent =
  | { type: 'assistant_delta'; text: string }        // live token stream
  | { type: 'assistant_message'; content: Block[] }  // complete turn
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_progress'; id: string; data: unknown }
  | { type: 'tool_result'; id: string; content: string; isError: boolean }
  | { type: 'permission_prompt'; tool: string; input: unknown }
  | { type: 'turn_complete'; usage: Usage }
  | { type: 'error'; message: string };
```

### Why generators beat callbacks

```typescript
// CLI consumer
for await (const event of runAgent(...)) {
  switch (event.type) {
    case 'assistant_delta': process.stdout.write(event.text); break;
    case 'tool_use': renderToolCallUI(event); break;
    case 'tool_progress': updateSpinner(event); break;
  }
}

// SDK consumer
const events: EngineEvent[] = [];
for await (const event of runAgent(...)) events.push(event);
return events;

// Web consumer (SSE)
for await (const event of runAgent(...)) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
```

Same engine. Three renderers. Zero code duplication.

### Cancellation

Pass an `AbortSignal` into the engine. The engine passes it into every tool. Tools propagate it to subprocesses, HTTP requests, file reads. Ctrl+C in the REPL triggers `controller.abort()` — everything unwinds cleanly.

---

## 7. Layer 5 — State & Message Types

Don't use bare `{ role, content }` messages. You need more types than you think.

```typescript
type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemLocalCommandMessage   // injected by /commands, NOT sent to the API
  | TombstoneMessage             // deleted, rendered as "---"
  | CompactBoundaryMessage;      // marks a compaction seam
```

### Why so many types?

- **`SystemLocalCommandMessage`** — when the user types `/cost`, you show them a panel. That's visible in scrollback but must never reach the LLM or you'll confuse it.
- **`TombstoneMessage`** — user deleted a message. The UI needs to show *something* or later messages lose their ordering.
- **`CompactBoundaryMessage`** — marks where a compaction summary took over from raw history. Resume logic needs to know.

### Immutable state

Every mutation returns a new root object:

```typescript
type AppState = Readonly<{
  messages: readonly Message[];
  toolPermissionContext: Readonly<PermissionContext>;
  sessionId: string;
  usage: Readonly<Usage>;
  // ...
}>;

function pushMessage(state: AppState, msg: Message): AppState {
  return { ...state, messages: [...state.messages, msg] };
}
```

Pays off in three ways:
- Cheap React memoization (reference equality).
- Easy undo (keep the last N states).
- No "who mutated my messages?" debugging at 2am.

---

## 8. Layer 6 — Commands

Commands are the **user's** extension surface. Tools are the **model's**. Keep them separate.

```typescript
type CommandContext = {
  state: AppState;
  args: string;
};

type CommandResult = {
  injectMessages?: Message[];     // added to conversation
  renderUI?: JSX.Element;          // shown inline, not sent to LLM
  shouldContinueQuery?: boolean;   // false = don't call the LLM this turn
  stateMutation?: (s: AppState) => AppState;
};

interface Command {
  name: string;
  description: string;
  run(ctx: CommandContext): Promise<CommandResult>;
}
```

### Command dispatch

Slash commands run **synchronously before** the LLM call. Parse the input:

```typescript
function processUserInput(raw: string, state: AppState): {
  messages: Message[];
  shouldQuery: boolean;
  ui?: JSX.Element;
} {
  if (raw.startsWith('/')) {
    const [name, ...rest] = raw.slice(1).split(' ');
    const cmd = commandRegistry.get(name);
    if (cmd) return runCommand(cmd, { state, args: rest.join(' ') });
  }
  return { messages: [{ role: 'user', content: raw }], shouldQuery: true };
}
```

### Example commands worth building first

| Command | Purpose |
|---|---|
| `/cost` | Show token usage for this session |
| `/compact` | Force context compaction now (see §10) |
| `/memory` | Show/edit persistent memory file |
| `/plan` | Toggle plan mode (read-only tools) |
| `/rules` | Show/edit permission rules |
| `/resume` | Load a previous session |
| `/clear` | Reset conversation (with confirmation) |

---

## 9. Layer 7 — Sub-Agents

Your agent can spawn **child agents** as a tool. This is both powerful and how your agent stays sane when delegated work is noisy.

```typescript
// tools/spawnAgent.ts
export const SpawnAgentTool: Tool<SpawnInput, SpawnOutput> = {
  name: 'Agent',
  description: 'Spawn a sub-agent with a focused task. Returns only its final answer.',
  inputSchema: z.object({
    task: z.string(),
    tools: z.array(z.string()).optional(),  // which tools the child may use
    model: z.string().optional(),
  }),
  isReadOnly: () => false,

  async checkPermissions(input, ctx) {
    return ctx.mode === 'bypass' ? { behavior: 'allow' } : { behavior: 'ask' };
  },

  async call(input, ctx, onProgress) {
    const childTools = filterTools(registry, input.tools ?? DEFAULT_SUBAGENT_TOOLS);
    const childState = createChildState(ctx);

    let finalAnswer = '';
    for await (const event of runAgent({
      messages: [{ role: 'user', content: input.task }],
      tools: childTools,
      permissions: childPermissions(ctx),
      llm: ctx.llm,
      abortSignal: ctx.abortSignal,
    })) {
      if (event.type === 'assistant_delta') finalAnswer += event.text;
      // Forward progress to parent
      onProgress?.({ type: 'progress', data: event });
    }

    return {
      content: finalAnswer,
      data: { childSessionId: childState.sessionId },
    };
  },
};
```

### What the parent does and doesn't see

| Visible to parent | Hidden from parent |
|---|---|
| The final `content` string | All intermediate thinking |
| The sub-agent's session ID | All tool uses the child made |
| Any progress events you chose to forward | The child's raw conversation |

This is the trick that makes agents scalable. A one-line "find all uses of X across the repo" can burn 50K tokens invisibly — the parent just sees the answer.

### Rules for sub-agents

1. **Never share mutable state with the parent.** Clone context, pass in read-only views.
2. **Restrict the toolset** — don't let sub-agents spawn sub-agents by default (blow-up risk).
3. **Write a separate transcript** — sub-agent sessions persist independently for debugging.
4. **Forward abort signals** — parent cancel must kill children.

---

## 10. Layer 8 — Context Compaction

Eventually the conversation gets too long for the context window. Here's how to handle it.

### The trick: **compact the API view, keep the disk history full**

```typescript
type Session = {
  fullHistory: Message[];       // what's on disk, what the UI shows
  compactionPoints: {
    atMessageIndex: number;
    summary: string;
  }[];
};

function buildApiMessages(session: Session): Message[] {
  const lastCompact = session.compactionPoints.at(-1);
  if (!lastCompact) return session.fullHistory;

  return [
    { role: 'user', content: `<summary-of-earlier-conversation>\n${lastCompact.summary}\n</summary-of-earlier-conversation>` },
    ...session.fullHistory.slice(lastCompact.atMessageIndex),
  ];
}
```

The user scrolls back and sees everything. The model sees a summary + recent messages. Neither knows the other's view.

### When to trigger

```typescript
function shouldCompact(usage: Usage, budget: number): boolean {
  return usage.inputTokens / budget > 0.90;
}
```

### The summarization call

Make a **separate** LLM call with a specific system prompt:

```
You are compressing a conversation for context. Summarize everything before
the last 5 messages. Preserve:
- Key facts the user has stated
- Open questions / unresolved decisions
- Tool results the user referenced
- The goal the user is working toward

Do not invent details. If in doubt, preserve.
```

### Microcompact vs full compact

- **Microcompact** (cheap, no LLM): dedupe consecutive duplicate messages, strip unused attachments, truncate large tool results. Run every N turns.
- **Full compact** (expensive, LLM-summarized): triggered by token threshold or `/compact`.

---

## 11. Layer 9 — External Tools via MCP

MCP (Model Context Protocol) is how external tools plug in. If you want your agent to be extensible by users without code changes, you want this.

### Loading MCP servers

```typescript
// services/mcp/client.ts
import { spawn } from 'node:child_process';

export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const proc = spawn(config.command, config.args, { env: { ...process.env, ...config.env } });
  const transport = new StdioTransport(proc.stdin, proc.stdout);
  const client = new McpClient(transport);
  await client.initialize();
  return { client, proc };
}

export async function loadMcpTools(conn: McpConnection): Promise<Tool[]> {
  const { tools } = await conn.client.request('tools/list');
  return tools.map(remoteTool => wrapAsTool(remoteTool, conn));
}
```

### Wrapping an MCP tool as a native Tool

```typescript
function wrapAsTool(remote: McpToolDef, conn: McpConnection): Tool {
  return {
    name: `mcp__${conn.serverName}__${remote.name}`,
    description: remote.description,
    inputSchema: jsonSchemaToZod(remote.inputSchema),

    isReadOnly: () => remote.annotations?.readOnlyHint ?? false,

    async checkPermissions(_input, ctx) {
      // Inherit from server-level config; prompt by default
      const rule = matchRule(ctx.rules, `mcp__${conn.serverName}`, '*');
      return rule === 'allow' ? { behavior: 'allow' } : { behavior: 'ask' };
    },

    async call(input, _ctx, onProgress) {
      const result = await conn.client.request('tools/call', {
        name: remote.name,
        arguments: input,
      }, {
        onProgress: (p) => onProgress?.({ type: 'progress', data: p }),
      });
      return { content: textOf(result), isError: result.isError };
    },
  };
}
```

### The benefit

Your users write no code. They add a line to `~/.youragent/mcp.json`:

```json
{
  "servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

And now the agent has GitHub tools. This is the **plugin story**. Build this before you try to ship your own plugin system.

---

## 12. Layer 10 — Persistence

Three separate concerns. Don't conflate them.

### Session history (verbatim conversation log)

- **Where**: `~/.youragent/sessions/<session-id>.jsonl` — one message per line.
- **When written**: fire-and-forget after each message. Never block the engine.
- **When read**: on `/resume`, lazy-load the file, parse back into state.
- **Schema**: the full `Message` union, preserving all metadata (tool IDs, timestamps, usage).

```typescript
async function appendToTranscript(sessionId: string, msg: Message) {
  const path = `${sessionsDir()}/${sessionId}.jsonl`;
  await fs.appendFile(path, JSON.stringify(msg) + '\n').catch(logErr);
}
```

### Memory (facts to remember across sessions)

- **Where**: `~/.youragent/MEMORY.md` (global) + `./MEMORY.md` (project-scoped).
- **When read**: injected into the system prompt at session start.
- **When written**: when the user says "remember X", or periodically via an extractor.
- **Compaction**: LLM-summarize when > 50KB.

Memory is **curated** state. Don't just dump every session's facts into it — that creates unusable bloat. Prompt the user (or an extraction pass) to decide what's worth keeping.

### Config (user preferences)

- **Where**: `~/.youragent/config.json`.
- **What**: model preferences, permission rules, registered MCP servers, keybindings.
- **Schema-validate on load** (Zod). Migrate old schemas forward.

---

## 13. Layer 11 — The UI Layer

You have three realistic options:

### Option A: Plain readline + chalk (fastest to build)

```typescript
import readline from 'node:readline';
import chalk from 'chalk';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', async (line) => {
  for await (const event of runAgent({ messages: [...], /* ... */ })) {
    switch (event.type) {
      case 'assistant_delta': process.stdout.write(event.text); break;
      case 'tool_use':
        console.log(chalk.cyan(`\n→ ${event.name}(${JSON.stringify(event.input)})`));
        break;
      case 'tool_result':
        console.log(chalk.gray(event.content.slice(0, 200)));
        break;
    }
  }
  rl.prompt();
});
```

**~200 lines total. Ship this first.** It's the shortest path to "this thing actually works."

### Option B: Ink (React for terminals)

When plain text isn't enough — you want scrollable panes, permission modals that interrupt the flow, progress indicators, typeahead completion — switch to [Ink](https://github.com/vadimdemedes/ink). Don't write your own like Claude Code did; use the public package.

```tsx
const App = () => {
  const { messages, sendInput } = useAgent();

  return (
    <Box flexDirection="column">
      <MessageList messages={messages} />
      <PermissionModal />
      <InputBar onSubmit={sendInput} />
    </Box>
  );
};
```

### Option C: Web UI

The streaming-first design pays off here. Your engine emits SSE-compatible events; your React frontend consumes them.

### Don't build all three at once

Pick A. Ship it. Let users suffer. Then when you understand what they actually need, build B or C. Doing two in parallel doubles your work *and* you design both wrong because you don't yet know what users want.

---

## 14. Layer 12 — Observability

You will regret not having this from day one.

### Minimum viable telemetry

```typescript
type AgentEvent = {
  sessionId: string;
  timestamp: number;
  kind: 'tool_call' | 'llm_call' | 'permission_decision' | 'error';
  data: Record<string, unknown>;
};

// Write to ~/.youragent/events.jsonl
// Always opt-in. Never send off-machine without explicit consent.
```

### What to log

- Every tool call: name, input (sanitized), duration, outcome.
- Every LLM call: model, input/output tokens, latency.
- Every permission decision: tool, decision, reason.
- Every error: stack, context, recovery action.

### What **not** to log

- Full input contents by default (PII risk).
- File contents.
- Environment variables.

### A single-file debugger

```bash
tail -f ~/.youragent/events.jsonl | jq 'select(.kind == "tool_call")'
```

That one line is worth more than any dashboard until you have 10+ users.

---

## 15. Putting It Together

### Full scaffold structure

```
my-agent/
├── src/
│   ├── main.ts                 # CLI entry, REPL loop
│   ├── engine.ts               # The agent loop
│   ├── dispatcher.ts           # Tool batching/execution
│   ├── permissions.ts          # Permission gate + rules
│   ├── state.ts                # AppState + reducers
│   ├── llm.ts                  # Anthropic SDK wrapper
│   │
│   ├── tools/
│   │   ├── types.ts            # Tool interface
│   │   ├── registry.ts
│   │   ├── bash.ts
│   │   ├── read.ts
│   │   ├── edit.ts
│   │   ├── glob.ts
│   │   ├── grep.ts
│   │   ├── spawnAgent.ts       # Sub-agents
│   │   └── mcp.ts              # MCP wrapper
│   │
│   ├── commands/
│   │   ├── registry.ts
│   │   ├── cost.ts
│   │   ├── compact.ts
│   │   ├── memory.ts
│   │   ├── plan.ts
│   │   ├── rules.ts
│   │   └── resume.ts
│   │
│   ├── services/
│   │   ├── mcp/                # MCP client, discovery
│   │   ├── history.ts          # Session persistence
│   │   ├── memory.ts           # Memory read/write/compact
│   │   ├── compaction.ts       # Context compaction
│   │   └── telemetry.ts
│   │
│   ├── ui/                     # Ink components (phase 2)
│   └── hooks/                  # Pre/post-tool-use hooks
│
├── package.json
└── tsconfig.json
```

### The main.ts sketch

```typescript
#!/usr/bin/env node
import { program } from 'commander';
import { startRepl } from './ui/repl';
import { loadConfig } from './services/config';
import { buildRegistry } from './tools/registry';
import { connectAllMcpServers } from './services/mcp';

program
  .option('-p, --prompt <text>', 'one-shot prompt, no REPL')
  .option('--mode <mode>', 'permission mode', 'default')
  .action(async (opts) => {
    const config = await loadConfig();
    const tools = buildRegistry();
    const mcpConns = await connectAllMcpServers(config.mcp);
    for (const conn of mcpConns) {
      for (const t of await loadMcpTools(conn)) tools.register(t);
    }

    if (opts.prompt) {
      await runOneShot(opts.prompt, { tools, config, mode: opts.mode });
    } else {
      await startRepl({ tools, config, mode: opts.mode });
    }
  });

program.parse();
```

---

## 16. Build Order & Milestones

Don't try to build everything at once. This ordering minimizes rework:

### Milestone 0: "Hello, tool call" (1–2 days)

- Engine with the LLM loop.
- One tool: `Bash`.
- No permissions (every call auto-allowed; add a `--yolo` flag to make this explicit).
- Plain `console.log` output.
- **Definition of done**: `agent "run ls and tell me what's here"` works.

### Milestone 1: Safe multi-tool (3–5 days)

- Add `Read`, `Edit`, `Grep`, `Glob`.
- Permission gate with `allow`/`deny`/`ask`.
- Rule file in `~/.youragent/config.json`.
- Read-only / read-write batching.
- **Definition of done**: can fix a bug in a small TypeScript project end-to-end.

### Milestone 2: Real REPL (3–5 days)

- Switch to Ink.
- Streaming tokens, live tool progress.
- Permission prompt modal (not blocking on stdin).
- Ctrl+C cancellation.
- **Definition of done**: pleasant enough to dogfood for real work.

### Milestone 3: Persistence (2–3 days)

- Session history on disk.
- `/resume` command.
- Memory file.
- **Definition of done**: you can quit mid-conversation and pick up tomorrow.

### Milestone 4: Sub-agents (2–3 days)

- `SpawnAgent` tool.
- Isolated context per child.
- Abort signal propagation.
- **Definition of done**: "search the codebase for X using a sub-agent" works and saves parent context.

### Milestone 5: Slash commands (2–3 days)

- `/cost`, `/compact`, `/memory`, `/rules`.
- Command registry + dispatcher.
- **Definition of done**: users never have to hand-edit config files.

### Milestone 6: Context compaction (3–4 days)

- Auto-compact at 90% of budget.
- `/compact` manual trigger.
- Snip projection (UI shows full, API sees compact).
- **Definition of done**: 4-hour session without hitting token limits.

### Milestone 7: MCP (3–5 days)

- MCP client (stdio transport first).
- Tool discovery and wrapping.
- Config-driven server registration.
- **Definition of done**: can add a third-party tool server without touching your codebase.

### Milestone 8: Polish (ongoing)

- Telemetry.
- Hooks system.
- Better error recovery.
- Plan mode.
- Team/shared memory if needed.

**Total to a real product: ~6–8 weeks of focused work for one engineer.** If you try to parallelize milestones, you'll redesign 2× and ship in 3×.

---

## 17. Anti-Patterns

Things that seem like a good idea but will bite you.

### ❌ "Just one more bypass, for this special case"

Every bypass of the permission gate is a future security bug. If your hook system can auto-approve, make that a real feature with its own audit trail — not a special-case flag.

### ❌ Mixing validation, permissions, and execution

```typescript
// WRONG — now you can't test permissions without running the command
async function call(input, ctx) {
  if (!input.command) throw new Error('empty');
  if (ctx.mode !== 'bypass' && !await userApproved(input)) throw new Error('denied');
  return exec(input.command);
}
```

Three separate methods. Every time. No exceptions.

### ❌ Callbacks instead of generators

```typescript
// WRONG — you'll write this API three times
runAgent({
  onToken: t => ...,
  onToolCall: c => ...,
  onProgress: p => ...,
  onComplete: () => ...,
});
```

Use a generator. One pipe. Filter downstream.

### ❌ Storing messages mutably

Every bug involving "wait why did this message change?" comes from mutable state. Go immutable from day one. It's 5% more code and eliminates an entire bug category.

### ❌ Designing for a future UI before the current one works

Don't build abstraction layers "so we can swap in a web UI later." Build the CLI until it's good. The streaming-events design already gives you swap-ability for free.

### ❌ Building your own MCP-alike before trying MCP

If MCP exists and fits, use it. Your users already know it. Your tools already work with it. Rewriting it is free entropy.

### ❌ Logging everything unsanitized

One leaked token in a telemetry log is one too many. Decide up-front what's loggable and enforce it at the logging boundary, not per-callsite.

### ❌ Adding features that aren't gated

Feature-flag the optional stuff from the start, even if you don't have a flag system yet — just a boolean constant. Future-you will thank present-you when you want to disable half the codebase for a minimal build.

### ❌ Optimizing before measuring

The startup-profiler / parallel-prefetch tricks in Claude Code exist because someone measured 200ms startup and decided that mattered. Don't preemptively do this. Build the thing, measure the thing, then optimize.

---

## Closing Thought

An agent is not a framework problem. It's a **protocol** problem. The LLM speaks a protocol ("here's my response, which may contain tool_use blocks"). Your tools speak a protocol ("here's how to call me, here's what I need, here's what I return"). Your UI speaks a protocol ("here are the events, render them however you want").

Once those three protocols are clean, **the code writes itself**. Everything else — MCP, sub-agents, compaction, memory, the IDE bridge — is a new protocol layered cleanly on top of the core three.

The hard part isn't the code. It's the discipline to keep the boundaries sharp while shipping features. Every time you're tempted to smear a responsibility across two layers for convenience, you're borrowing against future sanity. Most weeks, resist. Some weeks, do it and mark the debt. Ship the thing.

Good luck.

# Engine Loop — Design Doc

**Status:** Draft for review. Scoped to Phase 1 (§5 of `SPEC_AND_PLAN.md`).
**Owner:** TBD.
**Last updated:** 2026-04-15.

The engine loop is the inner heart of the Declaragent runtime: the thing that takes a user message plus conversation state, drives an LLM turn, dispatches tool calls through the permission gate, folds results back in, and decides whether to stop or keep going. Everything else in Phase 1 (REPL, sessions, sub-agents, slash commands) is a shell around this.

This document defines the contract, the state machine, error semantics, and the extension points the loop must expose so Phase 2 (hooks, MCP, skills) and Phase 3 (events, dispatcher) can plug in without rewriting it.

---

## 1. Goals and non-goals

**Goals.**
- Deterministic, observable turn loop that survives LLM errors, tool errors, and cancellation without leaving the session in a half-written state.
- Single `Tool` contract used by built-in tools, MCP-wrapped tools (Phase 2), and plugin-contributed tools (Phase 2).
- Permission gate is a hard wall: tool execution is literally unreachable except through it.
- Extension points (pre/post-tool, pre/post-turn, pre-compact) defined now as no-op seams so Phase 2 wiring is additive, not invasive.
- Sub-agent recursion works through the same loop (`runAgent` is reentrant), with a depth cap enforced in the core.

**Non-goals (Phase 1).**
- Context compaction *strategy* (pluggable interface only — a stub `trim-oldest` impl is enough).
- MCP tool sourcing (contract must accommodate it; implementation is Phase 2).
- Multi-provider LLMs (Anthropic only at v0.1; provider is behind an interface but only one impl ships).
- Event-driven entrypoints (Phase 3).
- Cost caps and budgets (Phase 6); Phase 1 only needs token accounting plumbed through.

---

## 2. Conceptual model

A **turn** is one user-input-to-model-stop cycle. Inside a turn the loop may invoke any number of tool calls; each tool call is its own round-trip to the model. A **session** is an ordered sequence of turns sharing a transcript and token ledger.

```
User message ──┐
               ▼
         ┌──────────┐        ┌──────────┐       ┌──────────┐
         │  Append  │───▶    │   Call   │───▶   │  Parse   │
         │ to trans │        │   LLM    │       │ response │
         └──────────┘        └──────────┘       └──────────┘
                                                       │
                        ┌──────────────────────────────┤
                        ▼                              ▼
                 (stop reason:                 (stop reason:
                  end_turn / max_tokens)       tool_use)
                        │                              │
                        ▼                              ▼
                     Emit to                  For each tool_use block:
                     caller                     ├─ permission gate
                                                ├─ execute (or return denial)
                                                └─ append tool_result
                                                       │
                                                       └──▶ back to "Call LLM"
```

The loop terminates when the model returns a non-`tool_use` stop reason, when a hard error is raised, or when the turn hits a safety cap (max iterations, cost ceiling, cancellation).

---

## 3. Core types

These live in `@declaragent/core/src/types/` and are the load-bearing contracts. Exact field names are proposals — bikeshed welcome.

```ts
// Transcript primitives
type Role = 'user' | 'assistant' | 'system' | 'tool';

type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

interface Message {
  role: Role;
  content: MessageContent[];
  // Opaque per-provider metadata (usage, model, stop reason) kept in provider-normalized form:
  meta?: MessageMeta;
}

interface MessageMeta {
  model?: string;
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
}

// Tool contract
interface Tool<I = unknown, O = unknown> {
  name: string;                     // Unique within a registry scope; MCP tools get a `mcp__server__` prefix.
  description: string;              // Shown to the model.
  inputSchema: JSONSchema7;         // Validated before permission check.
  readonly?: boolean;               // Hint for `plan` mode.
  permissionKey(input: I): string;  // e.g. Bash → "Bash:<cmd>", Read → "Read:<path>". Used for glob rules.
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent<O>>;
}

type ToolEvent<O> =
  | { type: 'progress'; message: string }
  | { type: 'result'; output: O }
  | { type: 'error'; error: ToolError };

interface ToolContext {
  session: SessionHandle;
  permissions: PermissionGate;
  abortSignal: AbortSignal;
  depth: number;            // Sub-agent depth; 0 for top-level.
  runAgent: RunAgent;       // For the Agent tool to recurse through the loop.
  logger: Logger;
}

// Permission
type PermissionMode = 'default' | 'plan' | 'bypass' | 'auto';

interface PermissionRule {
  pattern: string;          // Glob: "Bash:git *", "Read:/tmp/**". Never regex.
  decision: 'allow' | 'deny';
}

interface PermissionDecision {
  outcome: 'allow' | 'deny' | 'prompt';
  matchedRule?: PermissionRule;
  reason?: string;
}

interface PermissionGate {
  check(toolName: string, key: string): Promise<PermissionDecision>;
  recordDenial(toolName: string): void;     // Feeds 3-denial escalation.
  denialsInSession(): number;
}

// The loop's public surface
interface RunAgentInput {
  session: SessionHandle;
  userMessage: string;
  abortSignal?: AbortSignal;
  depth?: number;
}

interface RunAgentResult {
  stopReason: 'end_turn' | 'max_iterations' | 'aborted' | 'error' | 'permission_escalated';
  usage: { inputTokens: number; outputTokens: number };
  lastAssistantMessage?: Message;
  error?: Error;
}

type RunAgent = (input: RunAgentInput) => Promise<RunAgentResult>;
```

A few deliberate choices worth calling out:

- **`permissionKey` lives on the tool, not the loop.** The loop doesn't know that `Bash`'s rule space is keyed on the command string while `Read`'s is keyed on the path. Each tool owns that mapping.
- **`execute` is an async iterable.** Streaming progress (for Bash output, long Grep runs, sub-agent transcripts) is native, not bolted on. Tools that don't stream yield one `result` event and finish.
- **`ToolEvent` uses `error` as a distinct variant**, not a thrown exception. Thrown exceptions are reserved for programmer errors (schema validation failure, infrastructure errors); domain errors (command exited non-zero, file not found) are `{ type: 'error' }` events the model can see and recover from.

---

## 4. Loop state machine

The loop is an explicit state machine so pause/resume, cancellation, and testability are clean. States:

| State | Meaning | Transitions |
|---|---|---|
| `Idle` | No turn in progress. | → `Thinking` on `runAgent()` call. |
| `Thinking` | Awaiting LLM response. | → `Streaming` (on first chunk) or `Error`. |
| `Streaming` | Receiving tokens. | → `Dispatching` (tool_use stop) or `Terminal` (end_turn/max_tokens). |
| `Dispatching` | One or more pending tool calls. | → `Executing` per call. |
| `Executing` | A tool is running (permission already granted). | → `Dispatching` (more calls queued) or `Thinking` (all results appended). |
| `AwaitingPermission` | Permission gate is prompting the user. | → `Executing` (allow), `Dispatching` (deny — records denial, synthesizes `tool_result`), or `Aborted`. |
| `Terminal` | Turn complete. | → `Idle`. |
| `Aborted` | Cancelled via `AbortSignal`, escalation, or cap. | → `Idle`. |
| `Error` | Unrecoverable. | → `Idle`. |

**Parallel tool calls.** Anthropic can return multiple `tool_use` blocks in one response. The loop permission-checks and executes them sequentially by default. Parallelism is Phase 2+ (guarded by a tool `parallelSafe?: boolean` hint, defaulting to false).

**Iteration cap.** `maxIterations` (default 50) bounds the number of LLM ↔ tool round-trips in one turn. Exceeding it returns `stopReason: 'max_iterations'`. Prevents runaway loops from cost/time blowups.

---

## 5. Sub-agents

The `Agent` built-in tool calls `ctx.runAgent(...)` with:
- `depth = ctx.depth + 1`
- A freshly created `SessionHandle` (new session ID, new transcript, shares storage backend)
- The same permission gate? **No** — sub-agents get a scoped gate: inherits deny rules, may narrow but never widen allow rules. (`PermissionGate.scope({ allowSubset })`.)

**Depth cap.** `§6.4` of `SPEC_AND_PLAN.md`: default 2, max 4, enforced in core. `runAgent` checks `depth` against `session.spec.subagentDepthCap` and returns a synthetic error tool_result if exceeded. The parent model sees the error and can adapt; there's no exception thrown.

**Result flow.** The sub-agent's `lastAssistantMessage` becomes the `tool_result` content for the parent's `Agent` tool call. Progress events from the sub-agent are forwarded via the parent's `ToolContext.logger` so the REPL can render a nested view.

---

## 6. Error model

Four error classes. Only one of them aborts the turn.

| Class | Source | Handling |
|---|---|---|
| **Tool domain error** | `execute` yields `{ type: 'error' }`. | Appended as `tool_result` with `isError: true`. Model sees it, continues. |
| **Permission denial** | Gate returns `deny` or user denies prompt. | Synthetic `tool_result` with `isError: true` and a human-readable explanation. Denial counter increments; at 3 the turn aborts with `permission_escalated`. |
| **LLM transient error** | 429, 5xx, network blip. | Exponential backoff + jitter, max 5 retries, cap at 30s between. After cap: `stopReason: 'error'`. |
| **LLM fatal error** | 4xx (not 429), schema violation, context overflow. | No retry. Transcript preserved. `stopReason: 'error'`. |

**Context overflow** (`413`, `context_length_exceeded`) is a special case: the loop invokes the registered compaction strategy once, retries the request, and only fails hard if compaction can't fit the transcript. Phase 1 ships a stub strategy that trims the oldest non-system messages until it fits; pluggable interface is defined for Phase 2+.

**Partial writes.** Any state mutation that happens during a failed turn (tool side effects, session transcript appends) is not rolled back — that's not tractable in general. Instead, the session is left in a consistent state: the last appended assistant message is the one the model actually produced, and failed turns are marked with `turn.status = 'error'` in the transcript so `/resume` can show them distinctly.

---

## 7. Cancellation

Every `runAgent` call takes an `AbortSignal`. Cancellation is cooperative:
- LLM call: passed to the Anthropic SDK's abort mechanism.
- Tool execution: passed to `ToolContext.abortSignal`. Tools must poll or register a listener (`Bash` kills the child process; `Read` aborts before the next chunk).
- In `AwaitingPermission`: the prompt is dismissed and the turn aborts.

A cancelled turn yields `stopReason: 'aborted'` and the transcript is truncated to the last *complete* LLM response — no dangling `tool_use` without a matching `tool_result`. This invariant is important for `/resume`: the resumed session must satisfy Anthropic's message format rules.

---

## 8. Extension seams

Exposed in Phase 1 as no-op registries so Phase 2 adds hooks without touching the loop body.

```ts
interface LoopHooks {
  onTurnStart?: (ctx: TurnContext) => void | Promise<void>;
  onTurnEnd?: (ctx: TurnContext, result: RunAgentResult) => void | Promise<void>;
  onToolCallBefore?: (call: PendingToolCall) => void | Promise<void | ToolCallOverride>;
  onToolCallAfter?: (call: CompletedToolCall) => void | Promise<void>;
  onCompactBefore?: (transcript: Message[]) => void | Promise<void>;
}
```

`ToolCallOverride` lets a future hook short-circuit a call (return a synthesized result) — needed for Phase 2's compliance intercept hook. In Phase 1 the hook array is empty and the override path is tested with a single synthetic hook in unit tests.

---

## 9. Observability

Phase 1 ships structured JSON logs through a `Logger` interface; OTel comes in Phase 6. The loop emits:

| Event | Fields |
|---|---|
| `turn.start` | `sessionId`, `turnId`, `depth`, `model` |
| `llm.request` | `turnId`, `iteration`, `inputTokens` (estimate) |
| `llm.response` | `turnId`, `iteration`, `stopReason`, `usage` |
| `tool.permission` | `turnId`, `toolName`, `key`, `outcome`, `ruleMatched?` |
| `tool.start` / `tool.end` | `turnId`, `toolName`, `durationMs`, `isError` |
| `turn.end` | `turnId`, `stopReason`, `totalUsage` |

Every event carries a `correlationId` (the `turnId` at top level, sub-agent turns carry their parent's via `causedBy`). This is the scaffolding Phase 3's correlation chain plugs into.

---

## 10. Concurrency model

A single `SessionHandle` serializes turns: `runAgent` takes an internal per-session mutex. Concurrent `runAgent` calls on the same session queue. Different sessions run independently. This matches the plan's Phase 3 routing rule ("a session is pinned to one replica for its lifetime") and avoids interleaved transcript writes.

Tool executions within a turn are sequential in Phase 1 (see §4). Sub-agents run on the same thread/event-loop as the parent and inherit its cancellation.

---

## 11. Token accounting

Every LLM response carries `usage`. The loop maintains a running `SessionLedger`:

```ts
interface SessionLedger {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  turns: number;
  estimatedCostUSD: number;   // From static model → price map; Phase 6 replaces with live data.
}
```

Exposed via `session.ledger()` and consumed by the `/cost` slash command. No enforcement in Phase 1 — just measurement. Phase 6 wires `dailyTokenUSD` caps.

---

## 12. Persistence boundary

The loop does not touch disk directly. It writes through `SessionHandle`:

```ts
interface SessionHandle {
  id: string;
  spec: AgentSpec;
  transcript: ReadonlyArray<Message>;
  appendMessage(m: Message): Promise<void>;
  ledger(): SessionLedger;
}
```

The default impl in Phase 1 wraps `bun:sqlite` with a WAL-backed table. Appends are atomic (single `INSERT` per message). `/resume` rehydrates by replaying the transcript rows in order; no snapshots in Phase 1 (added in Phase 3 if replay time becomes a problem).

`appendMessage` is `await`ed inside the loop — blocking a sub-millisecond SQLite write is acceptable and keeps "transcript matches what was sent to the model" trivially true.

---

## 13. LLM provider abstraction

One interface, one impl:

```ts
interface LLMProvider {
  stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMStreamChunk>;
  countTokens(messages: Message[]): Promise<number>;
}
```

Only `AnthropicProvider` ships in Phase 1. The request type maps directly onto Anthropic's Messages API (system prompt, messages array, tools array, `tool_choice`). The interface is narrow enough that OpenAI/Gemini impls in a later phase don't force churn in the loop.

**Streaming vs non-streaming.** The loop consumes a stream internally but the initial Phase 1 implementation may buffer the entire response before parsing — streaming-to-UI is a REPL concern, not a loop concern. Tool-call parsing needs the full response block either way.

---

## 14. Testing strategy

Three tiers:

1. **Pure unit tests** — permission gate, glob matcher, state machine transitions (fake provider), iteration cap, depth cap, error classification.
2. **Loop integration tests** — `FakeProvider` that replays canned tool_use sequences drives real tools (`Read`, `Grep`) against a tmpdir fixture. Asserts transcript shape, ledger values, correlation IDs.
3. **End-to-end smoke** — real Anthropic call behind `DECLARAGENT_E2E=1`, gated off CI by default, run nightly. One test: "read this file, grep for X, summarize."

`FakeProvider` is the critical test surface. It needs to be scriptable:

```ts
const provider = new FakeProvider([
  { stopReason: 'tool_use', content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.txt' } }] },
  { stopReason: 'end_turn', content: [{ type: 'text', text: 'Hello' }] },
]);
```

Co-located in `@declaragent/core/src/testing/`.

---

## 15. Open questions (for this doc specifically)

1. **Parallel tool calls — Phase 1 or Phase 2?** Drafted as Phase 2 above. If benchmarks show serial execution dominates latency, pull forward.
2. **Do tools declare a `cost` estimate?** Useful for `/cost` projection. Could defer to Phase 6.
3. **Permission gate scoping for sub-agents.** "Inherit deny, narrow allow" is the drafted rule. Worth a red-team review: does anything in `SPEC_AND_PLAN.md §2.2` require stricter?
4. **Transcript format on disk.** SQLite rows of `{turnId, seq, role, contentJson, meta}` vs. one JSON blob per message. Rows are simpler for `/resume` and easier to migrate.
5. **What exactly is a "turn" for accounting?** User message + all iterations until `end_turn`? Or one iteration = one turn? This affects `/cost` granularity.

---

## 16. What ships in Phase 1 vs. what's stubbed

| Capability | Phase 1 | Deferred |
|---|---|---|
| Streaming LLM loop | ✅ (buffered internally; stream-to-UI Phase 2) | — |
| Tool contract | ✅ | — |
| Built-in tools: Read, Write, Edit, Grep, Glob, Bash, Agent | ✅ | Skill, SendMessage, CronCreate, WebFetch, WebSearch |
| Permission gate (4 modes, glob, 3-denial) | ✅ | — |
| Sub-agents + depth cap | ✅ | — |
| SQLite session persistence + `/resume` | ✅ | Postgres backend (Phase 3) |
| Slash commands (`/cost /compact /memory /clear /plan /rules`) | ✅ | `/resume` wiring, others |
| Context compaction | Stub strategy only | Pluggable strategies (Phase 2) |
| LLM provider abstraction | Anthropic impl | Multi-provider (post-v1.0) |
| Hooks | No-op registry | Live wiring (Phase 2) |
| Streaming UI / Ink REPL | ✅ (as last slice) | — |
| OTel metrics / traces | Structured logs only | Phase 6 |
| Cost caps | Ledger only | Phase 6 |

---

## 17. Next step

If this doc lands, the implementation order is the 8-slice plan already agreed:
types → permission gate → read-only tools → engine loop (non-streaming) → remaining tools → streaming → SQLite + `/resume` → Ink REPL.

Slice 1 (types) is ~1 day and blocks every other slice. Recommend kicking it off as soon as this doc has a round of review.

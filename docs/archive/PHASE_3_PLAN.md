# Phase 3 — Event-Driven Core: Implementation Plan

**Status:** Draft for review. Scoped to Phase 3 of `SPEC_AND_PLAN.md` (Event-Driven Core, target v0.5 public beta).
**Last updated:** 2026-04-16.

Phase 1 made the agent a CLI tool. Phase 2 made it extensible. Phase 3 makes it **a service**. Today the agent only runs when a human types something at the REPL. After Phase 3 it runs in response to cron schedules, GitHub webhooks, file changes, MCP-server notifications, and messages from other agents — and survives a `kill -HUP` without dropping anything.

The **acceptance bar** from `SPEC_AND_PLAN.md §8.Phase 3`:

> An agent in staging receives a live GitHub webhook, runs a skill, posts to Slack — end to end, under 5 seconds p95. Daemon survives `kill -HUP` with zero dropped events verified by correlation IDs.

This doc lays out the architecture, contracts, slice ordering, and known sharp edges so we ship without painting ourselves into a corner.

---

## 1. Goals and non-goals

**Goals.**
- One unified event spine (`EventBus`) that everything publishes to and subscribes from — sources, dispatchers, hook subscribers, history.
- A routing layer (`EventDispatcher`) that decides what an event *does*: inject into an existing session, spawn a new one, run a skill, broadcast.
- An `EventSourceAdapter` contract that lets new sources slot in through the Phase-2 `ExtensionRegistry` (`Extension<'event-source'>`) — built-ins ship with cron, webhook, and file watcher.
- A mailbox primitive so agents can message each other and so events arriving for an idle agent aren't lost.
- A daemon mode with a control socket and HTTP control plane: `status`, `reload`, `shutdown`, `drain`. Graceful shutdown and SIGHUP hot reload that preserves in-flight events.
- Persistent event history (SQLite, alongside the existing session DB) so we can replay, dedupe across restarts, and answer "what happened?".

**Non-goals (Phase 3).**
- Production message brokers — Kafka, Kinesis, MQTT, NATS, RabbitMQ, SQS, etc. land in Phase 4 as `EventSourceAdapter` plugins.
- Communication channels — Slack, Discord, Telegram, WhatsApp ingress is Phase 5. Phase 3 *uses* them as outbound HTTP targets in the acceptance demo (a Slack incoming webhook URL), not as bidirectional channels.
- Multi-tenant isolation, secrets vault, RBAC — Phase 6.
- Cluster mode, leader election, distributed dispatcher — Phase 4+.
- A web UI for the control plane — Phase 7. The HTTP control plane in Phase 3 is JSON-only.
- Cron drift compensation across daemon restarts — best-effort first; if a fire was missed, it's missed. (`catchUp: true` is a stretch goal.)

---

## 2. Conceptual architecture

```
                          ┌──────────────────────┐
                          │     EventBus         │
                          │  (the spine)         │
                          └──────────┬───────────┘
        publishes                     │ subscribes
   ┌─────────┬─────────┬───────┐     │     ┌──────────┬──────────┐
   ▼         ▼         ▼       ▼     │     ▼          ▼          ▼
┌──────┐ ┌──────┐ ┌────────┐ ┌────┐  │  ┌──────────┐ ┌────────┐ ┌────┐
│ User │ │ Cron │ │Webhook │ │File│  │  │Dispatcher│ │ Hooks  │ │Hist│
│      │ │      │ │ Server │ │Wat.│  │  │          │ │event.* │ │ ory│
└──────┘ └──────┘ └────────┘ └────┘  │  └─────┬────┘ └────────┘ └────┘
                                     │        │
                                     │        ▼
                                     │   ┌─────────────────────────┐
                                     │   │  Routing decisions       │
                                     │   │  • session              │
                                     │   │  • new-session          │
                                     │   │  • skill                │
                                     │   │  • sub-agent            │
                                     │   │  • broadcast            │
                                     │   └─────┬───────────────────┘
                                     │         │
                                     │         ▼
                                     │   ┌─────────────────────────┐
                                     │   │  Engine.runAgent(...)   │
                                     │   │  + Mailbox.drainFor(id) │
                                     │   └─────────────────────────┘
                                     │
                          ┌──────────┴──────────┐
                          │  Daemon control     │
                          │  socket + HTTP      │
                          │  status/reload/drain│
                          └─────────────────────┘
```

**Single bus.** Every event flows through one `EventBus` instance. It is the integration point for hooks (`event.before` / `event.after`), history, dedup, and observability. Sources never call the dispatcher directly; they publish, and the bus fans out to subscribers (one of which is the dispatcher).

**Composition flow at startup (daemon mode):**
1. Built-in event sources are registered as `Extension<'event-source'>` through the existing `ExtensionRegistry`
2. User config (`agent.yaml` or `~/.declaragent/event-sources.json`) lists configured sources with type + per-source config
3. Plugin event sources are activated as part of `loadPlugin` (slice 6 of Phase 2 already handles `Extension<'event-source'>` registration via the generic registry path)
4. The dispatcher subscribes to the bus
5. The history sink subscribes to the bus
6. Each source's `start()` is called; sources begin emitting
7. Mailbox drains any queued messages for the daemon's primary agent
8. Control socket and HTTP control plane bind their listeners

**Phase 2 contracts are unchanged.** Tools, skills, MCP, hooks, plugins all keep their slice-2 surface. Phase 3 *adds* `event-source` as a new `ExtensionKind` and adds `event.before` / `event.after` to the hook registry — both are forward-declared in Phase 2 (`ExtensionPayloads.command` style) so the upgrade is additive.

---

## 3. Core contracts

These live in `@declaragent/core/src/events/types.ts` and are added in slice 1.

```ts
export type EventKind =
  | 'user.input'
  | 'trigger.fire'
  | 'webhook.received'
  | 'file.changed'
  | 'mcp.notification'
  | 'mailbox.message'
  | 'self.wakeup'
  | 'self.retry';

export type EventSourceTag =
  | { type: 'user'; sessionId: string }
  | { type: 'cron'; triggerId: string; schedule: string }
  | { type: 'webhook'; triggerId: string; remoteAddr?: string }
  | { type: 'file-watch'; path: string; change: 'add' | 'modify' | 'delete' }
  | { type: 'mcp-notification'; server: string; method: string }
  | { type: 'mailbox'; fromAgent: string }
  | { type: 'self'; reason: 'wakeup' | 'retry' | 'loop' }
  | { type: 'sub-agent'; parentSessionId: string; childId: string };

export type EventTarget =
  | { type: 'session'; sessionId: string; mode: 'inject' | 'replace' | 'queue' }
  | { type: 'new-session'; agentSpec?: Partial<AgentSpec>; initialPrompt: string }
  | { type: 'skill'; name: string; inputs: Record<string, unknown> }
  | { type: 'sub-agent'; parentSessionId: string; spec: Partial<AgentSpec> }
  | { type: 'broadcast' };

export type EventAuth =
  | { kind: 'local-user' }
  | { kind: 'trigger'; triggerId: string }
  | { kind: 'bearer'; tokenHash: string }
  | { kind: 'hmac'; signatureHash: string }
  | { kind: 'internal' };

export interface AgentEvent<P = unknown> {
  /** UUID. Used for dedup + correlation. */
  id: string;
  source: EventSourceTag;
  target: EventTarget;
  kind: EventKind;
  timestamp: number;
  payload: P;
  auth: EventAuth;
  meta?: {
    /** Trace id; preserved across child sessions and re-routed events. */
    correlationId?: string;
    /** The event that produced this one; enforced loop-breaker. */
    causedBy?: string;
    /** Application-supplied idempotency key (e.g. `X-GitHub-Delivery`). */
    idempotencyKey?: string;
    /** 0 = highest, no upper bound. Defaults to 100. */
    priority?: number;
  };
}
```

**`EventBus`** (slice 1):

```ts
export type EventHandler = (event: AgentEvent) => void | Promise<void>;

export interface EventBus {
  /** Fan out to every matching subscriber. Returns once all complete (Promise.allSettled — one slow sub doesn't block). */
  publish(event: AgentEvent): Promise<void>;
  /** Subscribe to a `kind` or `'*'` for everything. Returns unsubscribe. */
  subscribe(kind: EventKind | '*', handler: EventHandler): () => void;
  /** In-memory ring buffer (last N events). For `/events` slash + dedup. */
  recent(filter?: (e: AgentEvent) => boolean): readonly AgentEvent[];
  /** Resolves once all in-flight publishes settle. Used by graceful shutdown. */
  drained(): Promise<void>;
}
```

**Delivery semantics.** At-least-once, **unordered across sources**. Per-source ordering is the source's responsibility (cron is naturally serial, file-watcher debounces, webhook batches by `idempotencyKey`). Subscribers must be idempotent. The dispatcher uses a 10-minute in-memory cache keyed on `event.id` and `meta.idempotencyKey`; survives in-process duplicates, not restarts (slice 8 adds the persistence backing for cross-restart dedup).

**`EventDispatcher`** (slice 2):

```ts
export interface EventDispatcher {
  /** Subscribe `dispatcher.handle` to the bus on every relevant kind. */
  attach(bus: EventBus): () => void;
  /** Resolve the event's `target` and execute. Idempotent for any event whose id we've seen recently. */
  handle(event: AgentEvent): Promise<DispatchOutcome>;
}

export type DispatchOutcome =
  | { kind: 'dispatched'; sessionId: string; turnId?: string }
  | { kind: 'queued'; reason: 'session-busy' | 'session-not-active' }
  | { kind: 'duplicate'; firstSeenAt: number }
  | { kind: 'rejected'; reason: 'rate-limit' | 'unauthorized' | 'no-handler' };
```

**Routing rules:**
- `target: session` → `inject` appends a user message to the existing turn; `replace` aborts the current turn and starts fresh; `queue` waits for the session to be idle. The session must already exist or it's `rejected: no-handler`.
- `target: new-session` → constructs a fresh `SessionHandle` from `agentSpec` (or daemon defaults), runs `engine.runAgent({ session, userMessage: initialPrompt, causedBy: event.id })`.
- `target: skill` → resolves via the existing `runSkill(name, opts)` from Phase 2's skills runner; sub-agent depth = 1.
- `target: sub-agent` → spawns a child of `parentSessionId` (uses the same `createChildSession` factory the engine already accepts).
- `target: broadcast` → no-op (event is for observers; the bus already delivered it).

**Event-to-message framing.** The model needs to know "this isn't user input." We wrap the payload in a tagged block before passing to the engine:

```
<event source="webhook" trigger="gh-pr" id="evt_abc" caused-by="...">
  <payload>{...JSON...}</payload>
</event>
```

The framing happens inside the dispatcher, not in the engine — keeps the engine ignorant of event semantics.

**`EventSourceAdapter`** (slice 3):

```ts
export interface EventSourceAdapter {
  readonly type: string;                // "cron" | "webhook" | "file-watch" | <plugin-supplied>
  validateConfig(config: unknown): asserts config is SourceConfig;
  create(
    config: SourceConfig,
    deps: SourceDependencies,
  ): Promise<EventSourceInstance>;
}

export interface SourceDependencies {
  bus: EventBus;
  logger: Logger;
  configDir: string;
}

export interface EventSourceInstance {
  readonly id: string;
  readonly type: string;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  health(): Promise<{ status: 'ok' | 'degraded' | 'failed'; details?: unknown }>;
  metrics(): { eventsPublished: number; lastEventAt: number | null };
}
```

Sources are wrapped as `Extension<'event-source'>` (descriptor `id: 'event-source:<type>:<id>'`); the registry's standard `activate` path calls `start()`. Hot reload (slice 10) calls `stop()` then `create()` again.

---

## 4. Built-in source details

### 4.1 Cron (slice 4)

- Backed by the `cron` npm package (~10KB, no deps; same one most node cron tools use).
- Schedule: standard 5-field cron string (`"0 9 * * 1-5"`) **or** ISO-8601 duration (`"PT5M"` for "every 5 minutes").
- Timezone: per-trigger string (`"America/Los_Angeles"`); defaults to system tz.
- **Drift handling.** If the daemon was down at the scheduled time, the fire is missed. `catchUp: true` per-trigger is a Phase-3.x stretch — if added, fires once on startup if the last-fire timestamp (persisted in slice 8) is older than the expected cadence.
- Emitted event: `kind: 'trigger.fire'`, `source: { type: 'cron', triggerId, schedule }`, `target` from trigger config (typically `skill`), `auth: { kind: 'trigger', triggerId }`.

Trigger config (in `~/.declaragent/event-sources.json` or `agent.yaml`):

```yaml
- id: morning-summary
  type: cron
  schedule: "0 9 * * 1-5"
  timezone: America/Los_Angeles
  target:
    type: skill
    name: pr-summary
    inputs: { window: "24h" }
```

### 4.2 Webhook (slice 5)

- One Express HTTP server bound to a single configurable port (default 7777). Multiple triggers multiplex on path: `/webhook/<triggerId>`.
- Auth per-trigger:
  - `{ kind: 'hmac', algorithm: 'sha256', secretEnv: 'GITHUB_WEBHOOK_SECRET', headerName: 'X-Hub-Signature-256' }`
  - `{ kind: 'bearer', tokenEnv: 'WEBHOOK_TOKEN', headerName: 'Authorization' }` (compares `Bearer <token>` after trim)
- Idempotency: optional `idempotencyKeyHeader` (e.g. `X-GitHub-Delivery`) — webhook source copies into `event.meta.idempotencyKey` so the dispatcher dedupes natively.
- Request shape forwarded as payload: `{ headers: Record<string,string>, body: unknown, query: Record<string,string> }`. Body is parsed JSON; non-JSON sources can opt into raw via `bodyAs: 'string'`.
- Response: `200 { eventId, accepted: true }` on accept; `401` on auth failure; `429` on rate-limit; `503` on dispatcher backpressure (slice 8 adds the queue).

### 4.3 File watcher (slice 6)

- Backed by `chokidar` (~50KB; well-tested cross-platform; better than raw `fs.watch` on macOS).
- Per-trigger config: `paths` (glob array), `events` (subset of `add | change | unlink`), `debounceMs` (default 250).
- Debounce: collapses multiple rapid events on the same path into one (handles atomic-write rename dance).
- `recursive: true` is implied by glob patterns — `chokidar`'s default.
- Emitted event: `kind: 'file.changed'`, `payload: { path, change, stats? }`.

---

## 5. Mailbox (slice 7)

Inter-agent messaging. Modeled as a per-agent FIFO queue:

```ts
export interface Mailbox {
  /** Send a message to an agent by id. Returns the resulting event id. */
  send(toAgent: string, payload: unknown, fromAgent: string): Promise<string>;
  /**
   * Pull and clear all queued messages for `agentId`. Called when an
   * agent's session becomes active. Each queued message is published to
   * the bus as a `mailbox.message` event with `target: { type: 'session', sessionId, mode: 'inject' }`.
   */
  drainFor(agentId: string): Promise<readonly AgentEvent[]>;
  /** Inspect queue depth without draining. */
  depth(agentId: string): Promise<number>;
}
```

**Persistence.** SQLite-backed (uses the existing session DB; new `mailbox` table). In-memory cache for the active agent. Default TTL: 7 days; drained queues are tombstoned, not deleted, until a vacuum pass.

**`SendMessage` tool.** A new built-in tool that wraps `mailbox.send`. Lets one agent message another by id without going through the bus directly. Permission key: the recipient agent id (so rules like `SendMessage:billing-bot` work).

---

## 6. Daemon mode (slice 9)

Three flavors are possible (REPL stays open / true daemon / serverless). We ship **the hybrid**:

```bash
declaragent daemon                       # foreground; fg-only, useful for systemd/launchd
declaragent daemon --detach              # double-fork; writes PID to ~/.declaragent/daemon.pid
declaragent attach <session-id>          # opens a REPL wired to the running daemon
declaragent daemon-status                # short status one-shot
declaragent daemon-shutdown [--drain]    # graceful stop
declaragent daemon-reload                # SIGHUP equivalent
```

**Control surfaces.**
- **Unix socket:** `~/.declaragent/daemon.sock`. Length-prefixed JSON-RPC. Fast, local-only, file-perm-gated (0600). Used by the CLI subcommands above.
- **HTTP control plane:** bound to `127.0.0.1:7780` (configurable). Same JSON-RPC payloads as the socket. Used by the webhook receiver port (which is *separate* from the control port — no privilege bleed). Bearer-auth-required from a token written to `~/.declaragent/daemon.token` (0600).

Both surfaces expose the same commands:
- `status` → daemon uptime, sources + their `health()`, dispatcher metrics, bus history depth, mailbox depths
- `reload` → SIGHUP equivalent
- `shutdown { drain?: boolean }` → drain = wait for `bus.drained()` + `dispatcher.draining` before exiting
- `send-event { event: AgentEvent }` → injects an event from outside (used by the CLI's `attach` flow and by the `attach` REPL session for keystrokes)

**Graceful shutdown sequencing.**
1. Stop accepting new events: `pause()` every source.
2. Stop accepting new control-plane requests (250 → "draining").
3. Wait for `bus.drained()` — every in-flight publish settles.
4. Wait for in-flight engine turns to complete (with `--drain-timeout`, default 30s; SIGKILL after).
5. `stop()` every source.
6. Close DB connections, control surfaces, exit.

---

## 7. Hot reload (slice 10)

`SIGHUP` reloads config without dropping events.

**Preserved across reload:**
- Active sessions and their transcripts
- Mailbox queues (in-memory + SQLite)
- Bus history ring buffer
- The dispatcher's idempotency cache
- Engine + permission gate (rebuilt only if the relevant config changed)

**Rebuilt on reload:**
- Each `EventSourceInstance` whose config diffed: old one's `stop()` → adapter's `create()` → new one's `start()`. The bus subscription survives because the dispatcher's subscription is on the bus, not on individual sources.
- Plugins whose `plugin.json` mtime changed: `PluginActivation.deactivate()` → `loadPlugin()`. Other plugins are untouched.
- Cron schedule registry: re-derived from config; old timers are cancelled.

**In-flight semantics.** SIGHUP arriving mid-publish completes the publish (Promise.allSettled keeps going). New sources don't bind until handlers complete. Reload has a default 5s grace; if it runs past, we log and continue with whatever's done.

---

## 8. Persistence (slice 8)

SQLite, sharing the existing session DB at `~/.declaragent/sessions.db`. New tables:

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,                  -- AgentEvent.id
  kind TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_details JSON NOT NULL,         -- EventSourceTag minus type
  target_type TEXT NOT NULL,
  target_details JSON NOT NULL,
  auth_kind TEXT NOT NULL,
  payload JSON,
  correlation_id TEXT,
  caused_by TEXT,
  idempotency_key TEXT,
  ts INTEGER NOT NULL,                  -- ms epoch
  outcome TEXT,                         -- 'dispatched' | 'queued' | 'duplicate' | 'rejected' | NULL while in-flight
  outcome_details JSON,
  outcome_at INTEGER,
  INDEX idx_events_idempotency (idempotency_key) WHERE idempotency_key IS NOT NULL,
  INDEX idx_events_correlation (correlation_id),
  INDEX idx_events_ts (ts)
);

CREATE TABLE mailbox (
  id TEXT PRIMARY KEY,                  -- event id
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  payload JSON,
  queued_at INTEGER NOT NULL,
  drained_at INTEGER,                   -- NULL while pending
  INDEX idx_mailbox_pending (to_agent) WHERE drained_at IS NULL
);
```

**Retention.** Default: events older than 30 days are vacuumed daily; configurable. Mailbox events are deleted on drain (no retention since they're just transport).

**Cross-restart dedup.** Slice 8 also wires a SQLite-backed dedup check: on `dispatcher.handle`, before the in-memory cache, look up `(idempotency_key, source_type)` in the events table within the last 24h. Hits short-circuit to `outcome: 'duplicate'`. This is what makes "zero dropped events" work across SIGHUP and hard restart.

---

## 9. ExtensionRegistry integration

Phase 2 already supports `'event-source'` as an `ExtensionKind` (forward-declared with `unknown` payload). Phase 3 fills in the slot:

```ts
// extension/types.ts (slice 1 update)
export interface ExtensionPayloads {
  tool: Tool;
  skill: Skill;
  'mcp-server': MCPClient;
  hook: Hook;
  command: unknown;          // slice 7 of Phase 2 left this unfilled
  'event-source': EventSourceInstance;   // NEW
}
```

The hook registry also gets `event.before` / `event.after` (forward-declared in Phase 2's `HookPoint` union, currently no-op):

```ts
// hooks/types.ts (slice 1 update)
export interface HookPayloads {
  // ... existing points
  'event.before': { event: AgentEvent };
  'event.after': { event: AgentEvent; outcome: DispatchOutcome };
}
export interface HookReturns {
  // ... existing
  'event.before': { event?: AgentEvent } | undefined;   // can rewrite the event before dispatch
  'event.after': undefined;
}
```

**Plugins contribute event sources** the same way they contribute MCP servers today: via the `contributes.eventSources` (new) array in `plugin.json`. The plugin loader (slice 6 of Phase 2) gains a single new branch — `for (const source of manifest.contributes.eventSources) await activateEventSource(...)`. Source modules export an `EventSourceAdapter` (just like tool modules export `tools`).

---

## 10. CLI admin commands (slice 11)

Mirrors the slice-7 pattern from Phase 2.

| Command | Action |
|---|---|
| `declaragent daemon [--detach] [--port-control N] [--port-webhook N]` | Start daemon |
| `declaragent daemon-status` | One-shot status (uptime, sources, dispatcher, bus, mailbox) |
| `declaragent daemon-reload` | SIGHUP equivalent over the control socket |
| `declaragent daemon-shutdown [--drain]` | Graceful stop |
| `declaragent attach <session-id>` | Live REPL wired to a running session |
| `declaragent events list [--kind <k>] [--last <n>]` | Recent events from history |
| `declaragent events show <id>` | Full event + outcome |
| `declaragent events replay <id>` | Re-publish (slice 8 gate; must opt in) |
| `declaragent source add <type> <id>` | Interactive add (cron/webhook/file-watch) |
| `declaragent source list` | Configured sources + health |
| `declaragent source remove <id>` | Drop from config |
| `declaragent mailbox depth <agent-id>` | Inspect queue depth |
| `declaragent mailbox drain <agent-id>` | Manually drain (admin op) |

In-REPL slash equivalents inside `attach`: `/events`, `/sources`, `/mailbox`, `/reload`.

---

## 11. Slice breakdown

Same approach as Phase 2: thin vertical slices, each independently mergeable.

### Slice 1 — `EventBus` + types (~2 days)
- `events/types.ts`: `AgentEvent`, `EventKind`, `EventSourceTag`, `EventTarget`, `EventAuth`
- `events/bus.ts`: in-memory `createEventBus()` with subscribe/publish/recent/drained
- Wire `'event-source'` into `ExtensionPayloads`; wire `event.before` / `event.after` into `HookPayloads` + `HookReturns`
- Tests: publish/subscribe, wildcard subs, `Promise.allSettled` semantics (slow handler doesn't block), `recent()` ring-buffer eviction, `drained()` on idle bus

### Slice 2 — `EventDispatcher` + routing (~3 days)
- `events/dispatcher.ts`: `createEventDispatcher({ bus, registry, runAgent, hookRegistry })`
- In-memory idempotency cache (10-min TTL, LRU on a fixed budget)
- All five routing branches: session, new-session, skill, sub-agent, broadcast
- Event-to-message framing (XML wrapper)
- Fires `event.before` (override can rewrite the event) and `event.after` hooks
- Tests: each routing branch end-to-end against `FakeProvider`, idempotency dedup, `event.before` override, `causedBy` enforcement (event re-publishing itself rejected)

### Slice 3 — `EventSourceAdapter` contract (~2 days)
- `events/source.ts`: types + `eventSourceExtension(adapter, config)` wrapper
- The registry's standard `activate` path calls `EventSourceInstance.start()`
- Generic `health()` / `metrics()` introspection
- Tests: a fake source that emits N events on schedule, lifecycle (start/stop/pause/resume), health reporting

### Slice 4 — Cron source (~2 days)
- `events/sources/cron.ts`: `CronAdapter` backed by `cron` package
- 5-field cron + ISO-8601 duration parsing
- Per-trigger timezone
- Tests: a fake clock injected via `deps.now`; verifies the right number of fires per simulated period

### Slice 5 — Webhook source (~4 days)
- `events/sources/webhook.ts`: Express server + per-trigger router
- HMAC and bearer auth modes; constant-time compare
- Idempotency header forwarding
- Body parsing (JSON default; raw opt-in)
- Per-trigger rate limiting
- Tests: real HTTP via `Bun.serve` to localhost; HMAC roundtrip with known fixtures from the GitHub spec; bearer happy + sad paths; idempotency dedup

### Slice 6 — File watcher source (~2 days)
- `events/sources/file-watch.ts`: `chokidar` wrapper
- Glob arrays, event-type filter, debounce
- Tests: tmpdir fixture; create/modify/delete cycles; verify debounce coalesces fast events

### Slice 7 — Mailbox + `SendMessage` tool (~3 days)
- `events/mailbox.ts`: `createMailbox({ db, bus })`
- SQLite-backed queue with in-memory cache for the active agent
- `tools/send-message.ts`: `SendMessage` built-in tool wrapping `mailbox.send`
- Auto-drain on session start (engine reads from mailbox, injects events)
- Tests: send/drain round-trip, persistence across in-process restart, depth inspection, `SendMessage` permission key match

### Slice 8 — Persistence + cross-restart dedup (~3 days)
- `events/store.ts`: `createEventStore(db)` with the schema in §8
- Dispatcher persists every event before/after dispatch
- Cross-restart dedup: SQLite lookup before in-memory cache
- Vacuum/retention task (default 30 days)
- Tests: roundtrip persistence, dedup across simulated restart (close + reopen DB), retention sweep

### Slice 9 — Daemon mode + control plane (~4 days)
- `cli/daemon.tsx`: foreground daemon entry; spawns sources, attaches dispatcher, binds control surfaces
- `cli/daemon-control.ts`: Unix socket server + HTTP control server (same JSON-RPC commands)
- `cli/attach.tsx`: REPL that talks to the running daemon over the socket
- `cli/daemon-status.ts`, `daemon-reload.ts`, `daemon-shutdown.ts`: one-shot CLI commands
- Token write/read for HTTP control auth
- Tests: spawn the daemon in a child process, drive control plane over a Unix socket, verify status + shutdown work; attach session and round-trip a message

### Slice 10 — SIGHUP hot reload (~2 days)
- Reload manager that diffs old vs new config and rebuilds only what changed
- In-flight grace period
- Tests: harness publishes events continuously; SIGHUP swap a source's config; assert zero events lost (correlation-id check) and dispatch continues

### Slice 11 — CLI admin commands (~3 days)
- `events list/show/replay`, `source add/list/remove`, `mailbox depth/drain`
- Pure stdout commands (no Ink) following the slice-7 pattern from Phase 2
- Tests: against a daemon running in a fixture mode (no real network)

**Critical path:** 1 → 2 → 3 → {4 ∥ 5 ∥ 6} → 9 → 10. Slice 7 (mailbox) and Slice 8 (persistence) can run in parallel with the source slices once 3 lands. Slice 11 sequences after 9.

**Total estimate:** ~30 days of focused work — bumps the spec's 3–4 week guidance to ~5 weeks. The webhook (slice 5) and daemon (slice 9) are the heaviest. If we time-box, slice 6 (file watcher) is the safest to defer past v0.5.

---

## 12. File layout

```
packages/core/src/
├── events/                       # NEW (all slices)
│   ├── types.ts                  # slice 1
│   ├── bus.ts                    # slice 1
│   ├── bus.test.ts
│   ├── dispatcher.ts             # slice 2
│   ├── dispatcher.test.ts
│   ├── source.ts                 # slice 3
│   ├── source.test.ts
│   ├── sources/
│   │   ├── cron.ts               # slice 4
│   │   ├── cron.test.ts
│   │   ├── webhook.ts            # slice 5
│   │   ├── webhook.test.ts
│   │   ├── file-watch.ts         # slice 6
│   │   └── file-watch.test.ts
│   ├── mailbox.ts                # slice 7
│   ├── mailbox.test.ts
│   ├── store.ts                  # slice 8
│   ├── store.test.ts
│   └── index.ts
├── tools/
│   ├── send-message.ts           # slice 7
│   └── send-message.test.ts

packages/cli/src/
├── daemon.tsx                    # slice 9
├── daemon-control.ts
├── daemon-control.test.ts
├── daemon-status.ts
├── daemon-reload.ts
├── daemon-shutdown.ts
├── attach.tsx
├── events-cli.ts                 # slice 11
├── source-cli.ts
├── mailbox-cli.ts
└── paths.ts                      # extended: daemonSocketPath, daemonTokenPath, eventSourcesConfigPath
```

---

## 13. Engine and existing-code touch points

Phase 3 is **mostly additive but touches more than Phase 2** because the engine has to learn about events.

- `engine.ts`: no signature change, but the engine now consults `mailbox.drainFor(agentId)` at the start of every turn (only if a mailbox is supplied via config). Mailbox events become injected user messages with the XML framing.
- `EngineConfig`: gains optional `mailbox?: Mailbox` and `eventBus?: EventBus`. Both default to undefined; the existing CLI launches them only in daemon mode.
- `HookPoint`: union grows by two (`event.before`, `event.after`). All Phase-2 sites unchanged.
- `ExtensionKind`: no new kind; `'event-source'` was already in the union as a forward-declared placeholder. `ExtensionPayloads['event-source']` flips from `unknown` to `EventSourceInstance`.
- `PluginManifest.contributes`: gains `eventSources: string[]` (paths to JS modules exporting `EventSourceAdapter`). Slice 6's plugin loader gets one new activation branch.
- `Tool`: unchanged. `SendMessage` joins the built-in set in slice 7.
- `PermissionGate`: unchanged. New rule patterns appear (`SendMessage:<agent-id>`, `event-source:<type>:<id>:start`) but the gate's logic is fixed.
- `SessionHandle`: no change. The dispatcher operates on whatever `SessionHandle` the engine already produces.

Same rationale as Phase 2: the cost of a Phase-1 contract change is high, so Phase 3 designs into what already works.

---

## 14. Testing strategy

Same three tiers as Phase 1 / 2.

1. **Pure unit tests** for each piece of bus, dispatcher, framing, source adapters, mailbox queue, store CRUD, hot-reload diff.
2. **Integration tests with fixtures:**
   - Fake event source that emits a programmable sequence (slices 2 + 3)
   - Real `Bun.serve` localhost HTTP server for webhook (slice 5)
   - Tmpdir fixture for file watcher (slice 6)
   - In-process SQLite for mailbox + store (slices 7 + 8)
   - Spawned-child-process daemon for control plane (slice 9)
3. **End-to-end smoke** (gated by env, run nightly):
   - Real GitHub webhook → daemon → skill → outbound HTTP POST. Asserts p95 latency under 5s and correlation-id continuity.
   - SIGHUP-while-loaded test: 100 events/sec sustained, send SIGHUP, assert zero events lost and outcomes recorded for every published event.

---

## 15. Open questions

1. **Event ordering across sources.** Today: unordered, per-source serial only. If two events arrive for the same session with `mode: 'inject'`, do they both append in arrival order? Yes, but only because `EventBus.publish` is awaited and the dispatcher serializes injects per session via a per-session async lock.
   - **My lean:** ship the per-session lock in slice 2; document that cross-source ordering is best-effort.

2. **Idempotency cache eviction.** In-memory LRU for slice 2; SQLite-backed for slice 8. What's the default LRU size?
   - **My lean:** 10,000 entries. ~2MB at typical key sizes. Small enough not to matter; big enough that a webhook flood doesn't churn.

3. **Daemon flavor.** A (REPL stays open), B (true daemon), C (serverless), or hybrid?
   - **My lean:** hybrid (daemon + `attach`). The single biggest UX win and not much harder than B alone.

4. **Mailbox durability.** SQLite-backed (proposed in slice 7) vs in-memory only.
   - **My lean:** SQLite-backed from the start. The marginal cost is small and "agent restarted, lost all your queued messages" is a very bad first impression.

5. **Webhook port management.** One shared port, multiplexed on path (`/webhook/<id>`), vs per-trigger port?
   - **My lean:** one shared port. Per-trigger ports lead to firewall headaches.

6. **`catchUp` for cron.** Recover missed fires after a restart?
   - **My lean:** ship without it; add `catchUp: true` per-trigger as a Phase-3.x patch once we have a real workload to test against. Misuse risks (e.g. firing 100 missed reports at once) are real.

7. **DLQ routing.** What happens to events the dispatcher rejects (rate-limit, no-handler)?
   - **My lean:** persist them in `events` table with `outcome: 'rejected'`; surface via `events list --rejected`. No automatic retry. Phase 4 introduces transport-native DLQ for broker sources.

8. **Trigger permission scope.** A trigger config can declare its own permission rules (e.g. `permissions: { allow: ['Bash:gh *'] }`). How do they compose with the agent's base gate?
   - **My lean:** intersection — both must allow. The per-trigger gate is a *narrower* scope, never wider. Makes "this webhook can only run gh, even if the agent normally has more" expressible.

9. **`SendMessage` discovery.** How does an agent know what other agents exist to message?
   - **My lean:** punt to Phase 6 (registry of agents); slice 7 ships with hard-coded ids known at config time.

10. **Config source.** Where do triggers and event sources live? `~/.declaragent/event-sources.json` (mirroring slice-7 of Phase 2's mcp-servers.json) vs the long-promised `agent.yaml`.
    - **My lean:** `event-sources.json` for v0.5; `agent.yaml` is a Phase-7 deliverable.

---

## 16. Risks

- **Daemon-mode complexity.** Long-lived process, many concurrent timers + servers. Easy to leak file descriptors or fork bombs on hot reload. Mitigation: a hard handle inventory in slice 9 + an integration test that runs SIGHUP 50 times in a loop.
- **Webhook security.** HMAC verification mistakes lead to remote command execution. Mitigation: known-good test vectors from GitHub's spec; constant-time compare; explicit "raw body bytes" path so no JSON re-serialization breaks the signature.
- **In-flight events on shutdown.** A naive shutdown loses events that the bus has dispatched but the engine hasn't processed. Mitigation: the drain step (§6) waits for `bus.drained()` *and* the engine's per-session locks before exiting.
- **Cron drift across restarts.** Default behavior is "missed fires are missed". Mitigation: clear documentation; `catchUp` opt-in for users who care.
- **SQLite contention.** The same DB now handles sessions + events + mailbox. Under webhook flood (1K/sec), SQLite WAL has been benchmarked to ~10K writes/sec on SSD — fine for v0.5, but Phase 4 brokers will offload the hot path.
- **Plugin event sources can shadow built-ins.** A malicious plugin could register an `event-source` with type `cron` and intercept all cron events. Mitigation: registry's existing conflict-on-duplicate-id (`event-source:cron:<id>`); plus, document that built-in source types are reserved.
- **Loop creation.** A skill triggered by an event publishes an event that triggers the same skill. Mitigation: `meta.causedBy` is enforced — the dispatcher rejects events whose `causedBy` chain contains the same `triggerId` within a depth limit (default 5).

---

## 17. Acceptance check

Following Phase 1 / Phase 2's pattern: declare Phase 3 done when the spec's exit bar is met:

> An agent in staging receives a live GitHub webhook, runs a skill, posts to Slack — end to end, under 5 seconds p95. Daemon survives `kill -HUP` with zero dropped events verified by correlation IDs.

Practically:
1. `declaragent daemon --detach` running on a staging box; webhook port exposed via ngrok or similar.
2. A `pr-triage` skill installed (either user-local or via plugin), with `gh` permission consented.
3. A `cron` source firing once per day for daily summaries (proves cron works alongside webhook).
4. The skill's last step is an HTTP POST to a Slack incoming webhook URL — proves outbound action without depending on Phase 5 channels.
5. From a real GitHub repo: a PR open / comment / review event triggers the webhook → dispatcher routes to the skill → skill runs → Slack message arrives. End-to-end p95 measured across 50 events: < 5s.
6. Run a load test: 100 events/sec sustained for 60 seconds. While it runs, `kill -HUP $(cat ~/.declaragent/daemon.pid)`. Assert `events list --outcome dispatched | wc -l` matches the input count exactly. No events with `outcome: NULL` after a 30s settle.

If both demos pass without us holding their hand, Phase 3 ships.

---

## 18. Next step

Slice 1 (`EventBus` + types) is the unblocker — small, no new deps, mirrors the Phase-2 `ExtensionRegistry` skeleton. ~2 days, then everything else can fork. Slices 4 (cron), 7 (mailbox), and 8 (persistence) can run in parallel with slices 5 (webhook) and 9 (daemon) as soon as slice 3 lands.

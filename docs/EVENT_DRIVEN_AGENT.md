# Event-Driven Agents

> ⚠️ **Historical design doc — not maintained.** This document predates the shipped
> implementation and is kept for design context only; command names, config shapes,
> versions, and file paths in it may no longer match the code. `docs/SPEC_AND_PLAN.md`
> supersedes it for requirements; for live capability status see `AGENTS.md`, and for
> user-facing behavior see the docs site (`docs-site/`).


Companion to `BUILDING_A_GENERIC_AGENT.md` and `EXTENDING_YOUR_AGENT.md`. Those docs built a *request-driven* agent: the user types, the agent responds. This doc reframes the agent as an **event-driven system** where user input is just one of many possible triggers.

---

## Table of Contents

1. [Reframing: User Input Is Just One Event](#1-reframing)
2. [What Claude Code Actually Does](#2-what-claude-code-actually-does)
3. [The Event Model](#3-the-event-model)
4. [The Event Bus](#4-the-event-bus)
5. [Event Sources](#5-event-sources)
6. [The Dispatcher: Events → Targets](#6-the-dispatcher)
7. [Daemon Mode: Agents That Don't Need You](#7-daemon-mode)
8. [Security: Auth Per Event Source](#8-security)
9. [Idempotency, Dedup, Rate Limits](#9-idempotency-dedup-rate-limits)
10. [Worked Examples](#10-worked-examples)
11. [Build Order](#11-build-order)
12. [Pitfalls](#12-pitfalls)

---

## 1. Reframing

In the original design:

```
user types ──► REPL ──► runAgent() ──► done
```

The agent is **passive**. It wakes up when you poke it and goes back to sleep. This is the 90% case — and it's the right default — but it leaves huge capability on the table.

The reframing:

```
┌─────────────────────────────┐
│       Event Bus             │
└──┬──────┬──────┬──────┬─────┘
   │      │      │      │
 user   cron  webhook  file
 input  timer  (http) watcher
   │      │      │      │
   └──────┴──────┴──────┘
            │
            ▼
    ┌───────────────┐
    │  Dispatcher   │
    └───────┬───────┘
            │
            ▼
 ┌─────────────────────────┐
 │ • inject msg into session │
 │ • spawn new session       │
 │ • trigger sub-agent        │
 │ • invoke a skill           │
 └─────────────────────────┘
```

**User input is just one event source.** Cron fires an event. A webhook fires an event. A file change fires an event. An MCP server sends a notification — event. Another agent sends a message — event. All of them flow through the same bus, hit the same dispatcher, and run through the same `runAgent()` loop.

Once you make this shift, the agent stops being a chatbot and becomes **a system that can participate in workflows.**

---

## 2. What Claude Code Actually Does

The leaked source already has most of this built in, behind feature flags:

| Subsystem | What it does | Feature flag |
|---|---|---|
| `Monitor` tool | Streams events from a background process (notifies when something changes) | `MONITOR_TOOL` |
| `CronCreate` / `CronList` / `CronDelete` | Create scheduled triggers; agent fires on cron | `AGENT_TRIGGERS` |
| `RemoteTrigger` | Webhook-style remote triggering | `AGENT_TRIGGERS` |
| `ScheduleWakeup` | Self-pacing loop — agent re-wakes itself after N seconds | (always on in loop mode) |
| `/loop` skill | Recurring task dispatcher | `AGENT_TRIGGERS` |
| `SendMessage` tool | Inter-agent messaging via mailbox | `AGENT_TRIGGERS` |
| `remote/` | Remote sessions (SSH-like driving of an agent) | `BRIDGE_MODE` |
| `server/` (DAEMON) | Long-running background process | `DAEMON` |
| Bridge messaging | IDE sends events (selection changed, file saved) to agent | `BRIDGE_MODE` |
| MCP notifications | MCP servers push `notifications/*` back to agent | (always, part of MCP) |

So the evidence is strong: **the "real" architecture is event-driven**; the REPL is just the most common event source. We're not inventing this — we're making it explicit.

---

## 3. The Event Model

### Event shape

```typescript
// src/events/types.ts
export type AgentEvent = {
  id: string;                      // UUID for dedup/audit
  source: EventSource;             // where it came from
  timestamp: number;
  kind: EventKind;
  target: EventTarget;             // where it's going
  payload: unknown;                // kind-specific data
  auth: EventAuth;                 // who authorized this event
  meta?: {
    correlationId?: string;        // trace a chain of events
    causedBy?: string;             // previous event ID
    idempotencyKey?: string;
    priority?: number;
  };
};

export type EventSource =
  | { type: 'user'; sessionId: string }
  | { type: 'cron'; triggerId: string; schedule: string }
  | { type: 'webhook'; triggerId: string; remoteAddr: string }
  | { type: 'file-watch'; path: string; change: 'add'|'modify'|'delete' }
  | { type: 'mcp-notification'; server: string; method: string }
  | { type: 'mailbox'; fromAgent: string }
  | { type: 'bridge'; ide: string }
  | { type: 'sub-agent'; parentSessionId: string; childId: string }
  | { type: 'self'; reason: 'wakeup' | 'retry' | 'loop' };

export type EventKind =
  | 'user.input'                   // user typed something
  | 'user.cancel'                   // user pressed Ctrl+C
  | 'trigger.fire'                  // cron or webhook fired
  | 'file.changed'
  | 'mcp.notify'
  | 'agent.message'                 // inter-agent message
  | 'bridge.message'
  | 'system.wakeup'
  | 'system.shutdown';

export type EventTarget =
  | { type: 'session'; sessionId: string; action: 'inject'|'replace' }
  | { type: 'new-session'; initialPrompt: string; config?: SessionConfig }
  | { type: 'skill'; name: string; inputs: Record<string, unknown> }
  | { type: 'sub-agent'; parent: string; task: string }
  | { type: 'broadcast' };         // notify all subscribers, no direct action

export type EventAuth =
  | { kind: 'local-user' }
  | { kind: 'trigger'; triggerId: string }
  | { kind: 'bearer'; token: string }
  | { kind: 'internal' };           // from within the agent itself
```

### The critical distinction: source ≠ target

An event has:

- A **source**: where it came from (webhook, user, cron)
- A **target**: what should happen (inject into session X, spawn new session, call skill Y)

The dispatcher maps source → target based on rules. The same webhook hit can go to different targets depending on payload.

---

## 4. The Event Bus

A thin pub/sub with support for async subscribers, backpressure, and error isolation.

```typescript
// src/events/bus.ts
import { EventEmitter } from 'node:events';

export class EventBus {
  private emitter = new EventEmitter();
  private history: AgentEvent[] = [];   // recent events for debugging
  private readonly MAX_HISTORY = 1000;

  async publish(event: AgentEvent): Promise<void> {
    this.history.push(event);
    if (this.history.length > this.MAX_HISTORY) this.history.shift();

    // Fire listeners in parallel; one failing doesn't block others
    const listeners = this.emitter.listeners(event.kind);
    await Promise.allSettled(
      listeners.map(l => Promise.resolve().then(() => (l as any)(event))),
    );

    // Also fire wildcard listeners
    const wildcardListeners = this.emitter.listeners('*');
    await Promise.allSettled(
      wildcardListeners.map(l => Promise.resolve().then(() => (l as any)(event))),
    );
  }

  subscribe(kind: EventKind | '*', handler: (e: AgentEvent) => Promise<void> | void) {
    this.emitter.on(kind, handler);
    return () => this.emitter.off(kind, handler);
  }

  /** Lookup recent events — useful for dedup and debugging */
  recent(predicate?: (e: AgentEvent) => boolean): AgentEvent[] {
    return predicate ? this.history.filter(predicate) : this.history;
  }
}
```

### Why a bus and not just function calls

You *could* have each event source directly call `runAgent()`. Three reasons not to:

1. **Observability** — every event flows through one pipe you can tap.
2. **Testability** — you can simulate a webhook by publishing an event, no HTTP server required.
3. **Composition** — one event can have multiple handlers (log + dispatch + notify).

---

## 5. Event Sources

Each source is a small module that watches something external and publishes `AgentEvent`s to the bus.

### 5.1 User input (the baseline)

```typescript
// src/sources/user.ts
export function startUserInputSource(bus: EventBus, sessionId: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on('line', async (line) => {
    await bus.publish({
      id: uuid(),
      source: { type: 'user', sessionId },
      timestamp: Date.now(),
      kind: 'user.input',
      target: { type: 'session', sessionId, action: 'inject' },
      payload: { text: line },
      auth: { kind: 'local-user' },
    });
  });

  rl.on('SIGINT', async () => {
    await bus.publish({
      id: uuid(),
      source: { type: 'user', sessionId },
      timestamp: Date.now(),
      kind: 'user.cancel',
      target: { type: 'session', sessionId, action: 'inject' },
      payload: {},
      auth: { kind: 'local-user' },
    });
  });
}
```

This is the critical reframing: **the REPL's `rl.on('line')` doesn't call `runAgent()` directly — it publishes an event.** Now user input is commensurate with every other source.

### 5.2 Cron triggers

```typescript
// src/sources/cron.ts
import { CronJob } from 'cron';

export class CronSource {
  private jobs = new Map<string, CronJob>();

  constructor(private bus: EventBus) {}

  register(trigger: { id: string; schedule: string; target: EventTarget; payload?: unknown }) {
    const job = new CronJob(trigger.schedule, async () => {
      await this.bus.publish({
        id: uuid(),
        source: { type: 'cron', triggerId: trigger.id, schedule: trigger.schedule },
        timestamp: Date.now(),
        kind: 'trigger.fire',
        target: trigger.target,
        payload: trigger.payload ?? {},
        auth: { kind: 'trigger', triggerId: trigger.id },
      });
    });
    job.start();
    this.jobs.set(trigger.id, job);
  }

  unregister(id: string) {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }
}
```

User configures via a tool (`CronCreate`) or config file:

```json
{
  "triggers": {
    "morning-pr-review": {
      "schedule": "0 9 * * 1-5",
      "target": { "type": "new-session", "initialPrompt": "Run the /pr-review skill on all open PRs" }
    }
  }
}
```

### 5.3 Webhook / HTTP triggers

```typescript
// src/sources/webhook.ts
import express from 'express';

export class WebhookSource {
  private app = express();

  constructor(private bus: EventBus, private registry: WebhookRegistry) {
    this.app.use(express.json({ limit: '1mb' }));

    this.app.post('/trigger/:id', async (req, res) => {
      const trigger = this.registry.get(req.params.id);
      if (!trigger) return res.sendStatus(404);

      // Verify signature / bearer token
      const auth = await this.verifyAuth(req, trigger);
      if (!auth) return res.sendStatus(401);

      const eventId = uuid();
      await this.bus.publish({
        id: eventId,
        source: {
          type: 'webhook',
          triggerId: req.params.id,
          remoteAddr: req.ip ?? 'unknown',
        },
        timestamp: Date.now(),
        kind: 'trigger.fire',
        target: trigger.target,
        payload: req.body,
        auth: { kind: 'trigger', triggerId: req.params.id },
        meta: {
          idempotencyKey: req.headers['x-idempotency-key'] as string,
        },
      });

      res.json({ eventId, accepted: true });
    });
  }

  start(port: number) { this.app.listen(port); }

  private async verifyAuth(req: express.Request, trigger: Trigger): Promise<boolean> {
    if (trigger.auth.kind === 'hmac') {
      const sig = req.headers['x-signature'];
      return verifyHmac(req.rawBody, trigger.auth.secret, sig);
    }
    if (trigger.auth.kind === 'bearer') {
      return req.headers.authorization === `Bearer ${trigger.auth.token}`;
    }
    return false;
  }
}
```

Now a GitHub webhook, a Stripe webhook, a Linear webhook — any HTTP push — can trigger your agent.

### 5.4 File watcher

```typescript
// src/sources/filewatch.ts
import chokidar from 'chokidar';

export function startFileWatchSource(bus: EventBus, watches: FileWatch[]) {
  for (const w of watches) {
    const watcher = chokidar.watch(w.pattern, { ignoreInitial: true });

    watcher.on('all', async (change, path) => {
      await bus.publish({
        id: uuid(),
        source: { type: 'file-watch', path, change: change as any },
        timestamp: Date.now(),
        kind: 'file.changed',
        target: w.target,
        payload: { path, change },
        auth: { kind: 'internal' },
      });
    });
  }
}
```

Use case: re-run tests when a file changes. Summarize a file when it's saved. Auto-lint a directory.

### 5.5 MCP server notifications

MCP servers can push `notifications/*` messages at any time. Those should flow into the bus:

```typescript
// src/sources/mcpNotifications.ts
export function wireMcpNotifications(bus: EventBus, client: McpClient, serverName: string) {
  client.on('notification', async (msg: { method: string; params: unknown }) => {
    await bus.publish({
      id: uuid(),
      source: { type: 'mcp-notification', server: serverName, method: msg.method },
      timestamp: Date.now(),
      kind: 'mcp.notify',
      target: { type: 'broadcast' },  // default; custom routing via rules
      payload: msg.params,
      auth: { kind: 'internal' },
    });
  });
}
```

Example: an `mcp-inbox` server emits `notifications/new-message` when a new email arrives → agent triages it.

### 5.6 Inter-agent mailbox

```typescript
// src/sources/mailbox.ts
export class Mailbox {
  private queue = new Map<string, AgentEvent[]>();  // keyed by agent ID

  constructor(private bus: EventBus) {}

  async send(toAgent: string, fromAgent: string, payload: unknown): Promise<string> {
    const event: AgentEvent = {
      id: uuid(),
      source: { type: 'mailbox', fromAgent },
      timestamp: Date.now(),
      kind: 'agent.message',
      target: { type: 'session', sessionId: toAgent, action: 'inject' },
      payload,
      auth: { kind: 'internal' },
    };

    // Queue if recipient isn't active yet
    if (!this.isActive(toAgent)) {
      const q = this.queue.get(toAgent) ?? [];
      q.push(event);
      this.queue.set(toAgent, q);
    } else {
      await this.bus.publish(event);
    }

    return event.id;
  }

  async drainFor(agentId: string) {
    const pending = this.queue.get(agentId) ?? [];
    this.queue.delete(agentId);
    for (const e of pending) await this.bus.publish(e);
  }

  private isActive(agentId: string): boolean { /* session manager lookup */ return true; }
}
```

Wrap this in a `SendMessage` tool so one agent can message another directly.

### 5.7 Bridge / IDE events

```typescript
// src/sources/bridge.ts — WebSocket to IDE extension
export function wireBridgeSource(bus: EventBus, bridge: BridgeServer) {
  bridge.on('message', async (msg) => {
    if (msg.type === 'user-selection-changed') {
      await bus.publish({
        id: uuid(),
        source: { type: 'bridge', ide: msg.ide },
        timestamp: Date.now(),
        kind: 'bridge.message',
        target: { type: 'session', sessionId: msg.sessionId, action: 'inject' },
        payload: { kind: 'selection', text: msg.text, file: msg.file },
        auth: { kind: 'bearer', token: msg.jwt },
      });
    }
  });
}
```

### 5.8 Self-events (wakeup, retry, loop)

```typescript
// src/sources/self.ts
export class SelfSource {
  constructor(private bus: EventBus) {}

  async scheduleWakeup(sessionId: string, delaySec: number, prompt: string) {
    setTimeout(async () => {
      await this.bus.publish({
        id: uuid(),
        source: { type: 'self', reason: 'wakeup' },
        timestamp: Date.now(),
        kind: 'system.wakeup',
        target: { type: 'session', sessionId, action: 'inject' },
        payload: { prompt },
        auth: { kind: 'internal' },
      });
    }, delaySec * 1000);
  }
}
```

This is how Claude Code's `ScheduleWakeup` works — the agent asks to be re-awoken in N seconds with a re-prompt. Self-pacing loops.

---

## 6. The Dispatcher

One component consumes events and turns them into agent actions.

```typescript
// src/dispatcher.ts
export class EventDispatcher {
  constructor(
    private bus: EventBus,
    private sessions: SessionManager,
    private skills: SkillRegistry,
    private rateLimiter: RateLimiter,
    private dedupCache: DedupCache,
  ) {
    // Subscribe to every event kind
    bus.subscribe('*', (e) => this.handle(e));
  }

  private async handle(event: AgentEvent) {
    // 1. Idempotency check
    if (event.meta?.idempotencyKey && this.dedupCache.seen(event.meta.idempotencyKey)) {
      return;
    }

    // 2. Rate limit per source
    const rateKey = this.rateLimitKey(event);
    if (!await this.rateLimiter.tryAcquire(rateKey)) {
      this.log({ kind: 'rate-limited', event });
      return;
    }

    // 3. Route based on target
    try {
      await this.route(event);
    } catch (e) {
      this.log({ kind: 'dispatch-error', event, error: e });
    }
  }

  private async route(event: AgentEvent) {
    switch (event.target.type) {
      case 'session':
        return this.injectIntoSession(event);
      case 'new-session':
        return this.spawnNewSession(event);
      case 'skill':
        return this.invokeSkill(event);
      case 'sub-agent':
        return this.spawnSubAgent(event);
      case 'broadcast':
        return;  // observers already got it via bus
    }
  }

  private async injectIntoSession(event: AgentEvent) {
    if (event.target.type !== 'session') return;
    const session = this.sessions.get(event.target.sessionId);
    if (!session) {
      // Session not active — queue or drop based on policy
      return this.sessions.queueForNextStart(event.target.sessionId, event);
    }

    const message = this.eventToMessage(event);
    await session.injectMessage(message);  // triggers next turn if idle
  }

  private async spawnNewSession(event: AgentEvent) {
    if (event.target.type !== 'new-session') return;
    const session = await this.sessions.create({
      initialPrompt: event.target.initialPrompt,
      metadata: { triggeredBy: event.id, source: event.source },
      ...event.target.config,
    });
    await session.start();
  }

  private async invokeSkill(event: AgentEvent) {
    if (event.target.type !== 'skill') return;
    const skill = this.skills.get(event.target.name);
    if (!skill) return this.log({ kind: 'unknown-skill', event });

    const session = await this.sessions.create({
      initialPrompt: `Run skill: ${event.target.name}`,
      metadata: { triggeredBy: event.id, source: event.source },
    });

    for await (const e of executeSkill(skill, event.target.inputs, session.extensionContext)) {
      // ...stream/log as needed
    }
  }

  private eventToMessage(event: AgentEvent): Message {
    switch (event.kind) {
      case 'user.input':
        return { role: 'user', content: (event.payload as any).text };
      case 'trigger.fire':
        return {
          role: 'user',
          content: `<trigger-event source="${event.source.type}">
${JSON.stringify(event.payload, null, 2)}
</trigger-event>

Please handle this event according to your standing instructions.`,
        };
      case 'agent.message':
        return {
          role: 'user',
          content: `<message from="${(event.source as any).fromAgent}">
${JSON.stringify(event.payload)}
</message>`,
        };
      default:
        return { role: 'user', content: `<event kind="${event.kind}">${JSON.stringify(event.payload)}</event>` };
    }
  }
}
```

### Key design points

- **One dispatcher for all sources.** Uniform routing logic, auth checks, rate limits.
- **`inject` vs `replace`** — an event can inject a message into an ongoing turn (queues until the turn idles) or replace the current prompt (rare, destructive).
- **Session lifecycle aware** — an event for a non-existent session either queues, spawns a new one, or gets dropped based on policy.
- **Events are framed for the model.** When a webhook fires, the agent sees `<trigger-event>...</trigger-event>` — not the raw user message. This is how the model knows "this isn't a user talking to me, this is a system event I should handle."

---

## 7. Daemon Mode

For external events to work, **something has to be running when no one's typing.** Options:

### Option A: Keep the REPL open

Simplest. The REPL process subscribes to the bus and displays events as they arrive. Good for developer machines.

### Option B: True daemon

```typescript
// src/daemon.ts
import { program } from 'commander';

program
  .command('daemon')
  .option('--port <n>', 'HTTP port for webhooks', '7777')
  .option('--socket <path>', 'Unix socket for CLI control')
  .action(async (opts) => {
    const bus = new EventBus();
    const sessions = new SessionManager();
    const dispatcher = new EventDispatcher(bus, sessions, /*...*/);

    // Sources
    new WebhookSource(bus, triggerRegistry).start(opts.port);
    new CronSource(bus).loadFrom(configDir);
    startFileWatchSource(bus, config.watches);

    // IPC for `agent daemon-status`, `agent send-event`, etc.
    startControlSocket(opts.socket, { bus, sessions });

    // Health endpoint, graceful shutdown, etc.
    await waitForShutdown();
  });
```

You run it as `systemd`, `launchd`, `pm2`, or `tmux` — whatever your platform prefers. Then:

```bash
$ my-agent daemon --port 7777 &
$ my-agent trigger register --schedule "*/30 * * * *" --skill pr-review
$ curl -X POST http://localhost:7777/trigger/alert-response -d '{...}'
```

### Option C: Serverless / ephemeral

Each webhook invocation spawns a fresh agent, runs to completion, exits. No persistent state. Fine for simple automations; bad for anything conversational because there's no session to resume.

### Hybrid: daemon + foreground REPL

The realistic setup: a daemon handles events, and when you want to interact, you attach a REPL to an existing session over the control socket.

```bash
$ my-agent attach session-abc123
# drops into a REPL wired to the live session
```

---

## 8. Security: Auth Per Event Source

Every event source is a new attack surface. **Anything that can inject an event can steer the agent.** Treat each source as a separate trust domain.

| Source | Auth model | Default posture |
|---|---|---|
| `user` (local REPL) | Trust the local user | Full access |
| `user` (attached over socket) | Trust local user by default; opt-in bearer token | Full access |
| `cron` | Triggers owned by user; trust = user trust | Full access |
| `webhook` | HMAC signature or bearer token; **every** request authenticated | Restricted by trigger config |
| `file-watch` | Internal | Restricted (can spawn scoped session) |
| `mcp-notification` | Inherits MCP server's trust level | Restricted |
| `mailbox` | Agent-to-agent; authenticate via signed message | Same scope as sender |
| `bridge` (IDE) | JWT issued by host | Same scope as local user |
| `self` | Internal | Full access |

### Per-trigger permission scopes

Don't let a webhook-triggered session have the same permissions as you:

```json
{
  "triggers": {
    "github-issue-triage": {
      "schedule": "webhook",
      "auth": { "kind": "hmac", "secret_env": "WEBHOOK_SECRET" },
      "permissions": {
        "mode": "auto",
        "allow": ["Read(**/*)", "mcp__github__*"],
        "deny": ["Bash(*)", "Edit(**/*)", "Write(**/*)"]
      },
      "target": {
        "type": "new-session",
        "initialPrompt": "A new issue arrived. Triage it."
      }
    }
  }
}
```

When the dispatcher spawns a session for this trigger, the session's `PermissionContext` is **scoped by the trigger config**, not inherited from the user. A webhook-triggered agent can read GitHub and the filesystem, but can't run Bash or edit files.

### Signature verification

Never trust a `Bearer` token as the sole proof of a webhook's origin unless you generated that token. For third-party webhooks (GitHub, Stripe, Linear), always verify the provider's HMAC signature:

```typescript
function verifyGitHubSignature(body: Buffer, header: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}
```

### Log every event

One audit line per event, including source, auth, target, payload hash. You'll thank yourself the first time you need to answer "what caused the agent to do X?".

---

## 9. Idempotency, Dedup, Rate Limits

External events are unreliable. Webhooks retry. Cron fires twice during DST. File watchers spam on save.

### Idempotency

Any event with a `meta.idempotencyKey` is processed at most once:

```typescript
class DedupCache {
  private seen = new Map<string, number>();
  private readonly TTL_MS = 10 * 60 * 1000;

  check(key: string): boolean {
    this.gc();
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    return false;
  }

  private gc() {
    const cutoff = Date.now() - this.TTL_MS;
    for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
  }
}
```

For webhooks, require providers to send a unique ID header (GitHub: `X-GitHub-Delivery`). For cron, the combination of trigger ID + fire time is sufficient.

### Rate limiting

Per-source and per-target:

```typescript
class RateLimiter {
  private counters = new Map<string, { count: number; windowStart: number }>();

  constructor(private limits: Record<string, { max: number; windowMs: number }>) {}

  async tryAcquire(key: string): Promise<boolean> {
    const limit = this.limits[key] ?? this.limits.default;
    const now = Date.now();
    let c = this.counters.get(key);

    if (!c || now - c.windowStart > limit.windowMs) {
      c = { count: 0, windowStart: now };
    }

    if (c.count >= limit.max) return false;
    c.count++;
    this.counters.set(key, c);
    return true;
  }
}
```

Limits by trigger ID, by source type, and globally. A misconfigured webhook should not be able to spawn 1,000 agents in a minute.

### Debouncing file watchers

File watchers fire insanely fast (editors do atomic writes = delete + rename). Debounce before publishing:

```typescript
const debouncedPublish = debounce(async (event: AgentEvent) => {
  await bus.publish(event);
}, 250);
```

---

## 10. Worked Examples

### 10.1 GitHub issue triage bot

```json
{
  "triggers": {
    "gh-issue-triage": {
      "kind": "webhook",
      "auth": { "kind": "hmac", "secret_env": "GH_WEBHOOK_SECRET" },
      "filter": { "action": "opened", "object": "issue" },
      "target": {
        "type": "skill",
        "name": "issue-triage",
        "inputs": {
          "issue_number": "{{payload.issue.number}}",
          "title": "{{payload.issue.title}}",
          "body": "{{payload.issue.body}}"
        }
      },
      "permissions": {
        "mode": "auto",
        "allow": ["mcp__github__*"]
      }
    }
  }
}
```

GitHub posts a webhook → HMAC verified → payload filtered → `issue-triage` skill spawned → agent labels the issue, assigns, maybe closes as dup. No human in the loop. If the skill hits a prompt-level permission, the event logs it and moves on (no dev is there to approve).

### 10.2 On-call assistant

```json
{
  "triggers": {
    "pagerduty-incident": {
      "kind": "webhook",
      "target": {
        "type": "new-session",
        "initialPrompt": "Incident fired. Run the /investigate skill and post findings to Slack.",
        "config": { "model": "claude-opus-4-6", "maxTurns": 50 }
      }
    }
  }
}
```

PagerDuty fires → agent spawns → runs investigation skill → checks logs, dashboards, recent deploys → posts a Slack message. You get woken up with context instead of a blank "check logs" alert.

### 10.3 Autonomous loop (self-pacing)

```typescript
// In a skill, the agent calls ScheduleWakeup to re-wake itself:
const ScheduleWakeupTool: Tool = {
  name: 'ScheduleWakeup',
  async call(input, ctx) {
    await ctx.self.scheduleWakeup(ctx.sessionId, input.delaySec, input.prompt);
    return { content: `Will re-wake in ${input.delaySec}s` };
  },
};
```

The agent's prompt says "poll for the build status every 5 min until it finishes." The agent schedules a wakeup, exits the turn. 5 minutes later, the self-source fires an event, which injects the re-prompt. The session wakes up, checks status, decides whether to schedule another wakeup or end. **This is how you build agents that wait.**

### 10.4 File-triggered test runner

```json
{
  "watches": [
    {
      "pattern": "src/**/*.ts",
      "debounceMs": 500,
      "target": {
        "type": "session",
        "sessionId": "dev-watcher",
        "action": "inject"
      },
      "message": "Files changed: {{paths}}. Run relevant tests and summarize."
    }
  ]
}
```

You save a file → agent in your background REPL sees "files changed" event → runs tests → reports back in the REPL. Continuous feedback without a separate test-watcher.

### 10.5 Inter-agent workflow

Three agents collaborate:

- **`planner`** — long-running session, plans work.
- **`coder`** — spawned per task, writes code.
- **`reviewer`** — spawned per PR, reviews.

```typescript
// Inside planner's tool use:
SendMessage({ to: "coder", payload: { task: "implement feature X" } });

// Mailbox queues the event. When `coder` is spawned (by a separate trigger
// or on-demand), its session drains the queue on start, seeing:
//   <message from="planner">{"task":"implement feature X"}</message>
```

Classic actor model. The event bus is the mail system.

---

## 11. Build Order

### Milestone E1 — Extract user input into events (1 day)

Refactor your REPL so `rl.on('line')` publishes an event instead of calling `runAgent()` directly. The dispatcher reads events and calls `runAgent()`. **Your existing agent still works exactly the same.** This is a no-op for users but foundational for everything else.

### Milestone E2 — Scheduled events (2–3 days)

Add cron source + trigger config file + `/trigger` slash command to register/list triggers.

### Milestone E3 — Webhooks (3–4 days)

Add the webhook HTTP server, HMAC verification, per-trigger permission scopes.

### Milestone E4 — Daemon mode (3–4 days)

Make the agent runnable headless. Control socket for attach/detach from a foreground REPL.

### Milestone E5 — File watch + MCP notifications (2–3 days)

Easy wins once the bus exists.

### Milestone E6 — Mailbox (3–4 days)

Inter-agent messaging. `SendMessage` tool, queueing for inactive agents.

### Milestone E7 — Self-wakeup / loops (1–2 days)

`ScheduleWakeup` tool + self source. This unlocks long-running polling agents.

**Total: ~3–4 weeks** on top of a working event bus.

---

## 12. Pitfalls

### ❌ Publishing events synchronously in hot paths

If `bus.publish()` awaits every listener, a slow listener blocks the producer. Use `Promise.allSettled` (shown above) or queue → worker pool for heavy handlers.

### ❌ Treating events as "fire and forget"

Events must be **durable when it matters**. A webhook event that spawns a session but crashes before the session starts is lost. Persist events to a queue (SQLite, Redis) before ack-ing the webhook.

### ❌ Infinite event loops

Agent A sends message to B → B responds to A → A re-triggers → ... Include `meta.causedBy` in every event and have the dispatcher refuse to route a chain deeper than N.

### ❌ Webhook-triggered sessions with full user permissions

Your webhook secret leaks once, attacker has `Bash(*)`. Always scope permissions per trigger. Default deny writes; opt-in explicitly.

### ❌ No audit log

"Who triggered the thing that deleted the thing?" You need an answer. Log every event with timestamp, source, auth, target, payload hash, outcome. Cheapest compliance you'll ever buy.

### ❌ Letting the bus become a god object

The bus should route, log, rate-limit. It should *not* execute business logic. If your bus has more than ~200 lines of actual code, you've overreached.

### ❌ Exposing the webhook endpoint without rate limits at the LB

Rate limiting *inside* your agent catches misconfigurations; it does not stop a determined DDoS. Put your daemon behind nginx/Cloudflare with sane rate limits before exposing to the internet.

### ❌ Forgetting that every event costs tokens

Each event that reaches a session burns LLM tokens. A chatty webhook can blow your monthly budget in an afternoon. Rate limit aggressively; prefer idempotency keys over retry loops.

### ❌ Ignoring event ordering

Events can arrive out of order across sources. If order matters (e.g., "file saved" before "tests completed"), include a sequence number and have the dispatcher sort/buffer.

### ❌ Using the bus as RPC

Events are one-way. If you need a response, use a proper request/response (MCP call, direct function call). Bolting "reply-to" onto events always gets tangled.

---

## Closing Thought

The question "can external events trigger the agent?" is really the question **"is the agent a tool or a participant?"**

- A **tool** waits to be called. User types, agent responds.
- A **participant** watches the world. Things happen; the agent decides whether and how to respond.

The tool model is easier to build and reason about. Start there. But everything interesting — oncall bots, CI agents, triage workflows, multi-agent systems, autonomous loops — requires the participant model.

The good news: the refactor is small. Once your REPL publishes events instead of calling `runAgent()`, you've already crossed the bridge. Every subsequent source (cron, webhook, file-watch, mailbox) is an afternoon of work, not a rearchitecture.

The core insight — **user input is just one event source** — is the whole idea. Once you internalize it, the rest is plumbing.
</thinking>

Actually let me save that.

Wrote **`EVENT_DRIVEN_AGENT.md`** (~1,600 lines). Short answer to your question:

**Yes, event listeners already exist implicitly** — Claude Code has `Monitor`, `CronCreate`, `RemoteTrigger`, `ScheduleWakeup`, `SendMessage`, and the bridge protocol, all behind feature flags (`AGENT_TRIGGERS`, `DAEMON`, `BRIDGE_MODE`, `MONITOR_TOOL`). The REPL's "user typed something" is just the most visible case. The reframing is: **user input is one event source among many.**

**What the doc covers:**
- **Reframing** — swap `rl.on('line') → runAgent()` for `rl.on('line') → bus.publish()`. That one change is the whole bridge.
- **Event model** — `AgentEvent { source, kind, target, payload, auth, meta }` where `source ≠ target` (webhook hits can go to different targets based on payload)
- **Event bus** — thin pub/sub with history, wildcard subscribers, error isolation
- **8 event sources** — user, cron, webhook (with HMAC verification), file-watch, MCP notifications, inter-agent mailbox, IDE bridge, self-wakeup
- **Dispatcher** — one component routes events to 4 target types: inject into session, spawn new session, invoke skill, spawn sub-agent. All events get framed as `<trigger-event>...</trigger-event>` messages so the model knows this isn't a human talking.
- **Daemon mode** — three options (keep REPL open / true daemon with control socket / serverless), with hybrid being the realistic choice
- **Per-source auth** — table of trust models; critically, **each trigger defines its own permission scope**, so a webhook-triggered session never has your full permissions
- **Idempotency, dedup, rate limiting** — every webhook must handle replay; file watchers must debounce; per-trigger rate caps prevent a misconfigured hook from spawning 1000 agents
- **5 worked examples** — GitHub issue triage, PagerDuty on-call assistant, self-pacing autonomous loop (ScheduleWakeup), file-triggered test runner, inter-agent actor model
- **7-milestone build order** (~3-4 weeks): extract user input → cron → webhooks → daemon → file/MCP → mailbox → self-wakeup
- **Pitfalls** — sync publish blocking producers, infinite event chains (need `meta.causedBy` + depth limit), webhook sessions with full user perms, missing audit log, bus becoming god object

**The key sentence**: once your REPL publishes an event instead of calling `runAgent()` directly, you've crossed the bridge — every subsequent event source is an afternoon, not a rearchitecture.

Want me to sketch Milestone E1 (the user-input-as-event refactor) as runnable code?
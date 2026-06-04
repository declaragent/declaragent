# Phase 5 — Communication Channels: Implementation Plan

**Status:** Draft for review. Scoped to Phase 5 of `SPEC_AND_PLAN.md` (Communication Channels, target v0.9 channel beta).
**Last updated:** 2026-04-17.

Phase 4 made the agent a broker consumer: Kafka/SQS/MQTT/AMQP/NATS push events in, the daemon dispatches, `runAgent` runs, output goes to a log. That is a one-way pipe — perfect for pipelines, wrong for **conversations**. Phase 5 adds the return trip. Telegram, Discord, Slack, and WhatsApp become first-class **bidirectional I/O** channels: the agent *receives* human messages, holds state across turns, and *replies* in the same conversation with platform-native affordances (threads, reactions, typing, file upload, inline buttons, rich blocks).

The **acceptance bar** from `SPEC_AND_PLAN.md §Phase 5`:

> Bidirectional conversation on each of the four channels with threads, reactions, typing indicators, and file upload demonstrated in a single demo session.

Four platforms, one contract, one rich-block renderer, one session model. This doc lays out the architecture, contracts, per-platform peculiarities, slice ordering, and the edges that bite (WhatsApp's 24-hour window, Discord's 3-second interaction ack, Slack's threading discipline, Telegram's MarkdownV2 escaping). Phase 5 is the first slice of the system where the **user experience** becomes part of correctness — a 400 from Meta at 2am is as real a failure mode as a dropped Kafka message.

---

## 1. Goals and non-goals

**Goals.**
- A `ChannelAdapter` contract that **extends** the Phase-4 `EventSourceAdapter` with outbound (`send`, `edit`, `delete`, `react`, `setTyping`, `uploadFile`) and a **capability negotiation** layer so skills can degrade gracefully when a platform lacks a feature.
- A `BaseChannelInstance` shared base that subclasses `BaseSourceInstance` — all Phase-4 reliability machinery (retry, DLQ, concurrency, circuit breaker, health, metrics) is reused; channels only add outbound concerns.
- A **unified rich-block renderer** in core that translates one `MessageContent` to four platform-native forms (Telegram MarkdownV2 + inline keyboards, Discord embeds + ActionRows, Slack Block Kit, WhatsApp interactive). Skills stay platform-agnostic.
- Four channel packages out of tree, each an optional `npm install`, zero channel runtime deps in core:
  - `@declaragent/channel-telegram` — long-polling + webhook, inline keyboards, files.
  - `@declaragent/channel-discord` — Gateway + Interactions, slash commands, threads, archived-thread auto-unarchive.
  - `@declaragent/channel-slack` — Socket Mode + Events API, Block Kit, threads, slash commands.
  - `@declaragent/channel-whatsapp` — Meta Cloud API, 24h window enforcement, approved-template registry, reply buttons.
- **Outbound bridge** that wires assistant turns back to the originating conversation: `ChannelOutboundBridge` subscribes to session output events and routes them through the adapter's `send()`. Idempotency-keyed per `(sessionId, turnId)` so retries don't double-send.
- `SendMessage` tool extended from Phase 3 to address channel destinations, for cross-channel skill work ("reply in the Slack thread that caused this Kafka event").
- **Conversation → session mapping** with three strategies (per-conversation default, per-user, ephemeral) and deterministic session-id derivation.
- **Identity + per-channel permissions**: each inbound event carries a `ChannelPrincipal`; the permission gate applies channel-specific allow/deny + per-user overrides from the channel config.
- **WhatsApp template registry**: `my-agent channel whatsapp templates` CLI for list/add/sync against the Meta Business API. Template approval takes days; starting applications on day 1 is part of the slice 10 timeline.
- **Declarative** `channels.yaml` alongside `event-sources.yaml`, same loader, same `${env:*}` / `${secret:*}` resolution.
- Observability: per-channel metrics (messages in/out, latency, rate-limit hits, send failures), per-conversation-window tracking (WhatsApp), and OTel spans stitched through the session correlation id.

**Non-goals (Phase 5).**
- **Voice in / voice out.** STT/TTS is a Phase-5.x polish (§8 of `COMMUNICATION_CHANNELS.md` milestone C8). Phase 5 treats voice notes as opaque file refs with a passthrough transcript-hook hook point; adapters deliver the audio, a skill or MCP tool does the transcription.
- **Discord sharding beyond one shard.** Adapter uses `discord.js` auto-sharding API but we don't test or support the 2,500-guild scale regime. Approval from Discord for privileged intents above 100 guilds is out of scope.
- **Slack Marketplace distribution.** Internal workspace + self-hosted bot only. Marketplace app review requires scope minimization + policy review that is a separate project.
- **WhatsApp group messaging.** 1:1 DMs only. Groups have a separate, more restricted API surface and the spec's examples target 1:1.
- **Cross-channel handoff** (example 10.3 of the background doc — "continue this in Slack"). A nice-to-have; defer to Phase 5.x once the four single-channel loops are solid.
- **Rich renderer round-tripping** for every block kind on every platform. We ship the core blocks (`heading`, `paragraph`, `code`, `button-row`, `divider`, `image`, `context`, `bulleted-list`) and degrade the rest to fallback text. Extending the block vocabulary is a post-v0.9 product call.
- **Multi-tenant channel isolation.** Phase 6 concern. Phase 5 carries `tenantId` through channel events (already threaded from Phase 4) but does not gate on it.
- **Managed control-plane integrations** (OAuth token vaulting for Slack app installation flows, Discord bot install flow as a service). Users register bots themselves in v0.9; managed install lands with the control plane.
- **Self-hosted Mastodon / Matrix / IRC / MS Teams.** Fifth+ channel adapters are Phase-5.x stretch.

---

## 2. Conceptual architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │                  EventBus                       │
                    │     (Phase 3, watermarks from Phase 4)          │
                    └──────────────────┬──────────────────────────────┘
                        ▲                    │
                inbound │                    │ subscribes
                  event │                    ▼
                        │       ┌─────────────────────────────┐
 ┌──────────────┐       │       │      EventDispatcher        │
 │  Telegram    │──┐    │       │  (Phase 3 + 4; unchanged)   │
 │ (telegraf)   │  │    │       └──────────────┬──────────────┘
 └──────────────┘  │    │                      │
                   │    │                      ▼
 ┌──────────────┐  │    │             ┌──────────────────┐
 │   Discord    │──┤    │             │  SessionManager  │
 │ (discord.js) │  │    │             │  (Phase 1 + 3)   │
 └──────────────┘  │    │             └────────┬─────────┘
                   │    │                      │
 ┌──────────────┐  │    │              assistant.message/.final
 │    Slack     │──┤    │                      │
 │  (@slack/bolt)│ │    │                      ▼
 └──────────────┘  │    │       ┌───────────────────────────────┐
                   │    └───────┤  ChannelOutboundBridge (NEW)  │
 ┌──────────────┐  │            │   (slice 2)                   │
 │   WhatsApp   │──┤            └────────┬──────────────────────┘
 │ (Meta Cloud) │  │                     │ routes back
 └──────────────┘  │                     ▼
                   │           ┌─────────────────────┐
           inbound │           │   ChannelInstance   │  send / edit /
                   └──────────►│   (adapter-specific)│  react / typing /
                               └──────────┬──────────┘  uploadFile
                                          │
                                          ▼
                                    platform API


Legend:  — Phase 3/4 spine reused unchanged
         * New Phase 5 components: ChannelAdapter, ChannelInstance,
           BaseChannelInstance, ChannelOutboundBridge, ChannelRegistry,
           RichBlock renderer, ConversationWindowTracker (WhatsApp)
```

**One contract, four personalities.** Every adapter's `create()` returns a `ChannelInstance extends EventSourceInstance`. Inbound is a Phase-4 source (the adapter subclass hands `RawMessage` to `BaseSourceInstance.handleMessage`). Outbound is new — a superset method set that the `ChannelOutboundBridge` drives.

**Phase 4 spine unchanged.** `BaseSourceInstance`, `MessageNormalizer`, `EventBus`, `EventDispatcher`, `SessionManager`, `ExtensionRegistry` — none are forked. The adapter packages depend on `@declaragent/core ^0.9.0`; core widens (`ChannelAdapter`, `ChannelInstance`) additively.

**Composition at daemon startup** (additions over Phase 4 §2):
1. Scan `node_modules/@declaragent/channel-*` → register adapter instances (reusing the adapter-discovery machinery from Phase 4 slice 4, matching on `declaragent.kind === 'channel-adapter'`).
2. Load `channels.yaml` (same loader as `event-sources.yaml`; see §9) → `ChannelConfig[]`.
3. For each channel: `adapter.validateConfig(config)` → `adapter.create(config, deps)` → `registry.register(instance)` → `channels.register(instance)` (a thin `ChannelRegistry` alongside the source registry, keyed on `id`).
4. Start `ChannelOutboundBridge` — subscribes to `assistant.message` + `assistant.final` + `channel.send.request` on the bus; resolves `ChannelRegistry` by `channelOrigin.channelId`; calls `send()`.
5. Graceful shutdown: per-channel `pause()` → drain inflight inbound → stop outbound bridge → `stop()` → exit. Inherits Phase-4 graceful-shutdown choreography.

---

## 3. Core contract changes

All additions are backward-compatible. New types live in `packages/core/src/channels/types.ts`; a small delta lands in `packages/core/src/events/types.ts` to widen `EventSourceTag` and `EventKind`.

### 3.1 Event taxonomy widening

```ts
// packages/core/src/events/types.ts — additions to EventKind union
export type EventKind =
  | /* existing Phase 1-4 kinds */
  | 'chat.message'           // plain user message
  | 'chat.mention'           // @bot mention in group/guild/channel
  | 'chat.dm'                // direct message
  | 'chat.voice'             // voice note (payload.audio: FileRef)
  | 'chat.file'              // attached file
  | 'channel.interaction'    // button click, select, modal submit
  | 'channel.command'        // slash command
  | 'channel.reaction'       // reaction added/removed (user on bot msg)
  | 'channel.presence'       // Discord presence update (opt-in)
  | 'channel.send.request'   // cross-channel out via SendMessage tool
  | 'channel.send.delivered'
  | 'channel.send.failed';

// additions to EventSourceTag union
export type EventSourceTag =
  | /* existing */
  | { type: 'telegram'; channelId: string; chatId: string; updateId: number }
  | { type: 'discord'; channelId: string; guildId?: string; channelDiscordId: string; messageId: string }
  | { type: 'slack'; channelId: string; teamId: string; channelSlackId: string; ts: string; threadTs?: string }
  | { type: 'whatsapp'; channelId: string; phoneNumberId: string; waId: string; messageId: string };
```

The `channelId` is the Declaragent-side instance id (e.g. `telegram-main`). Platform-specific ids stay on the tag — the dispatcher never interprets them; the outbound bridge uses them to reconstruct `ConversationRef`.

### 3.2 `ChannelAdapter`

```ts
// packages/core/src/channels/types.ts
import type { EventSourceAdapter, EventSourceInstance, SourceDependencies } from '../events/types.js';

export interface ChannelAdapter<C = unknown> extends EventSourceAdapter<C> {
  /** Declared before instantiation; immutable per adapter type. */
  readonly capabilities: ChannelCapabilities;
  create(config: C, deps: ChannelDependencies): Promise<ChannelInstance>;
}

export interface ChannelDependencies extends SourceDependencies {
  /** The shared channel registry; adapters that do cross-conversation work
   *  (WhatsApp window lookups, Discord DM fallback) read this.           */
  channels: ChannelRegistry;
  /** Optional persistent window-tracker store. Default: in-memory. */
  conversationStore?: ConversationStateStore;
}

export interface ChannelCapabilities {
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsTypingIndicator: boolean;
  supportsFileUpload: boolean;
  supportsVoice: boolean;
  supportsButtons: boolean;
  supportsEditMessage: boolean;
  supportsDeleteMessage: boolean;
  supportsPresence: boolean;
  supportsSlashCommands: boolean;
  supportsDMs: boolean;
  supportsGroupChats: boolean;
  supportsVoiceChannels: boolean;
  maxMessageLength: number;
  maxAttachmentBytes: number;
  /** WhatsApp only. */
  requiresTemplateForOutbound?: boolean;
  conversationWindowMs?: number;
}
```

### 3.3 `ChannelInstance`

```ts
export interface ChannelInstance extends EventSourceInstance {
  readonly capabilities: ChannelCapabilities;

  send(params: SendMessageParams): Promise<SentMessage>;

  setTyping?(conversation: ConversationRef, durationMs?: number): Promise<void>;
  react?(ref: MessageRef, emoji: string): Promise<void>;
  edit?(ref: MessageRef, content: MessageContent): Promise<void>;
  delete?(ref: MessageRef): Promise<void>;
  uploadFile?(file: FileUpload, conversation: ConversationRef): Promise<FileRef>;
  performAction?(action: ChannelAction): Promise<void>;

  /**
   * Out-of-band webhook delivery. The daemon's HTTP server calls this when
   * the platform's webhook endpoint is hit. Present on adapters in
   * webhook mode (WhatsApp; optional Telegram/Discord/Slack).
   */
  handleWebhook?(req: WebhookRequest): Promise<WebhookResponse>;
}

export interface SendMessageParams {
  conversation: ConversationRef;
  content: MessageContent;
  replyTo?: MessageRef;
  mentions?: readonly UserRef[];
  /** Required for idempotent retries. ChannelOutboundBridge supplies a
   *  `session:<id>:<turnId>:<seq>` key; custom callers supply their own. */
  idempotencyKey: string;
}

export interface SentMessage {
  id: string;
  conversation: ConversationRef;
  /** Timestamp the platform assigned (ms-epoch); optional. */
  sentAt?: number;
}

export interface ConversationRef {
  channelId: string;
  conversationId: string;
  threadId?: string;
  platformMeta?: Record<string, unknown>;
}

export interface MessageRef {
  conversation: ConversationRef;
  id: string;
}

export type MessageContent =
  | { kind: 'text'; text: string; format?: 'plain' | 'markdown' | 'html' }
  | { kind: 'rich'; blocks: readonly RichBlock[] }
  | { kind: 'template'; name: string; params: Readonly<Record<string, string>>; language?: string }
  | { kind: 'file'; file: FileRef; caption?: string }
  | { kind: 'voice'; audio: FileRef; durationSec?: number };

export type RichBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'bulleted-list'; items: readonly string[] }
  | { kind: 'button-row'; buttons: readonly Button[] }
  | { kind: 'divider' }
  | { kind: 'image'; url: string; alt?: string }
  | { kind: 'context'; text: string };

export interface Button {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
  url?: string;
}
```

### 3.4 `ChannelRegistry`

Thin lookup table, keyed by instance `id`. Lives at `packages/core/src/channels/registry.ts`.

```ts
export interface ChannelRegistry {
  register(instance: ChannelInstance): void;
  unregister(id: string): void;
  get(id: string): ChannelInstance | undefined;
  list(): readonly ChannelInstance[];
}
```

### 3.5 Session metadata: `channelOrigin`

Sessions that originate from a channel stamp their metadata with the origin `ConversationRef`. The outbound bridge reads this to route replies.

```ts
// additions to Phase 1's SessionMetadata
export interface SessionMetadata {
  // existing
  channelOrigin?: ConversationRef;
  channelPrincipal?: ChannelPrincipal;
}
```

### 3.6 `ChannelPrincipal` + identity mapping

```ts
export interface ChannelPrincipal {
  channelId: string;
  platformUserId: string;
  displayName?: string;
  /** Agent-user identity if the mapping is recorded; else undefined. */
  agentUserId?: string;
  scopes: readonly string[];
  verified: boolean;
  verifiedAt?: number;
}
```

The permission gate (Phase 1) grows one hook: `permissions.resolveForPrincipal(principal, config.permissions)` returns a merged allow/deny + per-user override set. Default resolver uses the channel config's `userOverrides` (glob match on `platformUserId`); plugins can register custom resolvers.

### 3.7 Outbound-bridge event kinds

`ChannelOutboundBridge` listens for two events:

- `assistant.message` — streamed assistant text for a running session. Optionally used for streaming mode (slice 8).
- `assistant.final` — the session's final reply for this turn. Used for the default buffered mode.

Both are emitted by the existing Phase-1 engine loop; slice 1 adds the thin emit at the point where `SessionManager` stores the assistant message. Channel-unaware sessions ignore them (the bridge drops events whose session has no `channelOrigin`).

---

## 4. `BaseChannelInstance` — shared outbound lifecycle

Lives at `packages/core/src/channels/base-channel.ts`. Subclasses `BaseSourceInstance` so every adapter gets Phase-4 reliability for free, and adds the outbound plumbing.

```ts
export abstract class BaseChannelInstance extends BaseSourceInstance implements ChannelInstance {
  abstract readonly capabilities: ChannelCapabilities;

  /** Per-(platform, conversation) outbound rate limiter. Token bucket. */
  protected outboundLimiter: OutboundRateLimiter;
  /** Idempotency cache for outbound sends; keyed on SendMessageParams.idempotencyKey. */
  protected sendIdempotency: SendIdempotencyCache;
  /** Optional — adapters that need per-conversation state (WhatsApp window). */
  protected conversationState?: ConversationStateStore;

  async send(params: SendMessageParams): Promise<SentMessage> {
    const existing = this.sendIdempotency.get(params.idempotencyKey);
    if (existing) return existing;

    await this.outboundLimiter.acquire(params.conversation.conversationId);
    const renderedContent = this.capabilitiesAwareRender(params.content);

    try {
      const sent = await this.doSend({ ...params, content: renderedContent });
      this.sendIdempotency.put(params.idempotencyKey, sent);
      this.counters.sendSuccess++;
      return sent;
    } catch (err) {
      this.counters.sendFailed++;
      if (isRateLimitError(err)) {
        const retryAfter = parseRetryAfter(err);
        await this.deps.clock.sleep?.(retryAfter);
        // Single retry; then surface.
        const sent = await this.doSend({ ...params, content: renderedContent });
        this.sendIdempotency.put(params.idempotencyKey, sent);
        return sent;
      }
      throw err;
    }
  }

  /** Capabilities-aware rendering. Drops unsupported blocks to fallback text. */
  protected capabilitiesAwareRender(content: MessageContent): MessageContent {
    if (content.kind !== 'rich') return content;
    const supported: RichBlock[] = [];
    const fallback: string[] = [];
    for (const block of content.blocks) {
      if (this.supportsBlock(block)) supported.push(block);
      else fallback.push(blockToFallbackText(block));
    }
    if (supported.length === 0) {
      return { kind: 'text', text: fallback.join('\n'), format: 'plain' };
    }
    if (fallback.length > 0) {
      supported.push({ kind: 'paragraph', text: fallback.join('\n') });
    }
    return { kind: 'rich', blocks: supported };
  }

  // Subclass contract: transport-specific outbound work.
  protected abstract doSend(params: SendMessageParams): Promise<SentMessage>;
  protected supportsBlock(block: RichBlock): boolean { /* default accepts all */ }
}
```

Key design notes:

- **One inbound + one outbound limiter.** Inbound piggybacks on `BaseSourceInstance.ConcurrencyLimiter`. Outbound has its own because platform rate limits are per-conversation / per-channel (Slack's Tier-1 1 msg/sec/workspace, Discord's 5/5s/channel, etc.) — not the same axes as inbound concurrency.
- **Idempotency on outbound is mandatory.** `SendMessageParams.idempotencyKey` is required (not optional) so retries from `ChannelOutboundBridge` or the `SendMessage` tool don't double-post. Cache TTL defaults to 10 minutes.
- **Single-retry on 429.** Deeper retry loops belong above (the bridge schedules its own retry budget); the base class handles exactly one immediate retry on the published `Retry-After` so the common case doesn't surface a transient rate limit to callers.
- **Rendering is idempotent + pure.** No network I/O during `capabilitiesAwareRender`; adapters that need network for rendering (fetching a WhatsApp media id, uploading an image) do it in `doSend`.

---

## 5. `ChannelOutboundBridge` + `SendMessage` tool integration

### 5.1 The bridge

```ts
// packages/core/src/channels/outbound-bridge.ts
export class ChannelOutboundBridge {
  constructor(
    private bus: EventBus,
    private sessions: SessionManager,
    private channels: ChannelRegistry,
    private metrics: MetricsRegistry,
    private logger: Logger,
  ) {}

  start(): () => void {
    const off1 = this.bus.subscribe('assistant.final', (e) => this.forwardFinal(e));
    const off2 = this.bus.subscribe('channel.send.request', (e) => this.forwardExplicit(e));
    const off3 = this.bus.subscribe('assistant.message', (e) => this.maybeStream(e));
    return () => { off1(); off2(); off3(); };
  }

  private async forwardFinal(event: AgentEvent) {
    const session = this.sessions.get(event.source.sessionId!);
    const origin = session?.metadata.channelOrigin;
    if (!origin) return;

    const channel = this.channels.get(origin.channelId);
    if (!channel) {
      this.logger.warn(`outbound: channel ${origin.channelId} not registered`);
      return;
    }

    const content = extractContent(event.payload);
    if (!content) return;

    await channel.send({
      conversation: origin,
      content,
      idempotencyKey: `session:${event.source.sessionId}:${event.id}`,
    });
  }
}
```

Streaming mode (slice 8) keeps a per-session message-id handle; the first `assistant.message` chunk fires a `send()`, subsequent chunks fire `edit()` until `assistant.final` lands. Adapters that don't support `edit` (WhatsApp) stay in buffered mode regardless of config — the bridge checks `capabilities.supportsEditMessage`.

### 5.2 `SendMessage` tool extension

Phase 3's `SendMessage` tool posts to the inter-agent mailbox. Phase 5 widens its `target` union so skills can proactively message a channel without being triggered by one (outbound bots, scheduled reminders, cross-channel handoff):

```ts
// packages/core/src/tools/send-message.ts — widened target
type SendMessageTarget =
  | { kind: 'mailbox'; agent: string }
  | { kind: 'channel'; channelId: string; conversationId: string; threadId?: string };
```

Channel targets get resolved through `ChannelRegistry` → `channel.send(...)`. Permission rule: `SendMessage:channel:<channelId>/*` — the permission gate scopes by channel id, matching the Phase 1 glob syntax. Default spec policy denies channel writes unless explicitly allowed (channels are higher-blast-radius than the mailbox).

### 5.3 Turn lifecycle + typing indicator

```
bus:user.input          ──► session receives
                              │
                              ├─ emit `turn.started` ───► bridge ──► channel.setTyping()
                              │
                              ├─ engine runs, produces tool calls, …
                              │
                              ├─ emit `assistant.message` (first delta) ─► bridge stops typing
                              │                                            (typing is stale once text appears)
                              │
                              └─ emit `assistant.final` ────────────► bridge ──► channel.send()
```

Typing is **always** driven by the bridge, never by the skill. Skills don't need to know typing exists.

---

## 6. Unified rich-block renderer

Lives at `packages/core/src/channels/renderer/`. Four platform renderers + one dispatcher:

```
renderer/
├── index.ts              # dispatcher: (content, targetCaps) => rendered
├── telegram.ts           # MarkdownV2 escaper + inline keyboard builder
├── discord.ts            # embeds + ActionRow components
├── slack.ts              # Block Kit converter
├── whatsapp.ts           # interactive messages (reply buttons, list)
├── fallback.ts           # plain-text + monospace code fence
├── escape-markdown-v2.ts # Telegram's ruthless punctuation escape set
├── block-kit-validator.ts# Slack blocks schema sanity
└── __tests__/            # per-renderer unit tests (colocated)
```

### 6.1 Dispatcher

```ts
export interface RendererContext {
  capabilities: ChannelCapabilities;
  maxMessageLength: number;
  /** Already-uploaded file ids that can be reused without reupload. */
  fileCache: FileRefCache;
}

export interface PlatformPayload {
  kind: 'text' | 'rich' | 'template' | 'file' | 'voice';
  /** Transport-agnostic placeholder; the adapter interprets these. */
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  replyMarkup?: unknown;
  [extra: string]: unknown;
}

export function renderFor(
  platform: 'telegram' | 'discord' | 'slack' | 'whatsapp',
  content: MessageContent,
  ctx: RendererContext,
): PlatformPayload;
```

The dispatcher also handles **long-message splitting**: if rendered text exceeds `capabilities.maxMessageLength`, split on paragraph boundaries, suffix `(1/N)`, `(2/N)`. If splitting would fragment a code block or button row, route to the fallback file-upload path (see §7.4 of the background doc).

### 6.2 Telegram MarkdownV2 escape

Non-trivial. The spec enumerates `_ * [ ] ( ) ~ ` > # + - = | { } . !` as characters that must be backslash-escaped **everywhere outside code blocks**. Inside code blocks, only `` ` `` and `\` need escaping. Slice 4 ships:

- An AST-driven escaper that knows about fenced code blocks and inline code — no "regex-replace the whole string" shortcut (that double-escapes inside backticks).
- A fuzz test harness feeding 10k random message strings, asserting the Telegram Bot API accepts every produced string on a test bot.
- A debug helper: `declaragent channel telegram escape-test "<text>"` that prints the escaped form + cURLs the `getMe` + `sendMessage` (dry) to validate.

### 6.3 Capability-aware degradation matrix

| Block kind        | Telegram        | Discord            | Slack                 | WhatsApp              |
|-------------------|-----------------|--------------------|-----------------------|-----------------------|
| `heading`         | `*bold*` line   | embed title        | header block          | `*bold*` line         |
| `paragraph`       | native          | embed description  | section mrkdwn        | native                |
| `code`            | triple-backtick | triple-backtick    | mrkdwn fenced         | plain (WA no mono)    |
| `bulleted-list`   | `• ` prefix     | bullet in description | section with bullets | `• ` prefix           |
| `button-row` (≤3) | inline keyboard | ActionRow          | actions block         | reply buttons         |
| `button-row` (4+) | multi-row kb    | ActionRow + overflow | actions block (≤5)  | list message          |
| `divider`         | `\n—\n`         | embed separator    | divider block         | `\n—\n`               |
| `image`           | sendPhoto       | embed image        | image block           | media message         |
| `context`         | italic line     | embed footer       | context block         | italic line           |

WhatsApp's 3-button cap is enforced in `renderer/whatsapp.ts`: if a button-row has more than 3 entries, degrade to a list-message (up to 10 rows). More than 10 rows → fallback to numbered text `(1) Option A / (2) Option B / …` and surface a warning in the logs.

---

## 7. Adapter packages

Each adapter is its own npm package — zero channel runtime deps in core. Peer deps on `@declaragent/core ^0.9.0`.

### 7.1 Package layout (applies to all four)

```
@declaragent/channel-<platform>/
├── package.json
│   peerDeps: @declaragent/core
│   deps: the transport SDK
│   declaragent:
│     kind: channel-adapter
│     type: <platform>
│     agent_compat: >=0.9.0 <2.0.0
├── src/
│   ├── index.ts                   # default export: ChannelAdapter instance
│   ├── adapter.ts                 # class XxxChannelAdapter
│   ├── instance.ts                # class XxxChannelInstance extends BaseChannelInstance
│   ├── config.ts                  # Zod schema for XxxChannelConfig
│   ├── capabilities.ts            # ChannelCapabilities constant
│   ├── outbound/
│   │   ├── text.ts
│   │   ├── rich.ts                # uses core renderer + platform specifics
│   │   ├── file.ts
│   │   └── interactive.ts
│   ├── inbound/
│   │   ├── message.ts
│   │   ├── interaction.ts
│   │   └── command.ts
│   └── platform-client.ts         # thin wrapper over the SDK or HTTP
└── test/
    ├── instance.test.ts           # pure unit tests (no network)
    ├── contract.test.ts           # @declaragent/testkit adapter-contract suite
    └── integration.test.ts        # gated by env; uses sandbox
```

### 7.2 `@declaragent/channel-telegram` (slice 5)

- SDK: `telegraf` (MIT, actively maintained, small).
- Transport: long-polling (default) + webhook mode (selected by config).
- Capabilities: threads **off** (topics in supergroups are a Phase-5.x optional), reactions on (since Bot API 7.0), typing on, files up to 50MB via bot API.
- Inbound handlers: `message`, `edited_message`, `callback_query` (→ `channel.interaction`), any-text starting with `/` (→ `channel.command`).
- Outbound: `sendMessage` with `parse_mode: MarkdownV2`, inline keyboards; `sendDocument` / `sendPhoto` / `sendVoice`; `setMessageReaction` (v7+).
- `file_id` cache: once Telegram returns a `file_id` for an upload, subsequent sends of the same ref short-circuit. Cache lives in the adapter's local state (in-memory + optional sqlite pass-through via `conversationStore`).
- Privacy mode: adapter logs a startup warning if `getMe` reports `can_read_all_group_messages: false` — the user must disable privacy in BotFather for group use.
- Webhook mode: uses the core's existing Phase-3 HTTP server (the webhook source already owns port 8787 by default); adapter registers a route `/channels/<id>/webhook` and verifies Telegram's secret token header.

### 7.3 `@declaragent/channel-discord` (slice 6)

- SDK: `discord.js` v14.
- Transport: Gateway WebSocket for events + REST for sends + optional interactions HTTP endpoint.
- Intents: minimal set by default (`Guilds`, `GuildMessages`, `DirectMessages`, `GuildMessageReactions`). `MessageContent` and `GuildPresences` are privileged — adapter throws a startup error if config requests them without `transport.intents.privileged: true` (the acknowledgment flag noted in resolved gap §13).
- Capabilities: threads, reactions, typing (10-second auto-expire; refreshed every 8s when session is active), files up to 25MB, buttons via ActionRow.
- Interactions: 3-second ack rule is a hard invariant. Adapter immediately calls `deferReply()` on every interaction; actual content arrives as a follow-up via REST. The bridge posts the eventual reply as an `editReply()`, not a new `send()`, because the interaction token is how Discord attaches the bot's reply to the user's click.
- Slash commands: registered once at startup (global if no guild is configured; guild-scoped if `guildIds: [...]` is set). Skip re-registration if the command manifest hasn't changed — cache the command set's content hash in the `conversationStore`.
- Archived threads: the channel's auto-unarchive hook (resolved gap §9) sits in `outbound/rich.ts`. Before a send, if the target thread has `archived: true`, adapter calls `threads.setArchived(false)`; if that fails (archive-locked), fallback to a parent-channel reply containing a cross-link. Configurable per-channel: `archivedThreadPolicy: 'unarchive' | 'parent-reply' | 'drop'`.

### 7.4 `@declaragent/channel-slack` (slice 7)

- SDK: `@slack/bolt` (Socket Mode + Events API).
- Transport: Socket Mode (default — no public URL) + Events API (webhook-style; reuses core HTTP server).
- Capabilities: threads, reactions, no native typing (documented limitation — `setTyping` becomes a no-op; capabilities negotiate it off), Block Kit buttons.
- Thread discipline: if the inbound event had a `thread_ts`, the bridge stamps it on `channelOrigin.threadId` — all replies go in-thread. If `@mentioned` in a channel without a thread, the adapter's policy knob decides (`threadOnMention: always | never | auto` — default `auto`, which threads replies if the channel has >10 recent messages).
- Block Kit validation: slice 4's validator (see §6) runs pre-send and raises a typed error pointing at the offending block path (e.g., `blocks[2].accessory.text` too long). Saves hours of debugging Slack's terse 400s.
- Scopes: adapter declares required scopes in a `scopes.ts` constant; startup call to `auth.test` compares granted scopes against required; missing scope logs an actionable error with the Slack admin URL.
- Slash commands: `manifestHint` in config emits a YAML the user pastes into their Slack app manifest. Slack doesn't allow programmatic slash-command registration.
- `text` fallback: `chat.postMessage` always includes a plain-text summary alongside `blocks` (Slack's notification-delivery requirement).

### 7.5 `@declaragent/channel-whatsapp` (slice 8)

The hardest of the four. Budget as two normal slices.

- Transport: Meta WhatsApp Cloud API (Graph API v18+). No SDK — hand-rolled HTTPS client in `platform-client.ts` (the only sane option; third-party SDKs have spotty maintenance).
- Capabilities: no threads, reactions on (via `/messages` with `type: reaction`), no typing, files via media-upload flow, 3 buttons / 10 list rows, templates mandatory outside 24h window.
- **Conversation window tracker**: `ConversationWindowTracker` class in `instance.ts`. Keyed by `waId` (WhatsApp user id). Incoming message resets the window-end to `Date.now() + 86_400_000`. Persisted via `conversationStore` (default sqlite) so window state survives daemon restart.
- **Policy enforcement**: on every `doSend`, check window; if outside window and content.kind !== 'template', apply policy (`template` | `queue` | `drop`). Adapter surfaces the decision in a typed error or a queued-for-next-inbound acknowledgement; the skill author sees a deterministic `WhatsAppOutsideWindowError`.
- **Template registry**: `my-agent channel whatsapp templates` CLI (slice 11) talks to Meta Business API to list/create/sync templates. Template status (`approved`, `pending`, `rejected`) is cached locally; `template` content kind validates the name + param count pre-send.
- **Webhook verification**: HMAC SHA-256 on `X-Hub-Signature-256` using the `webhookAppSecret`. Timing-safe compare (lines up with the Phase 6 security audit).
- **Media URLs expire in ~5 minutes** — adapter downloads any inbound media immediately and stores a base64/url-safe ref on the event. Cached in the file-ref cache for re-upload on outbound.
- **Tier management**: adapter exposes `health.details.tier` and `health.details.dailyRemaining` via a periodic Graph API poll. Phase 5 does not automate tier upgrade requests.
- **Group messages**: explicitly rejected at config validation time: `groupMode` is not supported in v0.9. Non-negotiable.

---

## 8. Conversation → session mapping

### 8.1 Session-id derivation

Deterministic, pure function in `packages/core/src/channels/session-id.ts`:

```ts
export function conversationSessionId(ref: ConversationRef): string {
  const parts = ['chat', ref.channelId, ref.conversationId, ref.threadId ?? 'main'];
  return parts.join(':');
}
```

Example keys:
- `chat:telegram-main:-1001234567:main`
- `chat:slack-prod:C07ABC123:1702345678.001234`
- `chat:discord-guild:987654:thread-111`
- `chat:whatsapp-cloud:15555551212:main`

Three built-in mappers ship (selected by config):

```yaml
sessionStrategy: per-conversation   # default — one session per (channel, conv, thread)
# sessionStrategy: per-user         # one session per (channel, platformUserId)
# sessionStrategy: ephemeral        # fresh session per message
```

### 8.2 Cold start vs warm session

Dispatcher-side logic (reused from Phase 3):

- Session-id resolves; `SessionManager.get(id)` returns an instance or undefined.
- Undefined → `onMissing: spawn` in the target selector; a new session is created, `metadata.channelOrigin` stamped from the normalize context, session's initial prompt comes from the channel config's `initialPrompt` (or the message itself if unset).
- Defined + idle → inject the message; run a turn.
- Defined + busy (mid-turn) → `action: queue` holds the message until turn end; `replace` is rejected with a warning (channel sessions are never "replaced").

### 8.3 Archival

Phase-1 session archival (`/compact` and idle timeout) applies. A channel session archived by idle timeout reloads on the next inbound message in the same conversation. The `channelOrigin` is preserved through archival so the outbound bridge can still route replies.

### 8.4 Routing config

Uses the Phase-4 `RoutingConfig` verbatim; Phase 5 ships a helper so configs don't have to spell out the JSONPath:

```yaml
- id: slack-prod
  type: slack
  # ...
  routing:
    kindSelector:
      switch:
        - { when: "$.event.type == 'app_mention'", value: "chat.mention" }
        - { when: "$.event.channel_type == 'im'", value: "chat.dm" }
        - { when: "$.event.type == 'message'", value: "chat.message" }
    targetSelector:
      type: session
      sessionIdFrom: "${channel:conversationSessionId}"   # built-in variable
      action: inject
      onMissing: spawn
      spawnConfig:
        initialPrompt: "You are a helpful assistant on Slack."
```

`${channel:conversationSessionId}` is a pseudo-variable expanded by the loader to the result of calling `conversationSessionId` on the adapter-supplied ref. Adapters are responsible for building the `ConversationRef` before handing the raw message to the normalizer; it's stashed in `raw.meta.__channelRef` and the pseudo-variable reads from there.

---

## 9. Declarative configuration

`channels.yaml` sits next to `event-sources.yaml`. Same loader, same schema-per-type, same secret resolver.

```yaml
version: 1
channels:
  - id: telegram-main
    type: telegram
    transport:
      mode: long-polling         # or: webhook
      botToken: "${secret:telegram_bot_token}"
      webhookUrl: "https://agent.example.com/channels/telegram/webhook"
      webhookSecret: "${secret:telegram_webhook_secret}"
    routing:
      kindSelector: { const: "chat.message" }
      targetSelector:
        type: session
        sessionIdFrom: "${channel:conversationSessionId}"
        action: inject
        onMissing: spawn
    delivery:
      mode: at-least-once
      ackStrategy: after-publish
      maxRetries: 3
      retryBackoff: { initialMs: 500, maxMs: 10_000, jitter: true }
      idempotency: { strategy: header, ttlMs: 3_600_000, store: sqlite }
    limits:
      concurrency: 4
      maxInflight: 20
      outbound:
        perConversationPerSec: 1
        globalPerSec: 20
    permissions:
      mode: auto
      allow: ["Read(**/*)", "mcp__calendar__*"]
      deny: ["Bash(*)", "Edit(**/*)"]
      userOverrides:
        - platformUserIdPattern: "admin-*"
          allow: ["*"]

  - id: slack-prod
    type: slack
    transport:
      mode: socket
      appToken: "${secret:slack_app_token}"
      botToken: "${secret:slack_bot_token}"
      signingSecret: "${secret:slack_signing_secret}"
      events: [app_mention, message.channels, message.im, reaction_added]
    threadOnMention: auto
    routing: { /* ... */ }
    delivery: { /* ... */ }
    limits: { /* ... */ }

  - id: discord-main
    type: discord
    transport:
      botToken: "${secret:discord_bot_token}"
      applicationId: "1234567890"
      intents: [Guilds, GuildMessages, DirectMessages, GuildMessageReactions]
      privileged: false
      sharding: auto
    archivedThreadPolicy: unarchive
    slashCommands:
      - { name: "agent", description: "Talk to the agent" }
    routing: { /* ... */ }

  - id: whatsapp-cloud
    type: whatsapp
    transport:
      provider: meta-cloud
      phoneNumberId: "123456789012345"
      businessAccountId: "987654321"
      accessToken: "${secret:whatsapp_access_token}"
      webhookVerifyToken: "${secret:whatsapp_verify_token}"
      webhookAppSecret: "${secret:whatsapp_app_secret}"
    policy:
      enforceConversationWindow: true
      outsideWindowAction: template   # or: queue | drop
      defaultTemplate: "checkin_reminder_v1"
    templates:
      - name: "appointment_reminder_v1"
        language: "en_US"
        parameterNames: ["customer_name", "date", "time"]
    routing: { /* ... */ }
    delivery:
      idempotency: { strategy: header, ttlMs: 7_200_000, store: sqlite }
```

Each adapter exports its Zod schema; the loader composes them keyed on `type`. Unknown `type` → `ConfigError: unknown channel adapter '<type>' (installed: [telegram, slack, ...])`.

---

## 10. Observability

Every channel inherits Phase-4 metrics (`messages.received`, `.processed`, `.failed`, `.dlq`, `inflight`, `process.duration_ms`, `connection.errors`). Phase 5 adds channel-specific:

```
channel.outbound.sent{id=…,type=…}              counter
channel.outbound.edited{…}                      counter
channel.outbound.failed{…,reason=…}             counter   (429 | 4xx | 5xx | timeout)
channel.outbound.latency_ms{…}                  histogram
channel.typing.sent{…}                          counter
channel.reactions.sent{…}                       counter
channel.rate_limit.hits{…}                      counter
channel.conversation_window.active{…}           gauge     (WhatsApp; #active windows)
channel.conversation_window.expired{…}          counter
channel.template.sent{…,name=…,status=…}        counter   (WhatsApp)
channel.interaction.received{…,kind=…}          counter
channel.session.spawned{…}                      counter
channel.session.warm_hit{…}                     counter
```

Tracing:

```
span: channel.inbound
  channel.id, channel.type, conversation.id, message.id
    span: dispatcher.handle (Phase 4)
      span: engine.runAgent (Phase 1)
        span: channel.outbound       ← outbound-bridge-issued send
           channel.id, conversation.id, content.kind, latency_ms
```

The outbound span is linked, not nested, because it emits on a different turn of the bus loop; OTel link semantics preserve the correlation.

Grafana dashboards shipped in `packages/testkit/dashboards/channels.json` — panels per channel type, plus a cross-platform conversation-latency heatmap.

---

## 11. Reliability + rate limiting

### 11.1 `OutboundRateLimiter`

Token-bucket, two-tier:

- Per-conversation bucket: default 1 msg/sec per conversationId (every channel), prevents spammy loops.
- Per-channel global bucket: default tuned per platform (see table below).

```ts
export class OutboundRateLimiter {
  acquire(conversationId: string): Promise<void>;
  // Backed by two rate-limiter classes: per-channel + per-conversation.
}
```

Default global caps match published platform limits:

| Platform  | Global cap                 | Notes                                        |
|-----------|----------------------------|----------------------------------------------|
| Telegram  | 20 msg/s                   | 30 msg/s is Telegram's cap; 20 buffers for bursts |
| Discord   | 50 msg/s                   | REST bucket; ActionBar 5/5s per channel      |
| Slack     | 1 msg/s/workspace          | Tier-1 `chat.postMessage`                     |
| WhatsApp  | tier-dependent (1 msg/s default) | Adjust via `limits.outbound.globalPerSec`  |

### 11.2 429 handling

Every adapter surfaces rate-limit errors through a tagged class (`isRateLimitError(err)`). `BaseChannelInstance.send()`'s single-retry handles transient 429s; persistent 429s propagate to `ChannelOutboundBridge` which falls into a backoff queue.

### 11.3 Circuit breaker per channel

Inherits from Phase 4's `CircuitBreaker`. Per-channel thresholds: default `failureThreshold: 10`, `halfOpenAfterMs: 30_000`. When a channel's breaker opens, `setTyping` + `send` become immediate no-ops (logged) rather than queue-building; the bridge emits `channel.send.failed` with `reason: 'breaker-open'` so skills can detect.

### 11.4 Idempotency on outbound

`SendMessageParams.idempotencyKey` is mandatory; `SendIdempotencyCache` de-dupes within a TTL (default 10 min). Key conventions:

- Bridge-issued: `session:<sessionId>:<eventId>`.
- `SendMessage` tool: `tool:<invocationId>:<seq>`.
- External caller (HTTP control plane): caller-supplied.

The cache is in-memory by default; adapters that need cross-restart idempotency point to the sqlite-backed `conversationStore` (essential for Discord interactions, where a restart during a 15-minute interaction window would otherwise duplicate `editReply` calls).

### 11.5 Backpressure on outbound

The bus's Phase-4 high/low watermarks apply to outbound-triggering events (`assistant.final`). When the bus is under pressure, the bridge pauses new outbound work and drains; typing indicators are always sent, never queued (they're cheap and user-visible).

---

## 12. Identity, permissions, audit

### 12.1 Principal construction

Each inbound event carries a `ChannelPrincipal` on `event.meta.principal` (new field, additive on `AgentEventMeta`). The adapter populates it from the platform user record:

- Telegram: `from.id`, `from.first_name`, `from.username`.
- Discord: `author.id`, `author.username`, `member.roles` → `scopes`.
- Slack: `user.id`, cached `users.info` → `scopes` from Slack team scopes.
- WhatsApp: `wa_id`, `profile.name` if in window.

### 12.2 Permission resolution

`PermissionGate.resolveForChannel(principal, channelConfig.permissions)` returns an allow/deny rule set. Resolution order:

1. Channel's `deny` rules — hardest wins.
2. `userOverrides` matching by `platformUserIdPattern` — longest match first.
3. Channel's `allow` rules.
4. Fallback to spec-level permissions.

The session's `metadata.channelPrincipal` is carried; every tool call's `PermissionContext` has access to it so `Bash:git *` (allowed at spec level) can be further denied when invoked from `@random-user-in-slack`.

### 12.3 Audit

Every channel-originated event emits an audit entry:

```
channel_event | ts=… | channel=slack-prod | user=U12345 | conv=C67890 | kind=chat.mention | correlation=…
channel_tool_call | ts=… | channel=slack-prod | user=U12345 | tool=Bash | cmd="git status" | outcome=allowed
channel_outbound | ts=… | channel=slack-prod | conv=C67890 | msg_id=… | content_kind=text | latency_ms=240
```

Audit rows go through the Phase-1 audit log; Phase-6 hardening formalizes tamper-evidence.

### 12.4 Enrollment flow (deferred but scaffolded)

A `ChannelEnroller` hook point is reserved in slice 1: an interface for mapping `platformUserId → agentUserId` via an out-of-band flow (DM the bot, receive an auth code, confirm in the CLI). v0.9 ships the hook point + a stub "allow-list via config" resolver; the OAuth-style flow lands with the managed control plane post-v1.0.

---

## 13. Slice breakdown

Phase-3/4 approach: thin vertical slices, each independently mergeable.

### Slice 1 — `ChannelAdapter` contract + `ChannelRegistry` + event taxonomy (~2 days)
- Add types in `packages/core/src/channels/types.ts`
- Widen `EventKind`, `EventSourceTag`, `AgentEventMeta.principal`
- `ChannelRegistry` impl + tests
- `channelOrigin` field on `SessionMetadata`
- Stub `ChannelEnroller` interface + config-driven allow-list resolver
- Tests: registry lifecycle, duplicate-id rejection, session metadata round-trip

### Slice 2 — `BaseChannelInstance` + `ChannelOutboundBridge` (~3 days)
- `BaseChannelInstance` subclassing `BaseSourceInstance`
- `OutboundRateLimiter` (two-tier token bucket)
- `SendIdempotencyCache` (in-memory + sqlite-backed)
- `ChannelOutboundBridge` with buffered mode only (streaming deferred to slice 13)
- Engine emits `assistant.final` on turn completion (small addition to Phase-1 session loop)
- Tests: fake-channel subclass exercises send + retry + idempotency; bridge routes final to correct channel; missing channel logs warn + drops

### Slice 3 — Channel discovery + loader (~2 days)
- Reuse Phase-4 `adapter-discovery` with `kind: 'channel-adapter'`
- `channels.yaml` loader (reuses Phase-4 config-loader; zod-per-adapter-type)
- `${channel:conversationSessionId}` pseudo-variable expansion
- `declaragent channels list` + `declaragent channels validate <path>` CLI
- Tests: multi-channel config round-trip, missing-adapter fail-fast, schema conflict diagnostics

### Slice 4 — Unified rich-block renderer (~3 days)
- `packages/core/src/channels/renderer/` — four platform renderers + fallback + dispatcher
- MarkdownV2 escaper with AST-aware code-block handling (Telegram)
- Block Kit validator (Slack)
- ActionRow splitter with ≤5-button rows (Discord)
- Degradation matrix (§6.3) enforced
- Long-message splitter with paragraph-boundary preference + `(k/N)` suffix
- Tests: per-renderer unit tests for each block kind; fallback behavior; splitter never fragments code blocks; WhatsApp >3 buttons → list-message; fuzz MarkdownV2 (`tests/fuzz/markdown-v2.ts`, 10k random strings)

### Slice 5 — `@declaragent/channel-telegram` (~4 days)
- `telegraf` integration
- Long-polling + webhook transport modes
- Inbound: message / edited_message / callback_query / command
- Outbound: text / rich / file / voice / reactions
- Typing indicator (re-send every 4s while active)
- `file_id` cache
- Privacy-mode startup warning
- Tests:
  - Contract conformance (adapter-contract suite from `packages/testkit/src/contract.ts`, widened in slice 12)
  - Integration: test bot against a real `api.telegram.org` using `BOT_TOKEN=…` in env; gated
  - Fuzz: escape 10k random strings, assert `sendMessage` dry-run accepts all

### Slice 6 — `@declaragent/channel-discord` (~5 days) ★
- `discord.js` v14 integration
- Gateway intents (default + privileged-opt-in)
- Slash command registration (content-hashed; re-register only on drift)
- Inbound: `messageCreate` / `interactionCreate` / `threadDelete` / archive events
- Outbound: text / rich (embed + ActionRow) / file / reactions
- Archived-thread auto-unarchive with per-channel policy
- Interaction 3-second ack: immediate `deferReply()`, follow-up via `editReply()`
- Tests: contract conformance; integration against a real test guild (`DISCORD_BOT_TOKEN` + `DISCORD_TEST_GUILD_ID` env); archived-thread behavior on a test thread

### Slice 7 — `@declaragent/channel-slack` (~5 days)
- `@slack/bolt` integration
- Socket Mode (default) + Events API mode
- Inbound: `app_mention` / `message` / `reaction_added` / action handlers / slash commands
- Outbound: always include `text` fallback + blocks; thread discipline
- Scope preflight: compare `auth.test` scopes to required list
- Slack app manifest hint in `declaragent channels validate` output
- Tests: contract conformance; integration against a real test workspace (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`)

### Slice 8 — `@declaragent/channel-whatsapp` (~7 days) ★★
- Meta Cloud API client (hand-rolled HTTPS)
- Webhook verification (HMAC SHA-256; timing-safe compare)
- Inbound: `messages.text` / `messages.button` / `messages.interactive` / `messages.reaction` / `messages.media`
- Outbound: text / template / interactive (reply buttons, list) / file / reaction
- `ConversationWindowTracker` (sqlite-backed)
- `outsideWindowAction` policy enforcement (template | queue | drop)
- Media download pipeline (5-min URL window → local re-host)
- Tier polling (`/phone_numbers/{id}` health details)
- Tests: contract conformance; integration against Meta's sandbox number (`WA_PHONE_ID`, `WA_ACCESS_TOKEN`); window-expiry behavior

### Slice 9 — Identity + per-user permission overrides (~3 days)
- `PermissionGate.resolveForChannel`
- `userOverrides` glob-matching resolver
- `ChannelPrincipal` stamped onto all inbound events + session metadata
- Audit logging for channel events + tool calls
- Tests: overrides beat base rules; longest-match precedence; denied tool surfaces typed error to the session

### Slice 10 — WhatsApp template registry CLI (~3 days)
- `declaragent channel whatsapp templates list [--id <channel-id>]`
- `declaragent channel whatsapp templates add <name> --language <code> --body <string> [--buttons ...]`
- `declaragent channel whatsapp templates sync` (pulls current Meta state into local cache)
- Template validation pre-send: name exists, approved status, param count matches
- Tests: CLI integration against Meta sandbox; rejected templates surface clean error

### Slice 11 — `SendMessage` tool channel target (~2 days)
- Widen `SendMessageTarget` to include `kind: 'channel'`
- Permission rule: `SendMessage:channel:<channelId>/*`
- Default spec denies channel target; explicit allowlist required
- Tests: tool-call → `ChannelRegistry` → `send`; permission denied path; idempotency key passed through

### Slice 12 — Channel contract conformance suite (~2 days)
- Extend `packages/testkit/src/contract.ts` with `channelContractSuite(factory)` — every Phase-5 adapter runs it
- Asserts: capabilities declared, inbound → `AgentEvent` shape, outbound send + edit + delete + react (if supported) + typing (if supported), idempotency cache, rate-limit error typing
- Mock channel adapter in `packages/testkit/src/mock-channel.ts` for downstream test use (skill authors test against it)

### Slice 13 — Streaming mode + typing-indicator lifecycle (~2 days) (optional)
- `ChannelOutboundBridge` streaming mode: first `assistant.message` → `send`; subsequent → `edit`
- Gated per channel: `capabilities.supportsEditMessage` + `config.streaming: true`
- Typing indicator starts on `turn.started`, stops on first `assistant.message`
- Tests: mock channel asserts one send + N edits for a streamed turn; typing lifecycle timing

### Slice 14 — Observability hooks + Grafana dashboards (~2 days)
- Channel-specific metrics emission in `BaseChannelInstance`
- Tracing spans on `send`/`edit`/`react`
- Grafana dashboards: `channels.json` + `whatsapp-windows.json`
- Tests: mock metrics backend + assertion harness

### Slice 15 — Load test + acceptance demo (~3 days)
- `packages/testkit/src/load/channel.ts` — synthetic conversation generator for each platform (mocks the SDKs, not the adapter)
- Acceptance demo script (`examples/phase5-demo/`): one skill (`concierge`) registered against all four channels, with scripted asserts that on each channel the bot receives a message, threads or reacts, types, sends a file, and replies
- Real-platform integration run (gated by env): demo against real test Telegram + Discord + Slack + WhatsApp sandbox

**Critical path:** 1 → 2 → 3 → 4 → {5 ∥ 6 ∥ 7 ∥ 8} → 9 → 12 → 15. Slices 10, 11, 13, 14 land any time after slice 2.

**Total estimate:** ~48 days of focused work, ~6–7 weeks for one engineer; ~5 weeks with two engineers parallelizing slices 5/6/7/8. Matches the spec's 5–7 week guidance for Phase 5.

---

## 14. File layout

```
packages/core/src/
├── channels/
│   ├── types.ts                     # slice 1
│   ├── registry.ts                  # slice 1
│   ├── registry.test.ts
│   ├── session-id.ts                # slice 1
│   ├── session-id.test.ts
│   ├── base-channel.ts              # slice 2
│   ├── base-channel.test.ts
│   ├── outbound-bridge.ts           # slice 2
│   ├── outbound-bridge.test.ts
│   ├── outbound-rate-limiter.ts     # slice 2
│   ├── send-idempotency.ts          # slice 2
│   ├── conversation-store.ts        # slice 2 (sqlite-backed, reused)
│   ├── identity.ts                  # slice 9 (resolveForChannel)
│   ├── identity.test.ts
│   ├── enroller.ts                  # slice 1 (stub); full impl post-v1.0
│   └── renderer/
│       ├── index.ts                 # slice 4
│       ├── telegram.ts
│       ├── discord.ts
│       ├── slack.ts
│       ├── whatsapp.ts
│       ├── fallback.ts
│       ├── escape-markdown-v2.ts
│       ├── block-kit-validator.ts
│       ├── splitter.ts
│       └── *.test.ts
├── events/
│   └── types.ts                     # slice 1 widens EventKind, EventSourceTag
├── session/
│   └── index.ts                     # slice 1 adds channelOrigin field
├── tools/
│   └── send-message.ts              # slice 11 widens target
└── permission/
    └── index.ts                     # slice 9 resolveForChannel hook

packages/channel-telegram/           # slice 5
├── package.json
├── src/{index,adapter,instance,config,capabilities,platform-client}.ts
├── src/outbound/{text,rich,file,interactive}.ts
├── src/inbound/{message,interaction,command}.ts
├── src/instance.test.ts
├── test/contract.test.ts
└── test/integration.test.ts

packages/channel-discord/            # slice 6
packages/channel-slack/              # slice 7
packages/channel-whatsapp/           # slice 8

packages/cli/src/
├── channels-cli.ts                  # slice 3: list, validate
├── channels-cli.test.ts
└── whatsapp-templates-cli.ts        # slice 10

packages/testkit/
├── src/
│   ├── contract.ts                  # slice 12 extends with channelContractSuite
│   ├── mock-channel.ts              # slice 12
│   └── load/channel.ts              # slice 15
├── dashboards/
│   ├── channels.json                # slice 14
│   └── whatsapp-windows.json        # slice 14
└── ...

examples/phase5-demo/                # slice 15
├── agent.yaml
├── channels.yaml
├── skills/concierge.md
└── README.md
```

---

## 15. Touch points into existing code

Phase 5 is less intrusive on the Phase-4 spine than Phase 4 was on Phase 3, but it touches the Phase-1 session loop in one small place.

- `packages/core/src/events/types.ts` — widened `EventKind`, `EventSourceTag`, `AgentEventMeta.principal` (slice 1).
- `packages/core/src/session/index.ts` — `SessionMetadata.channelOrigin`, `channelPrincipal` fields (slice 1); session loop emits `assistant.final` event on turn completion (slice 2, ~20-line change).
- `packages/core/src/tools/send-message.ts` — widened `SendMessageTarget` union; channel permission check (slice 11).
- `packages/core/src/permission/index.ts` — `resolveForChannel` hook + per-user override resolver (slice 9).
- `packages/core/src/events/daemon.ts` — scans `@declaragent/channel-*` alongside `@declaragent/source-*`; wires `ChannelRegistry` and starts `ChannelOutboundBridge` (slice 3).
- `packages/core/src/events/base-source.ts` — no change; `BaseChannelInstance` subclasses without modifying it. The Phase-4 reliability guarantees apply.
- `packages/cli/src/daemon-cli.ts` — `channels-provider` reads `channels.yaml` (slice 3).
- `packages/core/package.json` — stays lean. No new runtime deps. The renderer's MarkdownV2 escaper and Block Kit validator are hand-rolled.

Engine loop, permission gate primitive, tool contract, MCP loader, plugin loader — all untouched.

---

## 16. Testing strategy

Five tiers (Phase 4's four + a manual demo checkpoint for the acceptance bar):

1. **Pure unit tests** — every renderer, MarkdownV2 escaper, Block Kit validator, outbound rate-limiter, send-idempotency cache, session-id derivation, principal resolver, outbound bridge, conversation-window tracker.

2. **Contract tests** — `channelContractSuite(factory)` from `packages/testkit/src/contract.ts` (slice 12). Every adapter package imports and runs it. Asserts capabilities declared, send/edit/delete/react conform, idempotency cache de-dupes, rate-limit errors typed, webhook mode (if present) passes signature verification.

3. **Mock-SDK integration tests** — each adapter has one integration test that mocks the SDK layer (telegraf/discord.js/bolt/hand-rolled WA client) but exercises the full adapter code path including the renderer. These run in every CI build. The mock SDK also powers the acceptance demo in slice 15's test-mode.

4. **Real-platform sandbox tests** — gated by env (`DECLARAGENT_CHANNEL_IT=1` + per-platform creds). Uses dedicated test accounts — a Telegram test bot via `BotFather`, a Discord test guild, a Slack test workspace, WhatsApp sandbox number. Nightly only; not PR CI. Tests: send/edit/delete/react/typing/file-upload on each real platform; verify inbound delivers; verify webhook signatures; verify WhatsApp 24h-window enforcement.

5. **Manual acceptance demo** — the four-channel demo defined by the spec. Not automated. A human operator follows the slice-15 demo script and observes threads, reactions, typing, file-upload on each channel. Recorded once per release candidate.

**No CI jobs against production services.** Sandbox accounts only. No credentials in the main repo — CI pulls from a secrets manager; contributors who lack creds get the mocked tier (tiers 1–3).

---

## 17. Open questions

1. **Streaming mode as default.** Background doc suggests buffered-first; Slack rewards streaming-feel via `chat.update`. Start with buffered; add streaming as opt-in per channel (slice 13 is optional).
   - **My lean:** buffered default, opt-in `streaming: true` per channel. Discord + Slack + Telegram support it via edit; WhatsApp can't.

2. **Voice pipeline.** STT/TTS is out of scope for v0.9 but the event taxonomy includes `chat.voice`. Does the adapter transcribe inline, or does it hand off to a hook?
   - **My lean:** adapter delivers `chat.voice` with `audio: FileRef`; a configurable transcription hook (`channels.voice.transcriber: 'mcp:whisper'`) runs in the dispatcher pre-handler. Ships in Phase-5.x; v0.9 has the passthrough only.

3. **Multi-bot / multi-workspace per channel type.** Can a single daemon run two `telegram` channel instances (two bots) concurrently?
   - **My lean:** yes. `ChannelRegistry` is keyed on `id`, not on `type`. Tested in slice 3 (`channels.yaml` has two `telegram` entries with different bot tokens).

4. **Webhook port.** Phase 3 reserved port 8787 for the webhook source. Do channels share it or each own its own?
   - **My lean:** share. The daemon HTTP server routes `/channels/<id>/webhook` to the registered channel; the channel adapter validates its signature. Reuses the existing HTTP plumbing; no new port.

5. **Thread model unification.** Slack `thread_ts` is numeric-but-string; Discord thread ids are snowflakes; WhatsApp has no threads; Telegram has topics (skipped for v1).
   - **My lean:** `ConversationRef.threadId` is always a string. Each adapter documents what format it puts there. The unified session-id derivation is opaque — it doesn't parse the threadId.

6. **File upload idempotency.** Uploading the same file twice to WhatsApp creates two media ids. The Telegram `file_id` cache de-dupes; the WhatsApp adapter should too.
   - **My lean:** `FileRefCache` in `BaseChannelInstance` keyed on content-hash; any adapter that calls `uploadFile` uses it. Cache size 1024 entries (LRU). Persistent variant in `conversationStore`.

7. **Button payload size limits.** Discord 100 chars per `custom_id`, Slack 255 per `action_id`, Telegram 64 bytes per `callback_data`, WhatsApp 256 per button id. Skills that generate button ids must stay under the minimum.
   - **My lean:** renderer rejects button ids exceeding 64 chars (lowest common denominator) with a typed error pointing at the offending button. Adapters can override upward if they know their target.

8. **Audit retention.** Every channel event + outbound gets audited. Retention policy?
   - **My lean:** tied to `spec.observability.auditRetentionDays` (exists in spec, currently 30). Channels don't add a separate knob.

9. **Bot-to-bot loops.** If the bot's reply is ingested as another `chat.message` (e.g., bot replies in a channel where it's also listening), we infinite-loop.
   - **My lean:** every adapter's inbound handler filters `is_bot` / `bot_id` / `from.is_bot` / WhatsApp `from_self: true` before publishing. Non-negotiable; part of the contract conformance suite.

10. **Cross-channel correlation ids.** Example 10.3 of the background doc wants the same correlationId threaded across a Telegram → Slack handoff.
    - **My lean:** out of scope for v0.9. The machinery exists (`event.meta.correlationId` is preserved through children); a handoff skill would need to explicitly pass the id when it issues a `SendMessage(channel:…)`. Document as a worked example, not a built-in.

11. **Discord Gateway reconnect storms.** When the daemon restarts in a busy guild, Discord rate-limits session resumes. What's the recovery behavior?
    - **My lean:** `discord.js` handles resume tokens; adapter configures `rest.retries: 3` and treats the first 10 seconds post-start as warm-up (no outbound sends). Documented in the risks.

12. **Slack Events-mode scaling.** Events API requires an internet-reachable URL. Socket Mode is easier for self-hosted. Do we default to Socket?
    - **My lean:** default Socket. Events mode is opt-in via `transport.mode: events`. Socket is simpler to demo and doesn't require user-side DNS/TLS setup.

---

## 18. Risks

- **WhatsApp template approval latency.** Templates take 24h+ for Meta to approve. If the acceptance demo needs a non-trivial template, we block. Mitigation: start template registration on day 1 of slice 8; the demo uses a simple `checkin_reminder_v1` template registered in week 1.
- **Discord intent changes.** Discord periodically changes which intents are privileged. Mitigation: capabilities declared per adapter; startup preflight validates granted vs. requested; adapter throws actionable error on drift.
- **Slack Block Kit schema drift.** Slack silently updates Block Kit; a block that was valid yesterday 400s today. Mitigation: validator is conservative (only allows documented blocks); integration tests catch drift overnight.
- **Telegram MarkdownV2 escapes.** Ruthless punctuation rules cause 400s that are hard to reproduce. Mitigation: AST-aware escaper + 10k-string fuzz test + `escape-test` debug CLI.
- **`discord.js` major version churn.** v14 → v15 has breaking changes. Mitigation: pin `^14.14.0`; document upgrade path separately.
- **WhatsApp phone tier throttling.** New numbers start at 1K msg/day; load tests against a real sandbox will hit this fast. Mitigation: load tests use the mock-SDK tier only; real-platform sandbox tests emit ≤ 100 msgs/run.
- **Bot-to-bot infinite loops.** A Slack bot replying in a channel where Discord also relays messages (via a third-party bridge) can loop. Mitigation: inbound filter on `is_bot`/`bot_id` is contract-enforced; correlation-id dedup in the dispatcher stops obvious loops; `causedBy` chain-breaker from Phase 3 is the safety net.
- **Webhook signature drift.** WhatsApp rotates app secrets; adapter must support graceful rotation without downtime. Mitigation: config allows `webhookAppSecret` to be a list of active secrets (primary + rollover); verification tries each.
- **Test account maintenance.** Test Slack workspaces / Discord guilds / Telegram bots expire when unused. Mitigation: a nightly "ping test accounts" cron that sends a heartbeat; owner gets a Slack ping when a test account looks dormant.
- **Interaction token expiry (Discord).** A tool call that runs longer than 15 minutes loses the interaction token. Mitigation: `deferReply()` immediately buys 15 min; jobs that may exceed that register an "extended" flag and fall back to a fresh channel message instead of `editReply`.

---

## 19. Acceptance check

The spec's acceptance bar:

> Bidirectional conversation on each of the four channels with threads, reactions, typing indicators, and file upload demonstrated in a single demo session.

Practical (slice 15):

1. **Setup:** a single `agent.yaml` + `channels.yaml` configures all four channel instances. One `concierge` skill handles inbound messages on every channel.
2. **Telegram demo.** User sends `/help` → bot shows typing indicator → bot replies with a rich message including a 3-button inline keyboard → user clicks a button → bot reacts with ✅ → user sends a file → bot downloads, echoes the filename, and uploads a `response.md` file.
3. **Discord demo.** User @mentions in a guild channel → bot creates a thread, types for 2s, posts an embed with ActionRow buttons → user clicks → bot edits the message with confirmation → user reacts with 👍 → bot reacts back with ✅ → user archives the thread; bot auto-unarchives and continues.
4. **Slack demo.** User sends a message in a channel (with a thread reply) → bot threads its reply (Block Kit header + section + button row) → button click → bot updates the message in-thread → user reacts with `:eyes:` → bot reacts back with `:white_check_mark:` → bot uploads a file to the thread via `files.upload`.
5. **WhatsApp demo.** User sends a text → bot replies with an interactive reply-button message (3 options) → button click → bot replies in-window with a media file (image) → user reacts with ❤️ → bot reacts back → simulate a 24h-elapsed jump (adapter test hook) → bot tries to send free-form, gets blocked, falls back to the `checkin_reminder_v1` template → user replies → window reopens → normal flow resumes.
6. **Cross-cutting checks:**
   - Every outbound send carries an idempotency key; manually forcing a re-send produces exactly one platform message per key.
   - Every channel's audit log contains the principal, conversation, and outcome.
   - `declaragent channels list` shows all four as `healthy`.
   - `declaragent cost` shows per-session cost attributed to the channel origin.

If all six run end-to-end without a blocker, Phase 5 ships.

---

## 20. Next step

Slice 1 (channel contract + registry + session metadata) is the unblocker — ~2 days, touches core types but no runtime behavior. Once slice 1 lands:

- Slice 2 (`BaseChannelInstance` + `ChannelOutboundBridge`) sets up the shared outbound plumbing.
- Slice 3 (discovery + loader) unblocks adapter packages.
- Slice 4 (renderer) unblocks every adapter's outbound path.
- Slices 5–8 parallelize once 1–4 are in. Telegram is the canary (simplest SDK, validates the whole pipeline). Discord + Slack land on comparable timelines. WhatsApp is the long pole; start it concurrent with 5 so its 7-day budget + template-approval waits run in parallel.

The demo (slice 15) is the product checkpoint. We do not declare Phase 5 done until the full four-channel demo runs green on real (sandbox) platforms in a single session.

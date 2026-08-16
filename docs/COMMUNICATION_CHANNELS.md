# Communication Channels: WhatsApp, Telegram, Discord, Slack

> ⚠️ **Historical design doc — not maintained.** This document predates the shipped
> implementation and is kept for design context only; command names, config shapes,
> versions, and file paths in it may no longer match the code. `docs/SPEC_AND_PLAN.md`
> supersedes it for requirements; for live capability status see `AGENTS.md`, and for
> user-facing behavior see the docs site (`docs-site/`).


Companion to `EVENT_SOURCE_REGISTRY.md`. That doc treated event sources as one-way ingestion (Kafka, MQTT, AMQP — consume, dispatch, done). Chat platforms are different: they are **bidirectional I/O channels**. The agent doesn't just *react* to messages — it holds *conversations*.

This doc adds WhatsApp, Telegram, Discord, and Slack as first-class channels that reuse the event-source machinery while extending it for bidirectional communication, rich media, threads, interactive components, and per-platform quirks.

Read `EVENT_DRIVEN_AGENT.md` and `EVENT_SOURCE_REGISTRY.md` first.

---

## Table of Contents

1. [Why Chat Channels Are Different](#1-why-chat-channels-are-different)
2. [The ChannelAdapter Contract](#2-the-channeladapter-contract)
3. [Conversation → Session Mapping](#3-conversation--session-mapping)
4. [The Outbound Path](#4-the-outbound-path)
5. [Per-Platform Deep Dives](#5-per-platform-deep-dives)
   - [5.1 Telegram](#51-telegram)
   - [5.2 Discord](#52-discord)
   - [5.3 Slack](#53-slack)
   - [5.4 WhatsApp](#54-whatsapp)
6. [Unified Message Model](#6-unified-message-model)
7. [Rich Features: Media, Buttons, Threads, Reactions](#7-rich-features)
8. [Identity & Permissions](#8-identity--permissions)
9. [Rate Limits Per Platform](#9-rate-limits-per-platform)
10. [Worked Examples](#10-worked-examples)
11. [Build Order](#11-build-order)
12. [Pitfalls Per Platform](#12-pitfalls-per-platform)

---

## 1. Why Chat Channels Are Different

An event source is one-way:

```
Broker ──message──► Adapter ──AgentEvent──► Bus ──► Agent ──done
```

A channel is a loop:

```
Platform ──msg──► Adapter ──event──► Bus ──► Session ──reply──► Adapter ──send──► Platform
                                                      │
                                                      └──typing, reactions, files...
```

Five things break if you treat chat as a one-way event source:

1. **The agent must reply in the same channel** — and in the right thread, DM, or group.
2. **Conversations have context** — a reply to "what about the other one?" needs message N-3.
3. **Users expect affordances** — typing indicators, read receipts, reactions.
4. **Platforms have rich features** — inline buttons, slash commands, file attachments, voice notes — that you lose if you only treat messages as text.
5. **Each platform has strict rate limits and policies** — WhatsApp won't even *let* you send certain messages outside a 24-hour window without a pre-approved template.

So a channel adapter is an **event source + output sink + UX affordance layer + platform-policy enforcer**. Not just one of those — all of them.

---

## 2. The ChannelAdapter Contract

Extend the `EventSourceAdapter` from `EVENT_SOURCE_REGISTRY.md` with outbound capabilities.

```typescript
// src/channels/types.ts
export interface ChannelAdapter extends EventSourceAdapter {
  readonly capabilities: ChannelCapabilities;
  create(config: ChannelConfig, deps: ChannelDependencies): Promise<ChannelInstance>;
}

export type ChannelCapabilities = {
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsTypingIndicator: boolean;
  supportsFileUpload: boolean;
  supportsVoice: boolean;
  supportsButtons: boolean;              // inline keyboards / blocks
  supportsEditMessage: boolean;
  supportsDeleteMessage: boolean;
  supportsPresence: boolean;
  supportsSlashCommands: boolean;
  supportsDMs: boolean;
  supportsGroupChats: boolean;
  supportsVoiceChannels: boolean;        // Discord-specific
  maxMessageLength: number;
  maxAttachmentBytes: number;
  requiresTemplateForOutbound?: boolean; // WhatsApp
  conversationWindow?: number;            // WhatsApp 24h rule (ms)
};

export interface ChannelInstance extends EventSourceInstance {
  /** Send a text or rich message. */
  send(params: SendMessageParams): Promise<SentMessage>;

  /** Show typing/composing indicator. */
  setTyping?(conversation: ConversationRef, duration?: number): Promise<void>;

  /** React to a message. */
  react?(messageRef: MessageRef, emoji: string): Promise<void>;

  /** Edit a previously sent message. */
  edit?(messageRef: MessageRef, newContent: MessageContent): Promise<void>;

  /** Delete a previously sent message. */
  delete?(messageRef: MessageRef): Promise<void>;

  /** Upload a file; return platform URL/ID. */
  uploadFile?(file: FileUpload, conversation: ConversationRef): Promise<FileRef>;

  /** Pin/unpin, mark as read, etc. */
  performAction?(action: ChannelAction): Promise<void>;
}

export type SendMessageParams = {
  conversation: ConversationRef;
  content: MessageContent;
  replyTo?: MessageRef;                   // threading
  mentions?: UserRef[];
  idempotencyKey?: string;
};

export type ConversationRef = {
  channelId: string;                      // adapter instance id (e.g., "telegram-main")
  conversationId: string;                 // platform-specific (chat_id, channel_id, phone)
  threadId?: string;                      // Slack thread, Discord thread, WhatsApp: N/A
  platformMeta?: Record<string, unknown>;
};

export type MessageContent =
  | { kind: 'text'; text: string; format?: 'plain' | 'markdown' | 'html' }
  | { kind: 'rich'; blocks: RichBlock[] }  // platform-translated
  | { kind: 'template'; name: string; params: Record<string, string> }  // WhatsApp
  | { kind: 'file'; file: FileRef; caption?: string }
  | { kind: 'voice'; audio: FileRef; durationSec?: number };

export type RichBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string; lang?: string }
  | { kind: 'bulleted-list'; items: string[] }
  | { kind: 'button-row'; buttons: Button[] }
  | { kind: 'divider' }
  | { kind: 'image'; url: string; alt?: string }
  | { kind: 'context'; text: string };       // footnote / metadata line

export type Button = {
  id: string;                              // for interaction callbacks
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
  url?: string;                            // link buttons
};
```

### Key design decisions

- **`ConversationRef` uniquely identifies a destination** across channels, threads, and DMs. Adapters translate it to platform-native IDs.
- **`MessageContent` has a unified rich-block schema**. The adapter converts to platform-specific markup (Slack blocks, Discord embeds, Telegram inline keyboards). Skills produce the same rich blocks regardless of destination.
- **`idempotencyKey`** prevents duplicate sends on retry — critical because the agent loop may retry.
- **Capabilities negotiation** — a skill can check `caps.supportsButtons` before emitting buttons; degrade gracefully.

---

## 3. Conversation → Session Mapping

How does an incoming message become an agent session?

### Three strategies

| Strategy | Session scope | Good for |
|---|---|---|
| **Per conversation** | One session per (channel, conversationId, threadId) | Most use cases; mirrors how humans think |
| **Per user** | One session per platform user across all conversations | Personal assistant; single identity |
| **Ephemeral** | New session per message | Pure stateless tools; no conversation memory |

Default: **per conversation**. Threads are separate sessions from their parent channel.

### Session ID derivation

```typescript
function conversationSessionId(ref: ConversationRef): string {
  const parts = [
    'chat',
    ref.channelId,
    ref.conversationId,
    ref.threadId ?? 'main',
  ];
  return parts.join(':');
}

// "chat:telegram-main:-1001234567:main"
// "chat:slack-prod:C07ABC123:1702345678.001234"   (thread)
// "chat:discord-guild:987654:thread-111"
```

Deterministic. Same conversation always maps to same session. Perfect for `sessionIdFrom` in the routing config.

### Session lifecycle

- **Cold start**: first message from a conversation → spawn session → inject message.
- **Warm session**: subsequent messages → inject into existing session (if idle) or queue (if turn in progress).
- **Timeout / archival**: after N hours of inactivity, compact + persist + unload. Resume on next message.

### Routing config

```yaml
sources:
  - id: telegram-main
    type: telegram
    routing:
      targetSelector:
        type: session
        sessionIdFrom: "${channel:conversationSessionId}"  # built-in helper
        action: inject
        onMissing: spawn                                   # new session if none exists
        spawnConfig:
          initialSystemPrompt: "You are a helpful assistant on Telegram..."
```

---

## 4. The Outbound Path

The return trip. An agent produces assistant messages; the channel adapter delivers them.

### Wire-up

The session's message stream is already being yielded by `runAgent()`. Add a channel-output listener that watches for `assistant_message` events and routes them back to the originating channel:

```typescript
// src/channels/outbound.ts
export class ChannelOutboundBridge {
  constructor(
    private bus: EventBus,
    private sessions: SessionManager,
    private channels: ChannelRegistry,
  ) {
    bus.subscribe('*', (e) => this.maybeForward(e));
  }

  private async maybeForward(event: AgentEvent) {
    // Only forward assistant output events
    if (event.kind !== 'assistant.message' && event.kind !== 'assistant.final') return;

    // Find the originating conversation from the session metadata
    const session = this.sessions.get(event.source.sessionId!);
    const origin = session?.metadata.channelOrigin as ConversationRef | undefined;
    if (!origin) return;

    const channel = this.channels.get(origin.channelId);
    if (!channel) return;

    const content = this.extractContent(event);
    if (!content) return;

    await channel.send({
      conversation: origin,
      content,
      idempotencyKey: `session:${event.source.sessionId}:${event.id}`,
    });
  }

  private extractContent(event: AgentEvent): MessageContent | null {
    const blocks = (event.payload as any).content;
    // Convert assistant's structured output to MessageContent
    // Text-only path for v1:
    const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    return text ? { kind: 'text', text, format: 'markdown' } : null;
  }
}
```

### Typing indicator

Start "typing" the moment a turn begins; stop when text starts streaming (or when the reply is sent):

```typescript
session.on('turn:start', async () => {
  await channel.setTyping?.(origin, 30);  // renew every 30s until clear
});
session.on('assistant:delta', async () => {
  // First token → stop typing; the text itself is the signal now
  await channel.setTyping?.(origin, 0);
});
```

### Streaming vs buffered

Two modes:

- **Buffered** (default): wait for the full assistant turn, send one message. Easier, lower API cost.
- **Streamed**: send the first chunk, edit the message as more text arrives. Feels alive, but burns API calls. Platform-dependent (Telegram allows edits; WhatsApp doesn't, really).

Most platforms: start with buffered. Add streaming as an opt-in per-channel config.

### Long responses

All platforms cap message length (Telegram 4096, Slack 40000, Discord 2000, WhatsApp 4096). If the reply exceeds:

1. **Split on paragraph boundaries**, with a `(1/N)` / `(2/N)` suffix.
2. **Or upload as a file** for code-heavy responses (`response.md`) — especially on Discord and Slack.
3. **Or use platform-native "view more"** — Slack modal, Telegram inline-query result.

---

## 5. Per-Platform Deep Dives

Each platform has a personality. The adapter earns its keep by hiding the nasty bits.

### 5.1 Telegram

**Why it's the easiest first adapter.** Simple REST API. Bot tokens via BotFather. Either long-polling or webhooks. Rich features (inline keyboards, inline queries, files up to 50MB via bot API / 2GB via MTProto) without ceremony.

#### Transport

- **Long-polling**: `getUpdates` loop. Fine for dev, single-instance prod.
- **Webhook**: Telegram POSTs to your URL. Required for multi-instance/horizontal scale.
- **MTProto** (via `gram.js` / `telethon`): User account automation. Avoid for bots; use for user-bot scenarios (not bot-user).

#### Config

```yaml
- id: telegram-main
  type: telegram
  transport:
    mode: webhook                       # or: long-polling
    botToken: "${secret:telegram_bot_token}"
    webhookUrl: "https://agent.example.com/webhooks/telegram"
    webhookSecret: "${secret:telegram_webhook_secret}"
    allowedUpdates: [message, callback_query, inline_query, edited_message]
  routing:
    kindSelector: { const: "chat.message" }
    targetSelector:
      type: session
      sessionIdFrom: "${channel:conversationSessionId}"
      action: inject
      onMissing: spawn
  permissions:
    mode: auto
    allow: ["Read(**/*)", "mcp__calendar__*"]
    deny: ["Bash(*)", "Edit(**/*)"]
```

#### Adapter sketch

```typescript
// @my-agent/channel-telegram
import { Telegraf, Context } from 'telegraf';

export class TelegramChannelInstance extends BaseSourceInstance implements ChannelInstance {
  private bot!: Telegraf;

  readonly capabilities: ChannelCapabilities = {
    supportsThreads: false,              // topics in supergroups exist; skip for v1
    supportsReactions: true,             // since Bot API 7.0
    supportsTypingIndicator: true,
    supportsFileUpload: true,
    supportsVoice: true,
    supportsButtons: true,
    supportsEditMessage: true,
    supportsDeleteMessage: true,
    supportsPresence: false,
    supportsSlashCommands: true,
    supportsDMs: true,
    supportsGroupChats: true,
    supportsVoiceChannels: false,
    maxMessageLength: 4096,
    maxAttachmentBytes: 50 * 1024 * 1024,
  };

  protected async doStart() {
    this.bot = new Telegraf(this.config.transport.botToken);

    this.bot.on('message', async (ctx) => {
      await this.handleMessage(
        {
          value: JSON.stringify({ kind: 'message', update: ctx.update }),
          topic: `telegram:${ctx.chat!.id}`,
          headers: { 'x-update-id': ctx.update.update_id },
          meta: { deliveryCount: 0 },
        },
        { ack: async () => {}, nack: async () => {} },
      );
    });

    this.bot.on('callback_query', async (ctx) => {
      // Button press — dispatch as interaction event
      const data = (ctx.callbackQuery as any).data;
      await this.bus.publish({
        id: uuid(),
        source: { type: 'channel', channelId: this.id, kind: 'telegram' } as any,
        kind: 'channel.interaction',
        timestamp: Date.now(),
        target: {
          type: 'session',
          sessionId: conversationSessionId(this.buildRef(ctx)),
          action: 'inject',
        },
        payload: { interaction: 'button', buttonId: data, from: ctx.from },
        auth: { kind: 'internal' },
      });
      await ctx.answerCbQuery();  // remove loading spinner
    });

    if (this.config.transport.mode === 'webhook') {
      await this.bot.telegram.setWebhook(this.config.transport.webhookUrl, {
        secret_token: this.config.transport.webhookSecret,
      });
      // HTTP handler registered separately by the daemon
    } else {
      await this.bot.launch();
    }
  }

  async send(params: SendMessageParams): Promise<SentMessage> {
    const chatId = params.conversation.conversationId;
    const content = this.renderContent(params.content);

    if (params.content.kind === 'text') {
      const msg = await this.bot.telegram.sendMessage(chatId, content.text, {
        parse_mode: 'MarkdownV2',
        reply_parameters: params.replyTo ? { message_id: Number(params.replyTo.id) } : undefined,
        reply_markup: content.reply_markup,
      });
      return { id: String(msg.message_id), conversation: params.conversation };
    }

    if (params.content.kind === 'file') {
      const msg = await this.bot.telegram.sendDocument(chatId, { source: params.content.file.path }, {
        caption: params.content.caption,
      });
      return { id: String(msg.message_id), conversation: params.conversation };
    }

    // ... voice, rich blocks
    throw new Error(`Unsupported content kind: ${params.content.kind}`);
  }

  async setTyping(conversation: ConversationRef) {
    await this.bot.telegram.sendChatAction(conversation.conversationId, 'typing');
  }

  async react(ref: MessageRef, emoji: string) {
    await this.bot.telegram.callApi('setMessageReaction' as any, {
      chat_id: ref.conversation.conversationId,
      message_id: Number(ref.id),
      reaction: [{ type: 'emoji', emoji }],
    });
  }

  private renderContent(content: MessageContent): any {
    if (content.kind === 'text') return { text: content.text, reply_markup: null };
    if (content.kind === 'rich') {
      // Translate rich blocks to Telegram: inline keyboard, MarkdownV2 text
      const text = this.richBlocksToMarkdown(content.blocks);
      const buttons = this.extractButtons(content.blocks);
      return {
        text,
        reply_markup: buttons.length ? { inline_keyboard: [buttons] } : undefined,
      };
    }
    throw new Error('...');
  }
  // ...
}
```

#### Telegram quirks

- **MarkdownV2 escaping** is strict — every `.`, `-`, `(`, `)`, etc. must be escaped. Write a utility; test it hard.
- **Privacy mode** is on by default — the bot only sees messages that @mention it or are replies. Disable via BotFather for general-purpose chat.
- **File IDs** — once a file is uploaded, Telegram gives you a reusable `file_id`. Cache it; don't reupload.

### 5.2 Discord

**More complex.** Gateway = persistent WebSocket. Interactions (slash commands, buttons, modals) = separate HTTP callback model. Guilds, channels, threads, DMs, voice, forum posts. Rich embeds, markdown, file uploads up to 25MB (Nitro: 500MB).

#### Transport

- **Gateway WebSocket** for receiving messages + presence + voice state.
- **HTTP REST API** for sending.
- **Interactions Endpoint URL** (HTTP) for slash commands, buttons, modal submits — if you don't want to use Gateway for interactions.
- **Sharding** — required above ~2500 guilds.

#### Config

```yaml
- id: discord-main
  type: discord
  transport:
    botToken: "${secret:discord_bot_token}"
    applicationId: "1234567890"
    intents: [Guilds, GuildMessages, MessageContent, DirectMessages, GuildMessageReactions]
    sharding: auto                     # or: { totalShards: 4 }
    interactionsMode: gateway          # or: http  (requires public URL)
  routing:
    kindSelector:
      switch:
        - { when: "$.type == 'MESSAGE_CREATE'", value: "chat.message" }
        - { when: "$.type == 'INTERACTION_CREATE'", value: "channel.interaction" }
    targetSelector:
      type: session
      sessionIdFrom: "${channel:conversationSessionId}"
      action: inject
      onMissing: spawn
```

#### Adapter sketch

```typescript
// @my-agent/channel-discord
import { Client, GatewayIntentBits, Partials } from 'discord.js';

export class DiscordChannelInstance extends BaseSourceInstance implements ChannelInstance {
  private client!: Client;

  readonly capabilities: ChannelCapabilities = {
    supportsThreads: true,
    supportsReactions: true,
    supportsTypingIndicator: true,
    supportsFileUpload: true,
    supportsVoice: true,
    supportsButtons: true,
    supportsEditMessage: true,
    supportsDeleteMessage: true,
    supportsPresence: true,
    supportsSlashCommands: true,
    supportsDMs: true,
    supportsGroupChats: true,
    supportsVoiceChannels: true,
    maxMessageLength: 2000,
    maxAttachmentBytes: 25 * 1024 * 1024,
  };

  protected async doStart() {
    this.client = new Client({
      intents: this.mapIntents(this.config.transport.intents),
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on('messageCreate', async (message) => {
      if (message.author.bot) return;  // ignore bots
      if (!this.shouldRespond(message)) return;  // @mention gate in guilds

      await this.publishMessage(message);
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (interaction.isButton()) await this.publishInteraction(interaction);
      if (interaction.isChatInputCommand()) await this.publishSlashCommand(interaction);
      if (interaction.isModalSubmit()) await this.publishModalSubmit(interaction);
    });

    await this.client.login(this.config.transport.botToken);
    await this.registerSlashCommands();
  }

  async send(params: SendMessageParams): Promise<SentMessage> {
    const channel = await this.client.channels.fetch(params.conversation.conversationId);
    if (!channel?.isTextBased()) throw new Error('Not a text channel');

    const target = params.conversation.threadId
      ? await (channel as any).threads.fetch(params.conversation.threadId)
      : channel;

    const payload = this.renderContent(params.content, params);
    const msg = await (target as any).send(payload);
    return { id: msg.id, conversation: params.conversation };
  }

  async setTyping(conversation: ConversationRef) {
    const channel = await this.client.channels.fetch(conversation.conversationId);
    if (channel?.isTextBased()) await (channel as any).sendTyping();
    // Lasts ~10s; re-send periodically
  }

  private renderContent(content: MessageContent, params: SendMessageParams): any {
    if (content.kind === 'text') {
      return { content: this.truncate(content.text, 2000) };
    }
    if (content.kind === 'rich') {
      const embeds = this.blocksToEmbeds(content.blocks);
      const components = this.blocksToComponents(content.blocks);
      return { embeds, components };
    }
    // ...
  }

  private blocksToComponents(blocks: RichBlock[]) {
    const rows: any[] = [];
    for (const b of blocks) {
      if (b.kind === 'button-row') {
        rows.push({
          type: 1,  // ActionRow
          components: b.buttons.map(btn => ({
            type: 2,  // Button
            style: this.mapButtonStyle(btn.style),
            label: btn.label,
            custom_id: btn.id,
            url: btn.url,
          })),
        });
      }
    }
    return rows;
  }
}
```

#### Discord quirks

- **Intents** must be declared in the Developer Portal *and* the code. Missing intent = silently no events.
- **Privileged intents** (Message Content, Guild Presences, Guild Members) require approval above 100 servers.
- **Interaction tokens expire in 15 minutes** — if you defer and the turn takes longer, the follow-up fails. Ack fast with `deferReply`, send actual content as a follow-up.
- **Slash commands are rate-limited at registration**, not invocation. Register once on startup, not every connect.
- **Thread auto-archival** — threads can be archived by Discord; your session might be talking to a dead thread. Detect `thread.archived` events.

### 5.3 Slack

**Enterprise-flavored.** Socket Mode (WebSocket from your app to Slack) or Events API (Slack POSTs to your public URL). Block Kit for rich UIs. Threads first-class. Distribution model matters: internal app, org-wide app, or Marketplace app — each with different approval ladders.

#### Transport

- **Socket Mode**: WebSocket + app-level token. No public URL required. Good for internal / self-hosted.
- **Events API**: HTTP callbacks. Required for Marketplace apps.
- **Bolt SDK** (JS/Python) abstracts both.

#### Config

```yaml
- id: slack-prod
  type: slack
  transport:
    mode: socket                       # or: events
    appToken: "${secret:slack_app_token}"    # xapp-... for socket mode
    botToken: "${secret:slack_bot_token}"    # xoxb-...
    signingSecret: "${secret:slack_signing_secret}"  # for events mode
    events: [message.channels, message.im, app_mention, reaction_added]
  routing:
    kindSelector:
      switch:
        - { when: "$.event.type == 'app_mention'", value: "chat.mention" }
        - { when: "$.event.type == 'message' and $.event.channel_type == 'im'", value: "chat.dm" }
        - { when: "$.event.type == 'message'", value: "chat.message" }
    filter:
      expr: "not ($.event.bot_id or $.event.subtype == 'bot_message')"
    targetSelector:
      type: session
      sessionIdFrom: "${channel:conversationSessionIdSlack}"
      action: inject
      onMissing: spawn
```

#### Adapter sketch

```typescript
// @my-agent/channel-slack
import { App, SocketModeReceiver } from '@slack/bolt';

export class SlackChannelInstance extends BaseSourceInstance implements ChannelInstance {
  private app!: App;

  readonly capabilities: ChannelCapabilities = {
    supportsThreads: true,
    supportsReactions: true,
    supportsTypingIndicator: false,     // Slack has no "bot is typing"
    supportsFileUpload: true,
    supportsVoice: false,
    supportsButtons: true,              // via Block Kit
    supportsEditMessage: true,
    supportsDeleteMessage: true,
    supportsPresence: true,
    supportsSlashCommands: true,
    supportsDMs: true,
    supportsGroupChats: true,
    supportsVoiceChannels: false,
    maxMessageLength: 40000,
    maxAttachmentBytes: 1024 * 1024 * 1024,  // 1GB
  };

  protected async doStart() {
    this.app = new App({
      token: this.config.transport.botToken,
      signingSecret: this.config.transport.signingSecret,
      socketMode: this.config.transport.mode === 'socket',
      appToken: this.config.transport.appToken,
    });

    this.app.event('app_mention', async ({ event }) => {
      await this.publishMessage(event as any, 'chat.mention');
    });

    this.app.event('message', async ({ event }) => {
      if ((event as any).subtype || (event as any).bot_id) return;
      await this.publishMessage(event as any, 'chat.message');
    });

    this.app.action(/button_.+/, async ({ action, ack, body }) => {
      await ack();
      await this.publishInteraction(body, action);
    });

    this.app.command('/agent', async ({ command, ack, respond }) => {
      await ack();
      await this.publishSlashCommand(command);
    });

    await this.app.start();
  }

  async send(params: SendMessageParams): Promise<SentMessage> {
    const result = await this.app.client.chat.postMessage({
      channel: params.conversation.conversationId,
      thread_ts: params.conversation.threadId,
      text: this.fallbackText(params.content),    // always include for notifs
      blocks: this.renderBlocks(params.content),
    });
    return { id: result.ts!, conversation: params.conversation };
  }

  async react(ref: MessageRef, emoji: string) {
    await this.app.client.reactions.add({
      channel: ref.conversation.conversationId,
      timestamp: ref.id,
      name: emoji.replace(/:/g, ''),
    });
  }

  private renderBlocks(content: MessageContent): any[] {
    if (content.kind === 'text') {
      return [{ type: 'section', text: { type: 'mrkdwn', text: content.text } }];
    }
    if (content.kind === 'rich') {
      return content.blocks.map(b => this.blockToSlack(b));
    }
    return [];
  }

  private blockToSlack(block: RichBlock): any {
    switch (block.kind) {
      case 'heading':
        return { type: 'header', text: { type: 'plain_text', text: block.text } };
      case 'paragraph':
        return { type: 'section', text: { type: 'mrkdwn', text: block.text } };
      case 'code':
        return { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${block.lang ?? ''}\n${block.text}\n\`\`\`` } };
      case 'button-row':
        return {
          type: 'actions',
          elements: block.buttons.map(btn => ({
            type: 'button',
            text: { type: 'plain_text', text: btn.label },
            action_id: `button_${btn.id}`,
            style: btn.style,
            url: btn.url,
          })),
        };
      case 'divider':
        return { type: 'divider' };
      case 'context':
        return { type: 'context', elements: [{ type: 'mrkdwn', text: block.text }] };
      case 'image':
        return { type: 'image', image_url: block.url, alt_text: block.alt ?? '' };
      // ...
    }
  }
}
```

#### Slack quirks

- **Thread discipline** — if the message came in a thread, reply in the thread. If `@mentioned` in the channel, you can choose: thread it (less noisy) or post in channel.
- **Always include plain-text `text` field** alongside blocks — it's what appears in notifications and in search.
- **3-second ack rule** — interactive actions must be ack'd within 3 seconds. Ack immediately, follow up later if work is slow.
- **Block Kit has strict schema** — invalid blocks return 400 with a terse error. Build a validator.
- **Scopes are granular** — `chat:write`, `channels:history`, `im:history`, `reactions:write`, etc. Match exactly what you need.
- **Workspace vs org apps**: granted scopes differ. Test against your real target.

### 5.4 WhatsApp

**Hardest, by far.** Meta-controlled gateway. Template messages outside 24h. Compliance overhead. Phone-number verification. Cost per message.

#### Transport options

- **WhatsApp Cloud API** (Meta-hosted) — recommended starting point. REST + webhooks.
- **WhatsApp Business On-Premises API** — deprecated, migrating to Cloud.
- **BSP (Business Solution Provider)** — Twilio, Vonage, Infobip wrap the Cloud API with their own layer. Good if you already use them.

#### The 24-hour rule

The single most important thing to understand:

- When a user sends you a message, you have **24 hours** to send free-form replies.
- After that, you **can only send pre-approved template messages** until the user messages again.
- Template messages cost money (varies per country).
- Templates must be registered and approved by Meta (can take days).

This fundamentally changes the agent's conversational model. An agent can't "check back tomorrow" with free text.

#### Config

```yaml
- id: whatsapp-cloud
  type: whatsapp
  transport:
    provider: meta-cloud                   # or: twilio, vonage, infobip
    phoneNumberId: "123456789012345"
    businessAccountId: "987654321"
    accessToken: "${secret:whatsapp_access_token}"
    webhookVerifyToken: "${secret:whatsapp_verify_token}"
    webhookAppSecret: "${secret:whatsapp_app_secret}"
  policy:
    enforceConversationWindow: true
    outsideWindowAction: template          # or: queue, drop
    defaultTemplate: "checkin_reminder_v1"
  templates:
    - name: "appointment_reminder_v1"
      language: "en_US"
      parameterNames: ["customer_name", "date", "time"]
    - name: "checkin_reminder_v1"
      language: "en_US"
      parameterNames: ["topic"]
  routing:
    kindSelector: { const: "chat.message" }
    targetSelector:
      type: session
      sessionIdFrom: "${channel:conversationSessionId}"
      action: inject
      onMissing: spawn
```

#### Adapter sketch

```typescript
// @my-agent/channel-whatsapp
import { MetaWhatsAppClient } from './client';

export class WhatsAppChannelInstance extends BaseSourceInstance implements ChannelInstance {
  private client!: MetaWhatsAppClient;
  private conversationWindows = new Map<string, number>();  // phone → window-end timestamp

  readonly capabilities: ChannelCapabilities = {
    supportsThreads: false,
    supportsReactions: true,
    supportsTypingIndicator: false,        // WhatsApp doesn't expose this to bots
    supportsFileUpload: true,
    supportsVoice: true,
    supportsButtons: true,                 // list messages, reply buttons
    supportsEditMessage: false,
    supportsDeleteMessage: false,
    supportsPresence: false,
    supportsSlashCommands: false,
    supportsDMs: true,
    supportsGroupChats: false,             // groups have their own API surface
    supportsVoiceChannels: false,
    maxMessageLength: 4096,
    maxAttachmentBytes: 100 * 1024 * 1024,
    requiresTemplateForOutbound: true,
    conversationWindow: 24 * 60 * 60 * 1000,
  };

  protected async doStart() {
    this.client = new MetaWhatsAppClient(this.config.transport);
    // HTTP webhook handler registered by the daemon
  }

  /** Called by the daemon's HTTP handler when a webhook arrives. */
  async handleWebhook(body: any, signature: string) {
    if (!this.verifySignature(body, signature)) throw new Error('Invalid signature');

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value.messages ?? []) {
          // Opening a conversation window
          this.conversationWindows.set(message.from, Date.now() + this.capabilities.conversationWindow!);
          await this.publishMessage(message, change.value);
        }
      }
    }
  }

  async send(params: SendMessageParams): Promise<SentMessage> {
    const phone = params.conversation.conversationId;
    const inWindow = this.isInWindow(phone);

    if (params.content.kind === 'template') {
      // Templates always allowed
      const id = await this.client.sendTemplate({
        to: phone,
        templateName: params.content.name,
        params: params.content.params,
      });
      return { id, conversation: params.conversation };
    }

    if (!inWindow) {
      return this.handleOutsideWindow(params);
    }

    // In-window: free-form messages allowed
    if (params.content.kind === 'text') {
      const id = await this.client.sendText({ to: phone, text: params.content.text });
      return { id, conversation: params.conversation };
    }
    if (params.content.kind === 'rich') {
      const id = await this.sendRich(phone, params.content);
      return { id, conversation: params.conversation };
    }
    throw new Error(`Unsupported: ${params.content.kind}`);
  }

  private async handleOutsideWindow(params: SendMessageParams): Promise<SentMessage> {
    const policy = this.config.policy.outsideWindowAction;
    if (policy === 'drop') {
      this.deps.logger.warn(`Dropping WhatsApp send (outside 24h): ${params.conversation.conversationId}`);
      return { id: 'dropped', conversation: params.conversation };
    }
    if (policy === 'queue') {
      await this.queueForNextInbound(params);
      return { id: 'queued', conversation: params.conversation };
    }
    // policy === 'template': fall back to default template
    const template = this.config.policy.defaultTemplate!;
    const id = await this.client.sendTemplate({
      to: params.conversation.conversationId,
      templateName: template,
      params: { topic: this.summarize(params.content) },
    });
    return { id, conversation: params.conversation };
  }

  private isInWindow(phone: string): boolean {
    const end = this.conversationWindows.get(phone);
    return !!end && Date.now() < end;
  }
}
```

#### WhatsApp quirks

- **Opt-in is mandatory** — you must have consent before messaging anyone. Meta enforces this and will block numbers.
- **Templates require Meta approval** — a 24-hour process typically. Don't count on same-day template changes.
- **Interactive features are limited**: list messages (max 10 items), reply buttons (max 3). No rich embeds like Discord/Slack.
- **Media URLs expire** — download within ~5 minutes of receiving, or fetch via `/v17.0/{media_id}`.
- **Tier-based rate limits** — your phone number starts tier 1 (~1K msg/day); unlocks up by successful sending. New numbers = very constrained.
- **Group messages**: WhatsApp Groups API is a separate, more restricted surface. Most use cases are 1:1.

---

## 6. Unified Message Model

The whole point of the rich-block abstraction: **one skill produces blocks, four adapters render them.**

```typescript
// A skill produces this:
const reply: RichBlock[] = [
  { kind: 'heading', text: 'Order #1234' },
  { kind: 'paragraph', text: 'Status: *Shipped*. Arriving tomorrow.' },
  { kind: 'divider' },
  { kind: 'button-row', buttons: [
    { id: 'track', label: 'Track', style: 'primary', url: 'https://track/1234' },
    { id: 'support', label: 'Talk to support', style: 'secondary' },
  ]},
];
```

| Platform | Rendered as |
|---|---|
| Telegram | MarkdownV2 text + inline keyboard below (URL button + callback button) |
| Discord | Embed with title+description + ActionRow with two buttons |
| Slack | Block Kit: header + section + divider + actions with buttons |
| WhatsApp | Reply-buttons interactive message (max 3) or list message (if >3); URL becomes plain text if not supported |

**Skills don't know which platform they're talking to.** The adapter decides how to render.

### Capabilities-aware fallback

When a skill uses a feature the platform doesn't support, the adapter gracefully degrades:

```typescript
// In the adapter:
renderContent(content: MessageContent): PlatformMessage {
  if (content.kind === 'rich') {
    const filtered = content.blocks.filter(b => this.supportsBlock(b));
    const asText = this.blocksToFallbackText(content.blocks.filter(b => !this.supportsBlock(b)));
    // Render filtered as native, append asText as plain
  }
}
```

WhatsApp sees more than 3 buttons → adapter converts extras to list message or plain-text "reply 1/2/3" options. A skill that uses a `code` block gets it as a monospace-fenced block on Slack/Discord/Telegram; WhatsApp doesn't support monospace, so it just shows the text.

---

## 7. Rich Features

### 7.1 Threads

| Platform | Thread model |
|---|---|
| Slack | Parent message `ts`, replies share `thread_ts` |
| Discord | Separate thread object under a channel; own ID |
| Telegram | Topics in supergroups (skip for v1) |
| WhatsApp | No threads |

Session mapping: `sessionId = chat:{channel}:{conversation}:{threadId ?? 'main'}`. Each thread is its own session by default.

### 7.2 Reactions

All four support bot reactions. Use them as:

- **Ack for received**: 👀 when the bot starts processing, ✅ when done.
- **Disambiguate intent**: if a user asks "which one?" and you need a pick, send buttons; if they're picking from a short list, reactions (1️⃣2️⃣3️⃣) work.
- **Subtle status**: ⏳ for long-running, ❌ for errors.

### 7.3 File / media

| Platform | Upload limit | Features |
|---|---|---|
| Telegram | 50MB (bot API), 2GB (MTProto) | Native preview for common types |
| Discord | 25MB (Nitro boost: up to 500MB) | Inline preview |
| Slack | ~1GB | Preview, search, permalink |
| WhatsApp | 100MB | Images/docs/audio/video/stickers |

Agents use media bidirectionally:
- **Inbound**: voice notes become transcribed text events (`chat.voice` kind).
- **Outbound**: long responses → upload as `.md` file instead of splitting text.

### 7.4 Slash commands

- **Telegram**: any message starting with `/`. Register via BotFather for autocomplete.
- **Discord**: registered via API, appear in slash-command picker. Arguments with types.
- **Slack**: defined in app manifest, point to your URL.
- **WhatsApp**: no native. Emulate with list messages or keyword detection.

Route slash commands through the existing command dispatch:

```typescript
// In the adapter's inbound path:
if (message.text?.startsWith('/')) {
  await this.bus.publish({
    // ...
    kind: 'user.input',
    payload: { text: message.text, fromSlashCommand: true },
    // ...
  });
}
```

### 7.5 Interactive components

Buttons and selects arrive as a different event kind (`channel.interaction`). Route them to the same session with context:

```typescript
const interactionEvent = {
  kind: 'channel.interaction',
  target: { type: 'session', sessionId, action: 'inject' },
  payload: {
    interaction: 'button',
    buttonId: 'track',
    originalMessage: { id: '...', text: '...' },
    from: { id: 'user123', name: 'Alice' },
  },
};
```

The dispatcher wraps this as:
```
<interaction>User clicked "Track" on message "...".</interaction>
```

The agent sees the button click as a conversational turn.

---

## 8. Identity & Permissions

Chat platforms have their own identity model. Map to your agent's.

### User mapping

```typescript
type IdentityMapping = {
  platformUser: { channel: string; userId: string; displayName?: string };
  agentUser?: { id: string; role: string; scopes: string[] };
  verified: boolean;
  verifiedAt?: number;
};
```

A platform user is **not automatically** an agent user. Three paths:

1. **Open**: anyone on the platform can talk to the agent. Permissions are minimal. Good for support bots.
2. **Allowlist**: only mapped users are allowed. Config file or DB.
3. **Enrollment flow**: user DMs the bot, agent sends them an auth link, OAuth maps their platform ID to an agent account.

### Permission scoping

Per-channel config + per-user overrides:

```yaml
- id: slack-prod
  permissions:
    mode: auto
    allow: ["Read(**/*)", "mcp__calendar__*"]
    deny: ["Bash(*)", "Edit(**/*)"]
    userOverrides:
      - userIdPattern: "U0ADMIN*"
        allow: ["*"]
      - userIdPattern: "U0BOT*"
        deny: ["*"]
```

When a Slack admin DMs the bot, they get broader tools. Random workspace member gets read-only.

### Audit

Log every event with `channel_id`, `user_id`, `conversation_id`. You will be asked "who told the bot to do that?"

---

## 9. Rate Limits Per Platform

| Platform | Inbound | Outbound | Notes |
|---|---|---|---|
| Telegram | None (you pull or get pushed) | 30 msg/s global, 20 msg/min per group | Burst allowed; bot gets 429 with retry_after |
| Discord | Gateway: no hard cap; depends on shard | 5/5s per channel; 50/s global; REST buckets | Obey `X-RateLimit-*` headers |
| Slack | No hard cap on events | Tier-based: chat.postMessage is Tier 1 (~1/s) per workspace | Bolt SDK handles retries |
| WhatsApp | No inbound limit | Phone number tier: 1K/24h (new) → 100K+ (established) | Meta auto-promotes on quality |

### Strategy

- **Per-channel token bucket** in the adapter. Refuse to exceed.
- **Per-conversation spacing**: never more than one outbound every ~1s to the same user, even if limits allow. Respects UX.
- **Backpressure into the session**: if the channel is throttled, pause the session's output until the queue drains.

### Retry on 429

Every adapter's `send()` must handle rate-limit errors:

```typescript
async send(params): Promise<SentMessage> {
  try {
    return await this.rawSend(params);
  } catch (e) {
    if (isRateLimit(e)) {
      await sleep(parseRetryAfter(e));
      return this.rawSend(params);   // one retry; escalate if still limited
    }
    throw e;
  }
}
```

---

## 10. Worked Examples

### 10.1 Unified support bot

Same skill (`support-triage`) serves all four platforms:

```yaml
channels:
  - id: telegram-support
    type: telegram
    routing: { targetSelector: { type: skill, name: support-triage } }
  - id: slack-support
    type: slack
    routing: { targetSelector: { type: skill, name: support-triage } }
  - id: discord-support
    type: discord
    routing: { targetSelector: { type: skill, name: support-triage } }
  - id: whatsapp-support
    type: whatsapp
    routing: { targetSelector: { type: skill, name: support-triage } }
```

Skill emits rich blocks. Four adapters render them platform-native. One skill codebase, four channels, zero duplication.

### 10.2 On-call handoff

PagerDuty webhook → `incident-triage` skill → reply in the on-call Slack channel with:
- Heading: incident summary
- Paragraph: initial investigation
- Button-row: `[Acknowledge]` `[Page backup]` `[Post update]`

On-call clicks a button → button event → same session → agent takes the action.

### 10.3 Cross-channel thread

User starts in Telegram. Escalates to "let's continue in Slack for async." The agent writes a handoff message in both:

- Telegram: "I've mirrored this thread to Slack #eng-support. Follow up there."
- Slack: starts a thread with full history summary.

Both sessions share a `correlationId` so audit can reconstruct the cross-channel flow.

### 10.4 Voice-in, voice-out

- WhatsApp voice note arrives → adapter detects `audio` → fetches media → transcribes via MCP speech-to-text → publishes `chat.voice` event with `transcript` field.
- Agent responds with text → adapter runs text-to-speech → sends voice message back.

Users talk to the agent in voice, agent talks back in voice, both over WhatsApp.

### 10.5 Interactive onboarding

New Discord server member joins → welcome message in #intro with buttons `[I'm a developer]` `[I'm a user]` `[Just looking]`. Button click updates the user's roles, sends a tailored next step, schedules a follow-up via `ScheduleWakeup` to check back in 24h.

---

## 11. Build Order

### Milestone C1 — ChannelAdapter contract (2–3 days)

Define `ChannelAdapter`, `ChannelInstance`, `RichBlock`, `MessageContent`, `ConversationRef`. Build the outbound bridge. Wire to existing session manager.

### Milestone C2 — Telegram (4–5 days)

The easiest adapter. Long-polling first, webhook second. Text + buttons + files. Validates the whole pipeline end-to-end.

### Milestone C3 — Outbound unified renderer (2–3 days)

`RichBlock → Platform` translator. Fallback logic for unsupported blocks. Test that one skill's output renders sensibly on all target platforms (even if only Telegram is live).

### Milestone C4 — Slack (4–5 days)

Socket Mode first (no public URL needed). Threads, Block Kit, slash commands. Scopes setup is ⅓ of the work; budget for it.

### Milestone C5 — Discord (4–5 days)

Gateway + interactions. Slash commands + buttons. Sharding can wait until scale demands it.

### Milestone C6 — WhatsApp (7–10 days)

The hard one. Cloud API integration. Template approval process (overlapping — start applications week 1). 24-hour window enforcement. Media download. Phone number tier management.

### Milestone C7 — Identity & allowlisting (3–4 days)

Enrollment flow, per-user permission overrides, audit. Critical before opening to real users.

### Milestone C8 — Voice + media (optional, 3–5 days)

STT/TTS via MCP. Voice-first UX across platforms that support it.

**Total: ~5–7 weeks** for all four platforms with shared infrastructure. Telegram alone: ~2 weeks. Slack alone: ~2-3 weeks. WhatsApp alone: ~3–4 weeks.

---

## 12. Pitfalls Per Platform

### Cross-platform

- **❌ Leaking platform-specific syntax in skills.** If your skill outputs Slack-flavored markdown (`*bold*`), Telegram users see literal asterisks. Keep skills clean; let adapters render.
- **❌ Not deduping by platform message ID.** Webhooks retry. Without dedup, you spawn twin sessions on every retry.
- **❌ Ignoring threads.** Replying to a thread in the parent channel is spammy. Always preserve thread context.
- **❌ Mixing inbound webhook auth with session auth.** The webhook signature proves the message is genuine. The platform user's permissions are a separate question.
- **❌ Letting the bot reply to itself.** Always filter `bot_id` / `is_bot` on inbound; infinite loop otherwise.
- **❌ No idempotency on outbound sends.** A retry sends duplicate messages. Use `idempotencyKey` in every `send()` call.

### Telegram

- **❌ MarkdownV2 escaping bugs.** Every `.`, `-`, `(`, `)`, `!`, etc. must be escaped. Write and test an escaper. One bad character = the whole message fails with 400.
- **❌ Forgetting to disable privacy mode** for general-purpose bots. Your bot sees nothing in groups otherwise.
- **❌ Long-polling + horizontal scaling.** Only one process can `getUpdates` at a time. Use webhooks above one instance.

### Discord

- **❌ Missing intents.** No error, just silence. Read the intent docs and match exactly.
- **❌ Forgetting interaction ack.** 3-second deadline. Always `deferReply()` if the work will take longer.
- **❌ Per-instance slash command registration.** Register globally once, not in every worker.
- **❌ DMing users who don't share a guild.** Discord blocks this for spam prevention.

### Slack

- **❌ `text` field missing from `chat.postMessage`.** Notifications show "message from bot" instead of content; search doesn't index.
- **❌ Not handling `message.channels` subtypes.** Edits, deletes, thread_broadcast all come through; filter carefully.
- **❌ Assuming threads on every reply.** `thread_ts` must only be set if replying to a thread. Otherwise you silently start a new one.
- **❌ Hitting scope limits during app review.** If you distribute via Marketplace, Slack reviews scopes. Less is more.

### WhatsApp

- **❌ Sending free-form outside 24h.** Hard-fails. Agent must track window per conversation.
- **❌ Not registering templates early.** Approval takes days. Start template registration week 1, not week 4.
- **❌ Sending to unverified numbers.** Tier 1 = 1K per 24h. Send to random numbers, quality drops, you get throttled. Only opt-in users.
- **❌ Storing media permanently.** Meta-hosted URLs expire. Download and re-host if you need persistence.
- **❌ Treating groups like 1:1.** Groups have their own API with stricter rules. Most features you'd want aren't available.
- **❌ Ignoring business profile compliance.** Display name, category, verification — Meta requires all. Dodge it and get blocked mid-launch.

---

## Closing Thought

The fourth in a pattern series: plugins, MCP, skills, event sources, now channels. Every layer is the same shape — **contract + registry + lifecycle + scoped permissions + declarative config**. The new thing channels add is **bidirectionality**: the agent speaks back. That one change ripples through in rich rendering, identity mapping, rate limits, conversation-window policy, and capability negotiation.

The payoff: your agent becomes a **multi-platform participant.** A user can ask it something on WhatsApp, get a follow-up in Slack, click a button on Discord, and continue the same correlated workflow on Telegram. The infrastructure doesn't care where the human shows up.

Build the contract. Ship Telegram first. Let the learnings shape the rest. One platform at a time until you've covered the ones your users actually live in.

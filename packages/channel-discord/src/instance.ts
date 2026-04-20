import {
  BaseChannelInstance,
  type BaseChannelOptions,
  type ChannelAction,
  type ChannelDependencies,
  ChannelRateLimitError,
  type ConversationRef,
  type DiscordActionRow,
  type DiscordEmbed,
  type DiscordPayload,
  type FileRef,
  type FileUpload,
  type MessageContent,
  type MessageRef,
  type SendMessageParams,
  type SentMessage,
  type WebhookRequest,
  type WebhookResponse,
  renderDiscord,
} from '@declaragent/core';
import { DISCORD_CAPABILITIES } from './capabilities.js';
import {
  DiscordApiError,
  type DiscordClient,
  type GatewayTransport,
  createDiscordClient,
} from './client.js';
import {
  type ArchivedThreadPolicy,
  type DiscordChannelConfig,
  type DiscordSlashCommandConfig,
  computeIntentsBitfield,
} from './config.js';
import type {
  DiscordChannel,
  DiscordGatewayPayload,
  DiscordInteraction,
  DiscordMessage,
  DiscordUser,
} from './discord-api.js';
import { verifyDiscordSignature } from './ed25519.js';
import { type ParsedUpdate, parseDiscordEvent } from './update-parser.js';

/**
 * Refresh the typing indicator slightly ahead of Discord's ~10s expiry.
 */
const TYPING_RENEWAL_MS = 8_000;
const TYPING_DEFAULT_DURATION_MS = 10_000;

export interface DiscordChannelInstanceOptions {
  config: DiscordChannelConfig;
  deps: ChannelDependencies;
  /** Test seam: supply a stub client. Production defaults via `createDiscordClient`. */
  client?: DiscordClient;
  /** Logger seam that fires whenever a parsed inbound is published. */
  onInbound?: (parsed: ParsedUpdate) => void;
}

/**
 * Discord channel instance. Subclasses `BaseChannelInstance`.
 *
 * Responsibilities:
 * - Connect the Gateway (MESSAGE_CREATE + INTERACTION_CREATE) OR expose
 *   a webhook endpoint (outgoing interactions via HTTP) and fan events
 *   onto the bus as normalized `AgentEvent`s.
 * - Register global slash commands once at start (content-hash dedupe).
 * - Ack interactions within the 3-second window via a deferred
 *   callback; the bridge delivers the real reply as a follow-up.
 * - Render outbound `MessageContent` through `renderDiscord` and issue
 *   the appropriate REST call.
 * - Auto-unarchive archived threads before sending, per
 *   `archivedThreadPolicy`.
 */
export class DiscordChannelInstance extends BaseChannelInstance {
  private readonly discordConfig: DiscordChannelConfig;
  private readonly client: DiscordClient;
  private readonly onInbound?: (parsed: ParsedUpdate) => void;

  private gateway: GatewayTransport | null = null;
  private botUser: DiscordUser | null = null;

  /** conversationId → refresh timer. */
  private readonly typingRenewals = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * (interactionId → token) map for interactions that have been acked
   * but whose follow-up hasn't landed yet. The outbound path consults
   * it so a send that targets an interaction-initiated conversation
   * uses `createFollowupMessage` instead of `sendMessage`.
   *
   * Keyed by `conversationId` so the bridge can look up "does this
   * conversation have a pending interaction reply?" without knowing the
   * interaction id itself.
   */
  private readonly pendingFollowups = new Map<
    string,
    { interactionId: string; token: string; expiresAt: number }
  >();

  /**
   * Slash-command-register dedupe cache. Keyed by the applicationId so
   * multiple instances pointing at the same bot can share the signal.
   * Value is the command set content hash.
   */
  private registeredCommandsHash: string | null = null;

  constructor(opts: DiscordChannelInstanceOptions) {
    const base: BaseChannelOptions = {
      type: 'discord',
      config: {
        id: opts.config.id,
        routing: opts.config.routing,
        delivery: opts.config.delivery,
        limits: opts.config.limits,
        ...(opts.config.outbound !== undefined && { outbound: opts.config.outbound }),
        ...(opts.config.idempotency !== undefined && { idempotency: opts.config.idempotency }),
      },
      deps: opts.deps,
      capabilities: DISCORD_CAPABILITIES,
    };
    super(base);
    this.discordConfig = opts.config;
    if (opts.onInbound !== undefined) this.onInbound = opts.onInbound;
    this.client =
      opts.client ??
      createDiscordClient({
        botToken: opts.config.transport.botToken,
        applicationId: opts.config.transport.applicationId,
      });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    try {
      this.botUser = await this.client.getCurrentUser();
    } catch (err) {
      this.channelDeps.logger.warn('discord.getCurrentUser.failed', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Register slash commands (deduped by content hash).
    await this.maybeRegisterSlashCommands();

    // Open Gateway connection.
    const intents = computeIntentsBitfield(this.discordConfig.transport.intents);
    const shardId = this.discordConfig.transport.shardId;
    const shardCount = this.discordConfig.transport.shardCount ?? 1;
    this.gateway = this.client.createGatewayTransport({
      botToken: this.discordConfig.transport.botToken,
      intents,
      ...(shardId !== undefined && { shard: [shardId, shardCount] as [number, number] }),
    });
    this.gateway.onEvent((payload) => {
      void this.onGatewayEvent(payload);
    });
    this.gateway.onDisconnect?.((reason) => {
      // TODO: implement resume/reconnect. For now we log; operator
      // restarts the process to recover.
      this.channelDeps.logger.warn('discord.gateway.disconnected', {
        id: this.id,
        reason,
      });
    });
    try {
      await this.gateway.connect();
    } catch (err) {
      this.channelDeps.logger.warn('discord.gateway.connect.failed', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  protected async doStop(): Promise<void> {
    for (const timer of this.typingRenewals.values()) clearTimeout(timer);
    this.typingRenewals.clear();
    if (this.gateway) {
      try {
        await this.gateway.close();
      } catch {
        /* noop */
      }
      this.gateway = null;
    }
  }

  protected async doPause(): Promise<void> {
    // Discord has no "stop consuming" switch; closing the Gateway is the
    // only way. Pause semantics = drop the socket, resume re-connects.
    if (this.gateway) {
      try {
        await this.gateway.close();
      } catch {
        /* noop */
      }
      this.gateway = null;
    }
  }

  protected async doResume(): Promise<void> {
    const intents = computeIntentsBitfield(this.discordConfig.transport.intents);
    this.gateway = this.client.createGatewayTransport({
      botToken: this.discordConfig.transport.botToken,
      intents,
    });
    this.gateway.onEvent((payload) => {
      void this.onGatewayEvent(payload);
    });
    try {
      await this.gateway.connect();
    } catch (err) {
      this.channelDeps.logger.warn('discord.gateway.resume.failed', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {
      gatewayOpen: this.gateway !== null,
      botUserId: this.botUser?.id ?? null,
      pendingFollowups: this.pendingFollowups.size,
      typingActive: this.typingRenewals.size,
      registeredCommands: this.registeredCommandsHash !== null,
    };
  }

  protected async sendToDLQ(): Promise<void> {
    // Channel-native inbound bypasses BaseSourceInstance's retry/DLQ path.
  }

  // ── Slash commands ───────────────────────────────────────────────────────

  private async maybeRegisterSlashCommands(): Promise<void> {
    const cmds = this.discordConfig.slashCommands;
    if (!cmds || cmds.length === 0) return;
    const hash = await contentHash(cmds);
    const storeKey = `discord:${this.discordConfig.transport.applicationId}:commands-hash`;
    const store = this.channelDeps.conversationStore;
    const prev = store ? await store.get(storeKey) : null;
    if (prev === hash) {
      this.registeredCommandsHash = hash;
      return; // unchanged since last run
    }
    try {
      await this.client.registerGlobalCommands({
        applicationId: this.discordConfig.transport.applicationId,
        commands: cmds.map((c) => ({
          name: c.name,
          description: c.description,
          type: 1,
        })),
      });
      this.registeredCommandsHash = hash;
      if (store) await store.set(storeKey, hash);
    } catch (err) {
      this.channelDeps.logger.warn('discord.slashCommands.register.failed', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Gateway event fan-out ────────────────────────────────────────────────

  private async onGatewayEvent(payload: DiscordGatewayPayload): Promise<void> {
    if (payload.op !== 0) return;
    const t = payload.t;
    if (t === 'READY') {
      const data = payload.d as { user?: DiscordUser } | null;
      if (data?.user) this.botUser = data.user;
      return;
    }
    if (t === 'MESSAGE_CREATE') {
      const msg = payload.d as DiscordMessage;
      await this.ingestMessage(msg);
      return;
    }
    if (t === 'INTERACTION_CREATE') {
      const interaction = payload.d as DiscordInteraction;
      await this.ingestInteraction(interaction);
      return;
    }
  }

  private async ingestMessage(msg: DiscordMessage): Promise<void> {
    const parsed = parseDiscordEvent(
      { kind: 'MESSAGE_CREATE', data: msg },
      { channelId: this.id, ...(this.botUser && { botUserId: this.botUser.id }) },
    );
    if (!parsed) return;
    try {
      await this.publishInbound(parsed.event);
      this.onInbound?.(parsed);
    } catch (err) {
      this.channelDeps.logger.warn('discord.publish.failed', {
        id: this.id,
        messageId: msg.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async ingestInteraction(interaction: DiscordInteraction): Promise<void> {
    const parsed = parseDiscordEvent(
      { kind: 'INTERACTION_CREATE', data: interaction },
      { channelId: this.id, ...(this.botUser && { botUserId: this.botUser.id }) },
    );
    if (!parsed || !parsed.interaction) return;

    // Ack the interaction immediately (< 3s). Use type 5 so the real
    // content arrives as a follow-up via the interaction token.
    try {
      await this.client.createInteractionResponse({
        interactionId: parsed.interaction.interactionId,
        interactionToken: parsed.interaction.interactionToken,
        response: { type: 5 },
      });
    } catch (err) {
      this.channelDeps.logger.warn('discord.interaction.ack.failed', {
        id: this.id,
        interactionId: parsed.interaction.interactionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Remember the pending follow-up so the next outbound send for this
    // conversation uses `createFollowupMessage` instead of a cold send.
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min interaction token window
    this.pendingFollowups.set(parsed.conversation.conversationId, {
      interactionId: parsed.interaction.interactionId,
      token: parsed.interaction.interactionToken,
      expiresAt,
    });

    try {
      await this.publishInbound(parsed.event);
      this.onInbound?.(parsed);
    } catch (err) {
      this.channelDeps.logger.warn('discord.publish.failed', {
        id: this.id,
        interactionId: parsed.interaction.interactionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Webhook mode (HTTP interactions) ─────────────────────────────────────

  override async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    // Phase 6 slice 4: Ed25519 verification via Web Crypto. Discord
    // signs every interaction webhook; unsigned OR tamper-altered bodies
    // MUST be rejected. 401 bodies carry no internal detail.
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const publicKey = this.discordConfig.transport.publicKey;
    if (!publicKey) {
      this.channelDeps.logger.error('discord.webhook.no-public-key', {
        id: this.id,
        hint: 'transport.publicKey is required when Discord webhook mode is used',
      });
      return { status: 401, body: 'unauthorized' };
    }
    if (!signature || !timestamp) {
      return { status: 401, body: 'unauthorized' };
    }
    const verified = await verifyDiscordSignature({
      publicKeyHex: publicKey,
      signatureHex: signature,
      timestamp,
      body: req.body,
    });
    if (!verified) {
      this.channelDeps.logger.warn('discord.webhook.signature.invalid', {
        id: this.id,
      });
      return { status: 401, body: 'unauthorized' };
    }

    let interaction: DiscordInteraction;
    try {
      const text = new TextDecoder().decode(req.body);
      interaction = JSON.parse(text) as DiscordInteraction;
    } catch {
      return { status: 400, body: 'invalid request' };
    }

    // Respond inline for PING (type 1) so Discord's webhook-health check passes.
    if (interaction.type === 1) {
      return {
        status: 200,
        body: JSON.stringify({ type: 1 }),
        headers: { 'content-type': 'application/json' },
      };
    }

    await this.ingestInteraction(interaction);
    // Reply with the 3-second DEFERRED ack. The real follow-up is sent
    // asynchronously via `createFollowupMessage`.
    return {
      status: 200,
      body: JSON.stringify({ type: 5 }),
      headers: { 'content-type': 'application/json' },
    };
  }

  // ── Outbound ─────────────────────────────────────────────────────────────

  protected override async doSend(params: SendMessageParams): Promise<SentMessage> {
    const payload = renderDiscord(params.content, { capabilities: this.capabilities });
    const targetChannelId = params.conversation.threadId ?? params.conversation.conversationId;

    // Auto-unarchive archived threads per policy.
    let effectiveChannelId = targetChannelId;
    let fallbackToParent = false;
    if (params.conversation.threadId !== undefined) {
      const action = await this.ensureThreadSendable(params.conversation.threadId);
      if (action === 'drop') {
        throw new Error(
          `discord: thread ${params.conversation.threadId} is archived and policy is "drop"`,
        );
      }
      if (action === 'parent-reply') {
        fallbackToParent = true;
        effectiveChannelId = params.conversation.conversationId;
      }
    }

    // If there's a pending interaction follow-up, use it.
    const followup = this.takeFollowup(params.conversation.conversationId);

    try {
      const sent = await this.sendViaClient(
        payload,
        effectiveChannelId,
        params,
        followup,
        fallbackToParent,
      );
      return sent;
    } catch (err) {
      throw mapDiscordError(err);
    }
  }

  private async sendViaClient(
    payload: DiscordPayload,
    channelId: string,
    params: SendMessageParams,
    followup: { interactionId: string; token: string } | null,
    fallbackToParent: boolean,
  ): Promise<SentMessage> {
    const message_reference =
      params.replyTo && !fallbackToParent
        ? { message_id: params.replyTo.id, channel_id: channelId }
        : undefined;

    // Map the payload kind to the right REST call.
    switch (payload.kind) {
      case 'text': {
        if (followup) {
          const msg = await this.client.createFollowupMessage({
            applicationId: this.discordConfig.transport.applicationId,
            interactionToken: followup.token,
            content: payload.content,
          });
          return this.toSentMessage(msg, params.conversation);
        }
        const msg = await this.client.sendMessage({
          channelId,
          content: payload.content,
          ...(message_reference !== undefined && { message_reference }),
        });
        return this.toSentMessage(msg, params.conversation);
      }
      case 'rich': {
        const embeds = payload.embeds as DiscordEmbed[];
        const components = payload.components as DiscordActionRow[];
        if (followup) {
          const msg = await this.client.createFollowupMessage({
            applicationId: this.discordConfig.transport.applicationId,
            interactionToken: followup.token,
            ...(payload.content !== undefined && { content: payload.content }),
            embeds,
            components,
          });
          return this.toSentMessage(msg, params.conversation);
        }
        const msg = await this.client.sendMessage({
          channelId,
          ...(payload.content !== undefined && { content: payload.content }),
          embeds,
          components,
          ...(message_reference !== undefined && { message_reference }),
        });
        return this.toSentMessage(msg, params.conversation);
      }
      case 'file': {
        const files = payload.files.map((f) => ({
          name: f.name,
          ...(f.url !== undefined && { url: f.url }),
          ...(f.path !== undefined && { path: f.path }),
        }));
        const msg = await this.client.sendMessage({
          channelId,
          ...(payload.content !== undefined && { content: payload.content }),
          files,
          ...(message_reference !== undefined && { message_reference }),
        });
        return this.toSentMessage(msg, params.conversation);
      }
      case 'voice': {
        const files = payload.files.map((f) => ({
          name: f.name,
          ...(f.url !== undefined && { url: f.url }),
          ...(f.path !== undefined && { path: f.path }),
        }));
        const msg = await this.client.sendMessage({
          channelId,
          files,
          ...(message_reference !== undefined && { message_reference }),
        });
        return this.toSentMessage(msg, params.conversation);
      }
      case 'template': {
        // Discord has no template system. Emit a plain-text rendering.
        const body = `[template: ${payload.name}]${Object.entries(payload.params)
          .map(([k, v]) => `\n  ${k}: ${v}`)
          .join('')}`;
        const msg = await this.client.sendMessage({ channelId, content: body });
        return this.toSentMessage(msg, params.conversation);
      }
      default: {
        const exhaustive: never = payload;
        void exhaustive;
        throw new Error('discord: unhandled payload kind');
      }
    }
  }

  private toSentMessage(msg: DiscordMessage, conversation: ConversationRef): SentMessage {
    const sent: SentMessage = {
      id: msg.id,
      conversation,
    };
    const ts = msg.timestamp ? Date.parse(msg.timestamp) : Number.NaN;
    if (!Number.isNaN(ts)) sent.sentAt = ts;
    return sent;
  }

  /**
   * Check whether a thread is archived; if so, apply the configured
   * policy. Returns the action the caller should take.
   */
  private async ensureThreadSendable(threadId: string): Promise<'send' | 'parent-reply' | 'drop'> {
    const policy: ArchivedThreadPolicy = this.discordConfig.archivedThreadPolicy ?? 'unarchive';
    let channel: DiscordChannel;
    try {
      channel = await this.client.getChannel(threadId);
    } catch (err) {
      this.channelDeps.logger.debug('discord.getChannel.failed', {
        id: this.id,
        threadId,
        err: err instanceof Error ? err.message : String(err),
      });
      return 'send';
    }
    if (!channel.thread_metadata?.archived) return 'send';
    if (policy === 'drop') return 'drop';
    if (policy === 'parent-reply') return 'parent-reply';
    // `unarchive`: try to unarchive; on failure fall back to parent reply.
    try {
      await this.client.unarchiveThread({ threadId });
      return 'send';
    } catch (err) {
      this.channelDeps.logger.warn('discord.thread.unarchive.failed', {
        id: this.id,
        threadId,
        err: err instanceof Error ? err.message : String(err),
      });
      return 'parent-reply';
    }
  }

  private takeFollowup(conversationId: string): { interactionId: string; token: string } | null {
    const entry = this.pendingFollowups.get(conversationId);
    if (!entry) return null;
    // One-shot: consume it.
    this.pendingFollowups.delete(conversationId);
    if (Date.now() > entry.expiresAt) return null;
    return { interactionId: entry.interactionId, token: entry.token };
  }

  // ── Auxiliary outbound ops ───────────────────────────────────────────────

  override setTyping = async (
    conversation: ConversationRef,
    durationMs?: number,
  ): Promise<void> => {
    const channelId = conversation.threadId ?? conversation.conversationId;
    const clearPrevious = this.typingRenewals.get(channelId);
    if (clearPrevious) clearTimeout(clearPrevious);

    const sendOnce = async () => {
      try {
        await this.client.triggerTypingIndicator({ channelId });
      } catch (err) {
        this.channelDeps.logger.debug('discord.typing.error', {
          id: this.id,
          channelId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };
    await sendOnce();
    const budget = durationMs ?? TYPING_DEFAULT_DURATION_MS;
    if (budget <= 0) return;
    let remaining = budget;
    const schedule = () => {
      const delayMs = Math.min(TYPING_RENEWAL_MS, remaining);
      const timer = setTimeout(async () => {
        remaining -= delayMs;
        if (remaining <= 0) {
          this.typingRenewals.delete(channelId);
          return;
        }
        await sendOnce();
        schedule();
      }, delayMs);
      this.typingRenewals.set(channelId, timer);
    };
    schedule();
  };

  override react = async (ref: MessageRef, emoji: string): Promise<void> => {
    await this.client.createReaction({
      channelId: ref.conversation.threadId ?? ref.conversation.conversationId,
      messageId: ref.id,
      emoji,
    });
  };

  override edit = async (ref: MessageRef, content: MessageContent): Promise<void> => {
    const payload = renderDiscord(content, { capabilities: this.capabilities });
    const channelId = ref.conversation.threadId ?? ref.conversation.conversationId;
    switch (payload.kind) {
      case 'text':
        await this.client.editMessage({
          channelId,
          messageId: ref.id,
          content: payload.content,
        });
        return;
      case 'rich':
        await this.client.editMessage({
          channelId,
          messageId: ref.id,
          ...(payload.content !== undefined && { content: payload.content }),
          embeds: payload.embeds,
          components: payload.components,
        });
        return;
      default:
        throw new Error(
          `discord edit only supports text/rich content (got ${payload.kind}); delete + re-send for other kinds`,
        );
    }
  };

  override delete = async (ref: MessageRef): Promise<void> => {
    await this.client.deleteMessage({
      channelId: ref.conversation.threadId ?? ref.conversation.conversationId,
      messageId: ref.id,
    });
  };

  override uploadFile = async (
    _file: FileUpload,
    _conversation: ConversationRef,
  ): Promise<FileRef> => {
    // Discord has no standalone upload endpoint; files ride along on
    // `sendMessage`. Callers should use `send({ kind: 'file' })`.
    throw new Error(
      'discord: standalone uploadFile is not supported. Use send() with kind: "file".',
    );
  };

  override performAction = async (_action: ChannelAction): Promise<void> => {
    throw new Error('discord: performAction is not supported in v0.9');
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapDiscordError(err: unknown): unknown {
  if (err instanceof DiscordApiError && err.status === 429) {
    return new ChannelRateLimitError(err.retryAfterMs ?? 1000, err.message);
  }
  return err;
}

/**
 * Stable content hash for slash-command dedupe. Uses
 * `crypto.subtle.digest` (available globally in Bun + modern Node) over
 * the JSON-stable form of the command list.
 */
async function contentHash(commands: readonly DiscordSlashCommandConfig[]): Promise<string> {
  const sorted = [...commands]
    .map((c) => ({ name: c.name, description: c.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const buf = new TextEncoder().encode(JSON.stringify(sorted));
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

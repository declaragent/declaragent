import {
  BaseChannelInstance,
  type BaseChannelOptions,
  type ChannelAction,
  type ChannelDependencies,
  type ChannelMessageContent,
  ChannelRateLimitError,
  type ConversationRef,
  type FileRef,
  type FileUpload,
  type MessageRef,
  type SendMessageParams,
  type SentMessage,
  type WebhookRequest,
  type WebhookResponse,
  renderTelegram,
} from '@declaragent/core';
import { TELEGRAM_CAPABILITIES } from './capabilities.js';
import { TelegramApiError, type TelegramClient, createTelegramClient } from './client.js';
import type { TelegramChannelConfig } from './config.js';
import type { TelegramBotInfo, TelegramUpdate } from './telegram-api.js';
import { type ParsedUpdate, parseUpdate } from './update-parser.js';

/**
 * Poll timeout the adapter uses by default. Telegram's getUpdates accepts
 * up to 50s; we stop slightly earlier so a shutdown signal lands quickly.
 */
const DEFAULT_POLL_TIMEOUT_SEC = 50;
const DEFAULT_POLL_LIMIT = 100;
/** Re-send `typing` chat action this often. Telegram auto-expires at ~5s. */
const TYPING_RENEWAL_MS = 4_000;
const TYPING_RENEWAL_DEFAULT_DURATION_MS = 10_000;

export interface TelegramChannelInstanceOptions {
  config: TelegramChannelConfig;
  deps: ChannelDependencies;
  /**
   * Test seam: supply a stub client. Production builds default via
   * `createTelegramClient(botToken)`.
   */
  client?: TelegramClient;
  /** Logger seam that fires whenever a parsed inbound is published. */
  onInbound?: (parsed: ParsedUpdate) => void;
}

/**
 * Telegram channel instance. Subclasses `BaseChannelInstance`.
 *
 * Responsibilities:
 * - Long-polling loop OR webhook handler (based on config).
 * - Convert incoming Telegram updates → `AgentEvent` → bus.
 * - Render outbound `ChannelMessageContent` via `renderTelegram` and call the
 *   matching Bot API method.
 * - Manage a small `file_id` cache so repeated sends of the same
 *   `FileRef` skip re-upload.
 */
export class TelegramChannelInstance extends BaseChannelInstance {
  private readonly telegramConfig: TelegramChannelConfig;
  private readonly client: TelegramClient;
  private readonly onInbound?: (parsed: ParsedUpdate) => void;

  private longPollAbort: AbortController | null = null;
  private longPollRunning = false;
  private lastUpdateId = 0;
  private botInfo: TelegramBotInfo | null = null;

  /** conversationId → window-end ms */
  private readonly typingRenewals = new Map<string, ReturnType<typeof setTimeout>>();

  /** `file hash / local path → file_id` cache. */
  private readonly fileIdCache = new Map<string, string>();

  constructor(opts: TelegramChannelInstanceOptions) {
    const base: BaseChannelOptions = {
      type: 'telegram',
      config: {
        id: opts.config.id,
        routing: opts.config.routing,
        delivery: opts.config.delivery,
        limits: opts.config.limits,
        ...(opts.config.outbound !== undefined && { outbound: opts.config.outbound }),
        ...(opts.config.idempotency !== undefined && { idempotency: opts.config.idempotency }),
      },
      deps: opts.deps,
      capabilities: TELEGRAM_CAPABILITIES,
    };
    super(base);
    this.telegramConfig = opts.config;
    if (opts.onInbound !== undefined) this.onInbound = opts.onInbound;
    this.client =
      opts.client ??
      createTelegramClient({
        token: opts.config.transport.botToken,
        ...(opts.config.transport.baseUrl !== undefined && {
          baseUrl: opts.config.transport.baseUrl,
        }),
      });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    // Preflight: warn if privacy mode hides group messages.
    const warnOnPrivacy = this.telegramConfig.warnOnPrivacyMode ?? true;
    try {
      this.botInfo = await this.client.getMe();
      if (warnOnPrivacy && this.botInfo.can_read_all_group_messages === false) {
        this.channelDeps.logger.warn('telegram.privacy_mode_on', {
          id: this.id,
          botUsername: this.botInfo.username,
          hint: 'privacy mode is on — bot only sees /commands + @mentions in groups. Disable via @BotFather > Bot Settings > Group Privacy.',
        });
      }
    } catch (err) {
      this.channelDeps.logger.warn('telegram.getme.failed', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    if (this.telegramConfig.transport.mode === 'webhook') {
      await this.setupWebhook();
    } else {
      this.startLongPolling();
    }
  }

  protected async doStop(): Promise<void> {
    this.longPollAbort?.abort();
    this.longPollAbort = null;
    for (const timer of this.typingRenewals.values()) clearTimeout(timer);
    this.typingRenewals.clear();

    if (this.telegramConfig.transport.mode === 'webhook') {
      try {
        await this.client.deleteWebhook();
      } catch (err) {
        this.channelDeps.logger.warn('telegram.webhook.delete.failed', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  protected async doPause(): Promise<void> {
    this.longPollAbort?.abort();
    this.longPollAbort = null;
  }

  protected async doResume(): Promise<void> {
    if (this.telegramConfig.transport.mode === 'long-polling') {
      this.startLongPolling();
    }
  }

  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {
      mode: this.telegramConfig.transport.mode,
      botUsername: this.botInfo?.username ?? null,
      lastUpdateId: this.lastUpdateId,
      fileCacheSize: this.fileIdCache.size,
      typingActive: this.typingRenewals.size,
    };
  }

  protected async sendToDLQ(): Promise<void> {
    // Channel-native inbound bypasses BaseSourceInstance's retry/DLQ path;
    // failures surface via publishInbound. This stub satisfies the
    // abstract contract without routing anywhere.
  }

  // ── Long-polling ─────────────────────────────────────────────────────

  private startLongPolling(): void {
    if (this.longPollRunning) return;
    this.longPollRunning = true;
    const controller = new AbortController();
    this.longPollAbort = controller;
    // Fire-and-forget; the loop observes controller.signal.
    void this.runLongPoll(controller.signal);
  }

  private async runLongPoll(signal: AbortSignal): Promise<void> {
    const timeout = this.telegramConfig.transport.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC;
    const limit = this.telegramConfig.transport.pollLimit ?? DEFAULT_POLL_LIMIT;
    const allowedUpdates = [...(this.telegramConfig.transport.allowedUpdates ?? [])];
    try {
      while (!signal.aborted) {
        let updates: TelegramUpdate[];
        try {
          updates = await this.client.getUpdates({
            offset: this.lastUpdateId + 1,
            limit,
            timeout,
            ...(allowedUpdates.length > 0 && { allowed_updates: allowedUpdates }),
          });
        } catch (err) {
          this.channelDeps.logger.warn('telegram.getUpdates.error', {
            id: this.id,
            err: err instanceof Error ? err.message : String(err),
          });
          // Back off briefly before retrying; abort-aware.
          await delay(1000, signal);
          continue;
        }
        for (const update of updates) {
          if (signal.aborted) break;
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.ingestUpdate(update);
        }
        // Yield a macrotask slot so `setTimeout`-based callers (tests,
        // cron ticks) aren't starved by a tight microtask loop when
        // `getUpdates` resolves immediately (stub, on-prem low-latency).
        if (updates.length === 0) await delay(1, signal);
      }
    } finally {
      this.longPollRunning = false;
    }
  }

  // ── Webhook ──────────────────────────────────────────────────────────

  private async setupWebhook(): Promise<void> {
    const url = this.telegramConfig.transport.webhookUrl;
    const secret = this.telegramConfig.transport.webhookSecret;
    if (!url || !secret) return;
    const allowedUpdates = [...(this.telegramConfig.transport.allowedUpdates ?? [])];
    await this.client.setWebhook({
      url,
      secret_token: secret,
      ...(allowedUpdates.length > 0 && { allowed_updates: allowedUpdates }),
    });
  }

  override async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const mode = this.telegramConfig.transport.mode;
    if (mode !== 'webhook') return { status: 405, body: 'webhook mode not enabled' };

    const expectedSecret = this.telegramConfig.transport.webhookSecret;
    const providedSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (!expectedSecret || providedSecret !== expectedSecret) {
      return { status: 401, body: 'invalid secret' };
    }

    let update: TelegramUpdate;
    try {
      const text = new TextDecoder().decode(req.body);
      update = JSON.parse(text) as TelegramUpdate;
    } catch {
      return { status: 400, body: 'invalid JSON' };
    }
    this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
    await this.ingestUpdate(update);
    return { status: 200, body: '' };
  }

  private async ingestUpdate(update: TelegramUpdate): Promise<void> {
    const parsed = parseUpdate(update, { channelId: this.id });
    if (!parsed) return;
    try {
      await this.publishInbound(parsed.event);
      this.onInbound?.(parsed);
    } catch (err) {
      this.channelDeps.logger.warn('telegram.publish.failed', {
        id: this.id,
        updateId: update.update_id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // Ack the callback query immediately so the client's loading spinner clears.
    if (update.callback_query) {
      try {
        await this.client.answerCallbackQuery({ callback_query_id: update.callback_query.id });
      } catch {
        /* ack-only — ignore */
      }
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────────

  protected override async doSend(params: SendMessageParams): Promise<SentMessage> {
    const payload = renderTelegram(params.content, { capabilities: this.capabilities });
    const chatId = params.conversation.conversationId;
    const replyParameters = params.replyTo ? { message_id: Number(params.replyTo.id) } : undefined;
    try {
      switch (payload.kind) {
        case 'text': {
          const sendArgs: Parameters<TelegramClient['sendMessage']>[0] = {
            chat_id: chatId,
            text: payload.text,
            parse_mode: payload.parse_mode,
          };
          if (payload.reply_markup) sendArgs.reply_markup = payload.reply_markup;
          if (replyParameters) sendArgs.reply_parameters = replyParameters;
          const msg = await this.client.sendMessage(sendArgs);
          return {
            id: String(msg.message_id),
            conversation: params.conversation,
            sentAt: msg.date * 1000,
          };
        }
        case 'file': {
          const ref = payload.document.url ?? payload.document.path;
          if (ref === undefined) throw new Error('telegram file requires url or path');
          const docArgs: Parameters<TelegramClient['sendDocument']>[0] = {
            chat_id: chatId,
            document: this.fileIdCache.get(ref) ?? ref,
          };
          if (payload.caption !== undefined) docArgs.caption = payload.caption;
          if (payload.parse_mode !== undefined) docArgs.parse_mode = payload.parse_mode;
          if (replyParameters) docArgs.reply_parameters = replyParameters;
          const msg = await this.client.sendDocument(docArgs);
          this.cacheFileId(msg, ref);
          return {
            id: String(msg.message_id),
            conversation: params.conversation,
            sentAt: msg.date * 1000,
          };
        }
        case 'voice': {
          const ref = payload.voice.url ?? payload.voice.path;
          if (ref === undefined) throw new Error('telegram voice requires url or path');
          const voiceArgs: Parameters<TelegramClient['sendVoice']>[0] = {
            chat_id: chatId,
            voice: this.fileIdCache.get(ref) ?? ref,
          };
          if (payload.duration !== undefined) voiceArgs.duration = payload.duration;
          if (replyParameters) voiceArgs.reply_parameters = replyParameters;
          const msg = await this.client.sendVoice(voiceArgs);
          this.cacheFileId(msg, ref);
          return {
            id: String(msg.message_id),
            conversation: params.conversation,
            sentAt: msg.date * 1000,
          };
        }
        case 'template': {
          // Telegram has no native template system. Fall back to text body.
          const body = `[template: ${payload.name}]${Object.entries(payload.params)
            .map(([k, v]) => `\n  ${k}: ${v}`)
            .join('')}`;
          const msg = await this.client.sendMessage({
            chat_id: chatId,
            text: body,
          });
          return {
            id: String(msg.message_id),
            conversation: params.conversation,
            sentAt: msg.date * 1000,
          };
        }
        default: {
          const exhaustive: never = payload;
          void exhaustive;
          throw new Error('telegram: unhandled payload kind');
        }
      }
    } catch (err) {
      throw mapTelegramError(err);
    }
  }

  override setTyping = async (
    conversation: ConversationRef,
    durationMs?: number,
  ): Promise<void> => {
    const chatId = conversation.conversationId;
    const clearPrevious = this.typingRenewals.get(chatId);
    if (clearPrevious) clearTimeout(clearPrevious);

    const sendOnce = async () => {
      try {
        await this.client.sendChatAction({ chat_id: chatId, action: 'typing' });
      } catch (err) {
        this.channelDeps.logger.debug('telegram.typing.error', {
          id: this.id,
          chatId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };

    await sendOnce();
    const budget = durationMs ?? TYPING_RENEWAL_DEFAULT_DURATION_MS;
    if (budget <= 0) return;
    let remaining = budget;
    const schedule = () => {
      const delayMs = Math.min(TYPING_RENEWAL_MS, remaining);
      const timer = setTimeout(async () => {
        remaining -= delayMs;
        if (remaining <= 0) {
          this.typingRenewals.delete(chatId);
          return;
        }
        await sendOnce();
        schedule();
      }, delayMs);
      this.typingRenewals.set(chatId, timer);
    };
    schedule();
  };

  override react = async (ref: MessageRef, emoji: string): Promise<void> => {
    await this.client.setMessageReaction({
      chat_id: ref.conversation.conversationId,
      message_id: Number(ref.id),
      reaction: [{ type: 'emoji', emoji }],
    });
  };

  override edit = async (ref: MessageRef, content: ChannelMessageContent): Promise<void> => {
    const payload = renderTelegram(content, { capabilities: this.capabilities });
    if (payload.kind !== 'text') {
      throw new Error(
        `telegram edit only supports text content (got ${payload.kind}); delete + re-send for other kinds`,
      );
    }
    await this.client.editMessageText({
      chat_id: ref.conversation.conversationId,
      message_id: Number(ref.id),
      text: payload.text,
      parse_mode: payload.parse_mode,
      ...(payload.reply_markup !== undefined && { reply_markup: payload.reply_markup }),
    });
  };

  override delete = async (ref: MessageRef): Promise<void> => {
    await this.client.deleteMessage({
      chat_id: ref.conversation.conversationId,
      message_id: Number(ref.id),
    });
  };

  override uploadFile = async (
    _file: FileUpload,
    _conversation: ConversationRef,
  ): Promise<FileRef> => {
    // Telegram "uploads" happen via sendDocument/sendPhoto/sendVoice — there's
    // no standalone upload endpoint. Skills that need a file_id should
    // call send(...) with `kind: 'file'` and read the resulting
    // `SentMessage.id`; the bot is free to reuse the id on subsequent sends.
    throw new Error(
      'telegram: standalone uploadFile is not supported. Use send() with kind: "file".',
    );
  };

  override performAction = async (_action: ChannelAction): Promise<void> => {
    throw new Error('telegram: performAction is not supported in v0.9');
  };

  // ── Helpers ──────────────────────────────────────────────────────────

  private cacheFileId(
    msg: {
      document?: { file_id: string };
      voice?: { file_id: string };
      photo?: { file_id: string }[];
    },
    ref: string,
  ): void {
    const fileId = msg.document?.file_id ?? msg.voice?.file_id ?? msg.photo?.[0]?.file_id;
    if (fileId && !ref.startsWith('http')) this.fileIdCache.set(ref, fileId);
  }
}

function mapTelegramError(err: unknown): unknown {
  if (err instanceof TelegramApiError && err.errorCode === 429) {
    const retryAfterSec = Number(err.parameters?.retry_after ?? 1);
    return new ChannelRateLimitError(retryAfterSec * 1000, err.message);
  }
  return err;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => resolve(), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

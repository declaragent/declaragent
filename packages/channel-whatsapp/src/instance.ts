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
  hmacSha256Hex,
  renderWhatsApp,
  timingSafeEqual,
} from '@declaragent/core';
import { WHATSAPP_CAPABILITIES } from './capabilities.js';
import { WhatsAppApiError, type WhatsAppClient, createWhatsAppClient } from './client.js';
import type {
  WhatsAppChannelConfig,
  WhatsAppOutsideWindowAction,
  WhatsAppTemplateDescriptor,
} from './config.js';
import { ConversationWindowTracker } from './conversation-window.js';
import { type ParsedUpdate, parseWhatsAppWebhook } from './update-parser.js';
import type {
  WhatsAppPhoneNumberInfo,
  WhatsAppTemplate,
  WhatsAppWebhookBody,
} from './whatsapp-api.js';

export class WhatsAppTemplateError extends Error {
  constructor(
    message: string,
    readonly templateName: string,
  ) {
    super(message);
    this.name = 'WhatsAppTemplateError';
  }
}

/**
 * Minimal file cache seam. Production wires in a disk-backed cache; the
 * adapter only needs the `put(mediaId, bytes, meta)` write path — reads
 * happen elsewhere in the pipeline (e.g. the skill that consumed the
 * inbound event).
 */
export interface WhatsAppFileCache {
  put(
    mediaId: string,
    bytes: Uint8Array,
    meta: { mimeType?: string; mediaType: 'image' | 'document' | 'audio' | 'video' },
  ): Promise<void>;
}

export interface WhatsAppChannelInstanceOptions {
  config: WhatsAppChannelConfig;
  deps: ChannelDependencies;
  /** Test seam: supply a stub client. */
  client?: WhatsAppClient;
  /** Injected clock for deterministic window tests. */
  now?: () => number;
  /** Optional test hook fired on every successfully published inbound. */
  onInbound?: (parsed: ParsedUpdate) => void;
  /**
   * Optional local media cache. Production wiring points at the
   * persistent file-ref cache; tests supply a stub that records calls.
   */
  fileCache?: WhatsAppFileCache;
}

const DEFAULT_OUTSIDE_WINDOW_ACTION: WhatsAppOutsideWindowAction = 'template';

/**
 * WhatsApp Cloud API channel instance.
 *
 * Transport is fully webhook-driven (no persistent socket). Responsibilities:
 *   - Verify the GET hub-challenge + POST HMAC signature.
 *   - Parse inbound messages → publish `AgentEvent`s + update window tracker.
 *   - Download media bytes before the 5-minute URL TTL expires.
 *   - Outbound: enforce the 24-hour conversation window + configured policy.
 *   - Validate `template` sends against the local template cache.
 */
export class WhatsAppChannelInstance extends BaseChannelInstance {
  private readonly waConfig: WhatsAppChannelConfig;
  private readonly client: WhatsAppClient;
  private readonly onInbound?: (parsed: ParsedUpdate) => void;
  private readonly fileCache?: WhatsAppFileCache;
  private readonly clock: () => number;

  private readonly windowTracker: ConversationWindowTracker;
  /** Local template cache keyed on name. */
  private readonly templateCache = new Map<string, WhatsAppTemplateDescriptor>();
  /** Out-of-window queue: waId → pending payloads awaiting a window reopen. */
  private readonly outOfWindowQueue = new Map<string, QueuedSend[]>();

  private phoneInfo: WhatsAppPhoneNumberInfo | null = null;

  constructor(opts: WhatsAppChannelInstanceOptions) {
    const base: BaseChannelOptions = {
      type: 'whatsapp',
      config: {
        id: opts.config.id,
        routing: opts.config.routing,
        delivery: opts.config.delivery,
        limits: opts.config.limits,
        ...(opts.config.outbound !== undefined && { outbound: opts.config.outbound }),
        ...(opts.config.idempotency !== undefined && { idempotency: opts.config.idempotency }),
      },
      deps: opts.deps,
      capabilities: WHATSAPP_CAPABILITIES,
    };
    super(base);
    this.waConfig = opts.config;
    if (opts.onInbound !== undefined) this.onInbound = opts.onInbound;
    if (opts.fileCache !== undefined) this.fileCache = opts.fileCache;
    this.clock = opts.now ?? (() => Date.now());
    this.client =
      opts.client ??
      createWhatsAppClient({
        accessToken: opts.config.transport.accessToken,
        phoneNumberId: opts.config.transport.phoneNumberId,
        businessAccountId: opts.config.transport.businessAccountId,
        ...(opts.config.transport.baseUrl !== undefined && {
          baseUrl: opts.config.transport.baseUrl,
        }),
        ...(opts.config.transport.apiVersion !== undefined && {
          apiVersion: opts.config.transport.apiVersion,
        }),
      });

    const windowMs = WHATSAPP_CAPABILITIES.conversationWindowMs ?? 24 * 60 * 60 * 1000;
    const trackerOpts: ConstructorParameters<typeof ConversationWindowTracker>[0] = {
      channelId: opts.config.id,
      windowMs,
      now: this.clock,
    };
    if (opts.deps.conversationStore !== undefined) {
      trackerOpts.store = opts.deps.conversationStore;
    }
    this.windowTracker = new ConversationWindowTracker(trackerOpts);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  protected override async doStart(): Promise<void> {
    // Warm the template cache from config; the registry CLI (slice 10) will
    // later pre-populate this via `sync` against Meta Business Manager.
    for (const tpl of this.waConfig.templates ?? []) {
      this.templateCache.set(tpl.name, tpl);
    }
  }

  protected override async doStop(): Promise<void> {
    this.outOfWindowQueue.clear();
  }

  protected override async doPause(): Promise<void> {
    // Webhook delivery is external; no long-lived transport to pause.
  }

  protected override async doResume(): Promise<void> {
    // Paired no-op with `doPause`.
  }

  protected override async healthDetails(): Promise<Record<string, unknown>> {
    return {
      provider: this.waConfig.transport.provider,
      phoneNumberId: this.waConfig.transport.phoneNumberId,
      templatesCached: this.templateCache.size,
      activeWindows: this.windowTracker.activeCount(this.clock()),
      queuedOutOfWindow: this.totalQueuedMessages(),
      tier: this.phoneInfo?.messaging_limit_tier ?? null,
      quality: this.phoneInfo?.quality_rating ?? null,
    };
  }

  protected override async sendToDLQ(): Promise<void> {
    // Channel-native inbound bypasses BaseSourceInstance's retry/DLQ path;
    // failures surface via publishInbound. This stub satisfies the abstract
    // contract without routing anywhere.
  }

  // ── Webhook ──────────────────────────────────────────────────────────

  override handleWebhook = async (req: WebhookRequest): Promise<WebhookResponse> => {
    // ── GET verification handshake ──
    if (req.method.toUpperCase() === 'GET') {
      const mode = req.headers['hub.mode'] ?? req.headers['x-hub-mode'];
      const token = req.headers['hub.verify_token'] ?? req.headers['x-hub-verify-token'];
      const challenge = req.headers['hub.challenge'] ?? req.headers['x-hub-challenge'] ?? '';
      if (mode !== 'subscribe') {
        return { status: 400, body: 'invalid hub mode' };
      }
      const expected = this.waConfig.transport.webhookVerifyToken;
      if (typeof token !== 'string' || !timingSafeEqual(token, expected)) {
        return { status: 403, body: 'bad verify token' };
      }
      return { status: 200, body: challenge };
    }

    if (req.method.toUpperCase() !== 'POST') {
      return { status: 405, body: 'method not allowed' };
    }

    // ── POST signature verification ──
    const signatureHeader =
      req.headers['x-hub-signature-256'] ?? req.headers['X-Hub-Signature-256'];
    if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
      return { status: 401, body: 'missing signature' };
    }
    const presentedHex = signatureHeader.slice('sha256='.length).toLowerCase();
    const rawText = new TextDecoder().decode(req.body);
    const expectedHex = (
      await hmacSha256Hex(this.waConfig.transport.webhookAppSecret, rawText)
    ).toLowerCase();
    if (!timingSafeEqual(presentedHex, expectedHex)) {
      return { status: 401, body: 'bad signature' };
    }

    // ── Parse + publish each message ──
    let body: WhatsAppWebhookBody;
    try {
      body = JSON.parse(rawText) as WhatsAppWebhookBody;
    } catch {
      return { status: 400, body: 'invalid JSON' };
    }
    const parsedList = parseWhatsAppWebhook(body, { channelId: this.id });
    for (const parsed of parsedList) {
      try {
        await this.windowTracker.recordInbound(
          parsed.conversation.conversationId,
          parsed.recordedAtMs,
        );
        await this.publishInbound(parsed.event);
        this.onInbound?.(parsed);
        if (parsed.media) {
          // Fire-and-forget: media URLs expire in ~5 min so start the fetch
          // immediately. We log failures but don't fail the webhook.
          void this.fetchAndCacheMedia(parsed);
        }
      } catch (err) {
        this.channelDeps.logger.warn('whatsapp.publish.failed', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { status: 200, body: '' };
  };

  private async fetchAndCacheMedia(parsed: ParsedUpdate): Promise<void> {
    if (!parsed.media) return;
    try {
      const descriptor = await this.client.getMedia(parsed.media.mediaId);
      const bytes = await this.client.downloadMedia(descriptor.url);
      if (this.fileCache) {
        await this.fileCache.put(parsed.media.mediaId, bytes, {
          mediaType: parsed.media.mediaType,
          ...(descriptor.mime_type !== undefined && { mimeType: descriptor.mime_type }),
        });
      }
    } catch (err) {
      this.channelDeps.logger.warn('whatsapp.media.download.failed', {
        id: this.id,
        mediaId: parsed.media.mediaId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────────

  protected override async doSend(params: SendMessageParams): Promise<SentMessage> {
    const payload = renderWhatsApp(params.content, { capabilities: this.capabilities });
    const waId = params.conversation.conversationId;
    const replyTo = params.replyTo?.id;
    const enforceWindow = this.waConfig.policy?.enforceConversationWindow ?? true;

    // Template sends bypass window checks (Meta allows them regardless).
    if (payload.kind !== 'template' && enforceWindow) {
      const inWindow = await this.windowTracker.isInWindow(waId, this.clock());
      if (!inWindow) {
        return this.handleOutOfWindow(params, payload, waId);
      }
    }

    if (payload.kind === 'template') {
      this.assertTemplateCached(payload.name);
    }

    try {
      switch (payload.kind) {
        case 'text': {
          const resp = await this.client.sendText({
            to: waId,
            body: payload.body,
            ...(replyTo !== undefined && { replyTo }),
          });
          return builtSentMessage(resp, params.conversation, this.clock());
        }
        case 'interactive': {
          const resp = await this.client.sendInteractive({
            to: waId,
            interactive: payload.interactive,
            ...(replyTo !== undefined && { replyTo }),
          });
          return builtSentMessage(resp, params.conversation, this.clock());
        }
        case 'template': {
          const components = buildTemplateComponents(
            this.templateCache.get(payload.name),
            payload.params,
          );
          const resp = await this.client.sendTemplate({
            to: waId,
            name: payload.name,
            language: payload.language,
            ...(components.length > 0 && { components }),
          });
          return builtSentMessage(resp, params.conversation, this.clock());
        }
        case 'media': {
          const mediaParams: Parameters<WhatsAppClient['sendMedia']>[0] = {
            to: waId,
            mediaType: payload.media_type,
          };
          if (payload.source.url !== undefined) mediaParams.url = payload.source.url;
          if (payload.source.path !== undefined && payload.source.url === undefined) {
            // The renderer's `source.path` surfaces unhosted files. The Cloud
            // API needs an upload-first media id; surface a clear error so
            // skill authors know to upload or supply a URL.
            throw new Error(
              'whatsapp: local-path media requires a media id (upload first); pass FileRef.url',
            );
          }
          if (payload.caption !== undefined) mediaParams.caption = payload.caption;
          if (replyTo !== undefined) mediaParams.replyTo = replyTo;
          const resp = await this.client.sendMedia(mediaParams);
          return builtSentMessage(resp, params.conversation, this.clock());
        }
        default: {
          const exhaustive: never = payload;
          void exhaustive;
          throw new Error('whatsapp: unhandled payload kind');
        }
      }
    } catch (err) {
      throw mapWhatsAppError(err);
    }
  }

  private async handleOutOfWindow(
    params: SendMessageParams,
    payload: ReturnType<typeof renderWhatsApp>,
    waId: string,
  ): Promise<SentMessage> {
    const action = this.waConfig.policy?.outsideWindowAction ?? DEFAULT_OUTSIDE_WINDOW_ACTION;
    switch (action) {
      case 'drop': {
        this.channelDeps.logger.warn('whatsapp.outside_window.dropped', {
          id: this.id,
          to: waId,
          payloadKind: payload.kind,
        });
        return {
          id: 'dropped',
          conversation: params.conversation,
          sentAt: this.clock(),
        };
      }
      case 'queue': {
        const queued = this.outOfWindowQueue.get(waId) ?? [];
        queued.push({
          params,
          queuedAt: this.clock(),
        });
        this.outOfWindowQueue.set(waId, queued);
        this.channelDeps.logger.info('whatsapp.outside_window.queued', {
          id: this.id,
          to: waId,
          queueLength: queued.length,
          hint: 'flush-on-next-inbound is a later slice; see Phase-5 plan §7.5.',
        });
        return {
          id: 'queued',
          conversation: params.conversation,
          sentAt: this.clock(),
        };
      }
      case 'template': {
        const templateName = this.waConfig.policy?.defaultTemplate;
        if (!templateName) {
          throw new Error(
            `whatsapp[${this.id}]: outsideWindowAction is "template" but defaultTemplate is unset`,
          );
        }
        this.assertTemplateCached(templateName);
        const descriptor = this.templateCache.get(templateName);
        const summary = summariseForTemplate(params.content);
        const paramName = descriptor?.parameterNames[0] ?? 'body';
        const components = buildTemplateComponents(descriptor, {
          [paramName]: summary,
        });
        try {
          const resp = await this.client.sendTemplate({
            to: waId,
            name: templateName,
            language: descriptor?.language ?? 'en_US',
            ...(components.length > 0 && { components }),
          });
          return builtSentMessage(resp, params.conversation, this.clock());
        } catch (err) {
          throw mapWhatsAppError(err);
        }
      }
      default: {
        const exhaustive: never = action;
        void exhaustive;
        throw new Error('whatsapp: unsupported outsideWindowAction');
      }
    }
  }

  private assertTemplateCached(name: string): void {
    if (!this.templateCache.has(name)) {
      throw new WhatsAppTemplateError(
        `whatsapp: template "${name}" is not in the local cache; run \`declaragent channel whatsapp templates sync\` (slice 10) or add it to config.templates`,
        name,
      );
    }
  }

  private totalQueuedMessages(): number {
    let count = 0;
    for (const list of this.outOfWindowQueue.values()) count += list.length;
    return count;
  }

  // ── Unsupported surface (declared false in capabilities) ─────────────

  override react = async (ref: MessageRef, emoji: string): Promise<void> => {
    try {
      await this.client.sendReaction({
        to: ref.conversation.conversationId,
        messageId: ref.id,
        emoji,
      });
    } catch (err) {
      throw mapWhatsAppError(err);
    }
  };

  override edit = async (_ref: MessageRef, _content: ChannelMessageContent): Promise<void> => {
    throw new Error('whatsapp: edit is not supported on the Cloud API');
  };

  override delete = async (_ref: MessageRef): Promise<void> => {
    throw new Error('whatsapp: delete is not supported on the Cloud API');
  };

  override uploadFile = async (
    _file: FileUpload,
    _conversation: ConversationRef,
  ): Promise<FileRef> => {
    throw new Error(
      'whatsapp: standalone uploadFile is not supported yet; send(kind: "file") with a hosted URL',
    );
  };

  override setTyping = async (
    _conversation: ConversationRef,
    _durationMs?: number,
  ): Promise<void> => {
    throw new Error('whatsapp: typing indicators are not supported on the Cloud API');
  };

  override performAction = async (_action: ChannelAction): Promise<void> => {
    throw new Error('whatsapp: performAction is not supported in v0.9');
  };

  // ── Test helpers ──────────────────────────────────────────────────────

  /** Exposed for tests + diagnostics. */
  get window(): ConversationWindowTracker {
    return this.windowTracker;
  }

  /** Returns the in-memory approved-template names. */
  templateNames(): readonly string[] {
    return [...this.templateCache.keys()];
  }

  /** Pull an out-of-window queue snapshot (for `/status` + tests). */
  queueLength(waId: string): number {
    return this.outOfWindowQueue.get(waId)?.length ?? 0;
  }
}

interface QueuedSend {
  params: SendMessageParams;
  queuedAt: number;
}

function builtSentMessage(
  resp: { messages: { id: string }[] },
  conversation: ConversationRef,
  now: number,
): SentMessage {
  return {
    id: resp.messages[0]?.id ?? 'unknown',
    conversation,
    sentAt: now,
  };
}

function buildTemplateComponents(
  descriptor: WhatsAppTemplateDescriptor | undefined,
  params: Readonly<Record<string, string>>,
): { type: 'body'; parameters: { type: 'text'; text: string }[] }[] {
  if (!descriptor) {
    // No descriptor → no param ordering → emit raw params in caller-declared
    // order (spec-defined ordering is the caller's responsibility).
    const values = Object.values(params);
    if (values.length === 0) return [];
    return [
      {
        type: 'body',
        parameters: values.map((v) => ({ type: 'text' as const, text: v })),
      },
    ];
  }
  const ordered: { type: 'text'; text: string }[] = [];
  for (const name of descriptor.parameterNames) {
    ordered.push({ type: 'text', text: params[name] ?? '' });
  }
  if (ordered.length === 0) return [];
  return [{ type: 'body', parameters: ordered }];
}

function summariseForTemplate(content: ChannelMessageContent, max = 160): string {
  let raw = '';
  switch (content.kind) {
    case 'text':
      raw = content.text;
      break;
    case 'rich': {
      const pieces: string[] = [];
      for (const block of content.blocks) {
        switch (block.kind) {
          case 'heading':
          case 'paragraph':
          case 'code':
          case 'context':
            pieces.push(block.text);
            break;
          case 'bulleted-list':
            pieces.push(block.items.join(', '));
            break;
          case 'button-row':
            pieces.push(block.buttons.map((b) => b.label).join(' · '));
            break;
          case 'image':
            pieces.push(block.alt ?? 'image');
            break;
          case 'divider':
            break;
        }
      }
      raw = pieces.join(' — ');
      break;
    }
    case 'template':
      raw = content.name;
      break;
    case 'file':
      raw = content.caption ?? content.file.name ?? 'file';
      break;
    case 'voice':
      raw = 'voice message';
      break;
  }
  return raw.length <= max ? raw : `${raw.slice(0, max - 1)}…`;
}

function mapWhatsAppError(err: unknown): unknown {
  if (err instanceof WhatsAppApiError && err.status === 429) {
    const retryAfter = err.retryAfterMs ?? 1000;
    return new ChannelRateLimitError(retryAfter, err.message);
  }
  // Meta returns `code: 80007` for rate limits too; defer to status + code.
  if (err instanceof WhatsAppApiError && (err.errorCode === 80007 || err.errorCode === 130429)) {
    const retryAfter = err.retryAfterMs ?? 1000;
    return new ChannelRateLimitError(retryAfter, err.message);
  }
  return err;
}

// Re-export type symbols used externally.
export type { WhatsAppTemplate };

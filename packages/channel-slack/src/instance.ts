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
  renderSlack,
  timingSafeEqual,
} from '@declaragent/core';
import { SLACK_CAPABILITIES } from './capabilities.js';
import {
  SlackApiError,
  type SlackClient,
  type SocketModeTransport,
  createSlackClient,
  createSocketModeTransport,
} from './client.js';
import type { SlackChannelConfig, ThreadOnMentionPolicy } from './config.js';
import type {
  SlackAuthTestResponse,
  SlackBlockActionsPayload,
  SlackEventWrapper,
  SlackSlashCommandPayload,
  SlackSocketFrame,
} from './slack-api.js';
import { type ParsedUpdate, parseSlackEvent } from './update-parser.js';

/** Required scopes for a full-feature bot install. Warn if any are missing. */
const REQUIRED_SCOPES: readonly string[] = [
  'chat:write',
  'channels:history',
  'im:history',
  'app_mentions:read',
  'reactions:write',
];

/**
 * Reject timestamps older than 5 minutes to defeat replay attacks. Slack
 * docs recommend 5 min as the HMAC verification window.
 */
const SLACK_TIMESTAMP_WINDOW_SEC = 60 * 5;

export interface SlackChannelInstanceOptions {
  config: SlackChannelConfig;
  deps: ChannelDependencies;
  /** Test seam: swap in a stub client. */
  client?: SlackClient;
  /** Test seam: swap in a stub Socket Mode transport. */
  socketTransport?: SocketModeTransport;
  /** Logger hook fired whenever a parsed inbound is published. */
  onInbound?: (parsed: ParsedUpdate) => void;
  /** Override the current-time source (HMAC window check). */
  now?: () => number;
}

/**
 * Slack channel instance. Subclass of `BaseChannelInstance`. Ships two
 * transports:
 *
 * - Events API (`events` mode) — no persistent connection; inbound events
 *   hit `handleWebhook`. Adapter verifies `X-Slack-Signature` via HMAC +
 *   timestamp window, then dispatches through `parseSlackEvent`.
 * - Socket Mode (`socket` mode) — opens a WSS via `apps.connections.open`
 *   and auto-acks every envelope. Hand-rolled transport; stubbed in tests.
 *
 * Outbound goes through `renderSlack` + `chat.postMessage`; `text` is
 * always included alongside `blocks` (Slack requires both for mobile
 * notifications + search).
 *
 * TODOs:
 * - Socket Mode reconnect-with-backoff (slice 7.x).
 * - File upload fallback path when `files.getUploadURLExternal` 403s on
 *   missing `files:write` scope — currently surfaces the error.
 * - Scope preflight only logs a warning; future work could surface the
 *   actionable install URL (`https://<workspace>.slack.com/admin/apps`).
 */
export class SlackChannelInstance extends BaseChannelInstance {
  private readonly slackConfig: SlackChannelConfig;
  private readonly client: SlackClient;
  private readonly onInbound?: (parsed: ParsedUpdate) => void;
  private readonly clock: () => number;

  private socketTransport: SocketModeTransport | null = null;
  private authInfo: SlackAuthTestResponse | null = null;
  /**
   * `thread_ts` hint keyed by last-inbound parent `ts` → applied on the
   * next `doSend` for the same conversation. Keeps `threadOnMention`
   * policy local to the instance.
   */
  private readonly threadHints = new Map<string, string>();

  constructor(opts: SlackChannelInstanceOptions) {
    const base: BaseChannelOptions = {
      type: 'slack',
      config: {
        id: opts.config.id,
        routing: opts.config.routing,
        delivery: opts.config.delivery,
        limits: opts.config.limits,
        ...(opts.config.outbound !== undefined && { outbound: opts.config.outbound }),
        ...(opts.config.idempotency !== undefined && { idempotency: opts.config.idempotency }),
      },
      deps: opts.deps,
      capabilities: SLACK_CAPABILITIES,
    };
    super(base);
    this.slackConfig = opts.config;
    this.clock = opts.now ?? (() => Date.now());
    if (opts.onInbound !== undefined) this.onInbound = opts.onInbound;

    this.client =
      opts.client ??
      createSlackClient({
        botToken: opts.config.transport.botToken,
        ...(opts.config.transport.appToken !== undefined && {
          appToken: opts.config.transport.appToken,
        }),
        ...(opts.config.transport.baseUrl !== undefined && {
          baseUrl: opts.config.transport.baseUrl,
        }),
      });

    if (opts.socketTransport) {
      this.socketTransport = opts.socketTransport;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  protected async doStart(): Promise<void> {
    // Scope preflight: call auth.test and compare granted vs required.
    try {
      this.authInfo = await this.client.authTest();
      const granted = this.authInfo.response_metadata?.scopes ?? [];
      const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
      if (granted.length > 0 && missing.length > 0) {
        this.channelDeps.logger.warn('slack.scopes.missing', {
          id: this.id,
          team: this.authInfo.team,
          missing,
          hint: 'Reinstall the app in the Slack workspace admin panel to grant the missing scopes.',
        });
      }
    } catch (err) {
      this.channelDeps.logger.warn('slack.auth_test.failed', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    if (this.slackConfig.transport.mode === 'socket') {
      await this.startSocketMode();
    } else {
      this.channelDeps.logger.info('slack.events_api.ready', {
        id: this.id,
        hint: 'HTTP inbound dispatched via handleWebhook()',
      });
    }
  }

  protected async doStop(): Promise<void> {
    if (this.socketTransport) {
      try {
        await this.socketTransport.close();
      } catch (err) {
        this.channelDeps.logger.warn('slack.socket.close.failed', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.socketTransport = null;
    }
    this.threadHints.clear();
  }

  protected async doPause(): Promise<void> {
    if (this.socketTransport) {
      await this.socketTransport.close();
      this.socketTransport = null;
    }
  }

  protected async doResume(): Promise<void> {
    if (this.slackConfig.transport.mode === 'socket' && !this.socketTransport) {
      await this.startSocketMode();
    }
  }

  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {
      mode: this.slackConfig.transport.mode,
      team: this.authInfo?.team ?? null,
      botUser: this.authInfo?.user ?? null,
      // WS11 — truthful: a transport object exists ≠ the socket is up. Report
      // the live connection state so a recycled/reconnecting socket reads as
      // not-active instead of falsely healthy.
      socketActive: this.socketTransport?.connected() ?? false,
      threadHints: this.threadHints.size,
    };
  }

  protected async sendToDLQ(): Promise<void> {
    // Same rationale as telegram: inbound uses publishInbound, which is
    // not on BaseSourceInstance's retry/DLQ path.
  }

  // ── Socket Mode ───────────────────────────────────────────────────────

  private async startSocketMode(): Promise<void> {
    const existing = this.socketTransport;
    const transport =
      existing ??
      createSocketModeTransport({
        getUrl: async () => {
          const res = await this.client.appsConnectionsOpen();
          if (!res.ok || !res.url) {
            throw new Error(`apps.connections.open failed: ${res.error ?? 'unknown'}`);
          }
          return res.url;
        },
        logger: {
          debug: (event, data) => this.channelDeps.logger.debug(event, { id: this.id, ...data }),
          warn: (event, data) => this.channelDeps.logger.warn(event, { id: this.id, ...data }),
        },
      });
    this.socketTransport = transport;
    transport.onEvent((frame) => this.handleSocketFrame(frame));
    try {
      await transport.connect();
    } catch (err) {
      this.channelDeps.logger.warn('slack.socket.connect.failed', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
      this.socketTransport = null;
    }
  }

  private async handleSocketFrame(frame: SlackSocketFrame): Promise<void> {
    if (frame.type === 'hello' || frame.type === 'disconnect') return;
    const payload = frame.payload;
    if (!payload) return;
    await this.dispatchParsedPayload(
      payload as
        | SlackEventWrapper
        | SlackBlockActionsPayload
        | SlackSlashCommandPayload
        | Record<string, unknown>,
    );
  }

  // ── Webhook (Events API) ──────────────────────────────────────────────

  override async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
    const mode = this.slackConfig.transport.mode;
    if (mode !== 'events') return { status: 405, body: 'webhook mode not enabled' };

    const rawBody = new TextDecoder().decode(req.body);

    // Early peek for `url_verification` — Slack's handshake on registering
    // a new Events URL. Echoes the challenge back verbatim.
    let maybeVerify: { type?: unknown; challenge?: unknown } | null = null;
    try {
      maybeVerify = JSON.parse(rawBody) as { type?: unknown; challenge?: unknown };
    } catch {
      return { status: 400, body: 'invalid JSON' };
    }
    if (
      maybeVerify &&
      maybeVerify.type === 'url_verification' &&
      typeof maybeVerify.challenge === 'string'
    ) {
      return { status: 200, body: maybeVerify.challenge };
    }

    // HMAC verification for every other payload.
    const signingSecret = this.slackConfig.transport.signingSecret;
    if (!signingSecret) {
      return { status: 500, body: 'signingSecret missing' };
    }
    const ts = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    if (typeof ts !== 'string' || typeof sig !== 'string') {
      return { status: 401, body: 'missing signature headers' };
    }
    const nowSec = Math.floor(this.clock() / 1000);
    const tsNum = Number.parseInt(ts, 10);
    if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > SLACK_TIMESTAMP_WINDOW_SEC) {
      return { status: 401, body: 'stale timestamp' };
    }
    const expectedHex = await hmacSha256Hex(signingSecret, `v0:${ts}:${rawBody}`);
    const expected = `v0=${expectedHex}`;
    if (!timingSafeEqual(sig, expected)) {
      return { status: 401, body: 'invalid signature' };
    }

    await this.dispatchParsedPayload(
      maybeVerify as
        | SlackEventWrapper
        | SlackBlockActionsPayload
        | SlackSlashCommandPayload
        | Record<string, unknown>,
    );
    return { status: 200, body: '' };
  }

  private async dispatchParsedPayload(
    payload:
      | SlackEventWrapper
      | SlackBlockActionsPayload
      | SlackSlashCommandPayload
      | Record<string, unknown>,
  ): Promise<void> {
    const parsed = parseSlackEvent(payload, { channelId: this.id });
    if (!parsed) return;

    // Remember thread hints so a subsequent `doSend` can reply in-thread.
    if (parsed.threadHint) {
      const key = threadHintKey(parsed.conversation);
      const hint = resolveThreadReplyTarget(
        parsed.threadHint,
        this.slackConfig.threadOnMention ?? 'auto',
      );
      if (hint !== undefined) {
        this.threadHints.set(key, hint);
      } else {
        this.threadHints.delete(key);
      }
    }

    try {
      await this.publishInbound(parsed.event);
      this.onInbound?.(parsed);
    } catch (err) {
      this.channelDeps.logger.warn('slack.publish.failed', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────────

  protected override async doSend(params: SendMessageParams): Promise<SentMessage> {
    const payload = renderSlack(params.content, { capabilities: this.capabilities });
    const channel = params.conversation.conversationId;
    const threadTs =
      params.conversation.threadId ??
      (params.replyTo ? params.replyTo.id : undefined) ??
      this.threadHints.get(threadHintKey(params.conversation));

    try {
      switch (payload.kind) {
        case 'text': {
          const args: Parameters<SlackClient['chatPostMessage']>[0] = {
            channel,
            text: payload.text,
          };
          if (threadTs !== undefined) args.thread_ts = threadTs;
          const res = await this.client.chatPostMessage(args);
          return buildSent(params.conversation, res);
        }
        case 'rich': {
          const args: Parameters<SlackClient['chatPostMessage']>[0] = {
            channel,
            // Slack's fallback-text + search requirement.
            text: payload.text,
            blocks: payload.blocks,
          };
          if (threadTs !== undefined) args.thread_ts = threadTs;
          const res = await this.client.chatPostMessage(args);
          return buildSent(params.conversation, res);
        }
        case 'file': {
          const filePart = payload.files[0];
          if (!filePart) throw new Error('slack: file payload missing files[0]');
          // Prefer v2 upload path; if we only have a URL, post the URL
          // in the message text (Slack auto-unfurls).
          if (filePart.url && !filePart.path) {
            const args: Parameters<SlackClient['chatPostMessage']>[0] = {
              channel,
              text: `${payload.text}\n${filePart.url}`,
              unfurl_links: true,
            };
            if (threadTs !== undefined) args.thread_ts = threadTs;
            const res = await this.client.chatPostMessage(args);
            return buildSent(params.conversation, res);
          }
          // With a local path we'd read bytes — kept out of scope here;
          // upload flow requires caller to supply bytes via uploadFile().
          const args: Parameters<SlackClient['chatPostMessage']>[0] = {
            channel,
            text: payload.text,
          };
          if (threadTs !== undefined) args.thread_ts = threadTs;
          const res = await this.client.chatPostMessage(args);
          return buildSent(params.conversation, res);
        }
        case 'voice': {
          // Slack doesn't have a dedicated voice API — fall back to
          // chat.postMessage with the audio file's public URL if
          // available. The capabilities negotiation already flagged
          // voice as unsupported, so this is the degradation path.
          const args: Parameters<SlackClient['chatPostMessage']>[0] = {
            channel,
            text: payload.text,
          };
          if (threadTs !== undefined) args.thread_ts = threadTs;
          const res = await this.client.chatPostMessage(args);
          return buildSent(params.conversation, res);
        }
        case 'template': {
          const body = `[template: ${payload.name}]${Object.entries(payload.params)
            .map(([k, v]) => `\n  ${k}: ${v}`)
            .join('')}`;
          const args: Parameters<SlackClient['chatPostMessage']>[0] = {
            channel,
            text: body,
          };
          if (threadTs !== undefined) args.thread_ts = threadTs;
          const res = await this.client.chatPostMessage(args);
          return buildSent(params.conversation, res);
        }
        default: {
          const exhaustive: never = payload;
          void exhaustive;
          throw new Error('slack: unhandled payload kind');
        }
      }
    } catch (err) {
      throw mapSlackError(err);
    }
  }

  /**
   * Slack has no bot typing indicator. Capability surface reports it as
   * off; this method is a no-op preserved so callers reading the optional
   * `setTyping` field don't have to special-case Slack.
   */
  override setTyping = async (
    _conversation: ConversationRef,
    _durationMs?: number,
  ): Promise<void> => {
    // Intentionally empty; see doc-comment.
  };

  override react = async (ref: MessageRef, emoji: string): Promise<void> => {
    try {
      await this.client.reactionsAdd({
        channel: ref.conversation.conversationId,
        timestamp: ref.id,
        name: emoji.replace(/^:|:$/g, ''),
      });
    } catch (err) {
      throw mapSlackError(err);
    }
  };

  override edit = async (ref: MessageRef, content: ChannelMessageContent): Promise<void> => {
    const payload = renderSlack(content, { capabilities: this.capabilities });
    try {
      if (payload.kind === 'rich') {
        await this.client.chatUpdate({
          channel: ref.conversation.conversationId,
          ts: ref.id,
          text: payload.text,
          blocks: payload.blocks,
        });
        return;
      }
      if (payload.kind === 'text') {
        await this.client.chatUpdate({
          channel: ref.conversation.conversationId,
          ts: ref.id,
          text: payload.text,
        });
        return;
      }
      throw new Error(
        `slack edit only supports text + rich content (got ${payload.kind}); delete + re-send for other kinds`,
      );
    } catch (err) {
      throw mapSlackError(err);
    }
  };

  override delete = async (ref: MessageRef): Promise<void> => {
    try {
      await this.client.chatDelete({
        channel: ref.conversation.conversationId,
        ts: ref.id,
      });
    } catch (err) {
      throw mapSlackError(err);
    }
  };

  override uploadFile = async (
    file: FileUpload,
    conversation: ConversationRef,
  ): Promise<FileRef> => {
    if (!file.bytes && !file.path) {
      throw new Error('slack uploadFile requires bytes or path');
    }
    if (!file.bytes) {
      throw new Error('slack uploadFile: local-path reads not supported yet — pass bytes');
    }
    try {
      const params: Parameters<SlackClient['filesUploadV2']>[0] = {
        channel: conversation.conversationId,
        filename: file.name,
        bytes: file.bytes,
      };
      if (conversation.threadId !== undefined) params.thread_ts = conversation.threadId;
      const res = await this.client.filesUploadV2(params);
      const uploaded = res.files?.[0];
      if (!uploaded) {
        throw new Error(`slack filesUploadV2 failed: ${res.error ?? 'unknown'}`);
      }
      const ref: FileRef = {
        id: uploaded.id,
        ...(uploaded.name !== undefined && { name: uploaded.name }),
        ...(uploaded.mimetype !== undefined && { mimeType: uploaded.mimetype }),
        ...(uploaded.size !== undefined && { sizeBytes: uploaded.size }),
        ...(uploaded.permalink !== undefined && { url: uploaded.permalink }),
      };
      return ref;
    } catch (err) {
      throw mapSlackError(err);
    }
  };

  override performAction = async (_action: ChannelAction): Promise<void> => {
    throw new Error('slack: performAction is not supported in v0.9');
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildSent(
  conversation: ConversationRef,
  res: {
    ok: boolean;
    channel?: string;
    ts?: string;
    message?: { ts: string; thread_ts?: string };
  },
): SentMessage {
  const ts = res.message?.ts ?? res.ts;
  if (!ts) throw new Error('slack chat.postMessage: response missing ts');
  return {
    id: ts,
    conversation,
    sentAt: Math.round(Number.parseFloat(ts) * 1000),
  };
}

function threadHintKey(conv: ConversationRef): string {
  return `${conv.channelId}:${conv.conversationId}`;
}

/**
 * Decide whether the next outbound send should set `thread_ts`. Encodes
 * the `threadOnMention` policy — see `config.ts` for the semantics.
 */
function resolveThreadReplyTarget(
  hint: NonNullable<ParsedUpdate['threadHint']>,
  policy: ThreadOnMentionPolicy,
): string | undefined {
  // Non-mention threaded messages always go back into their thread.
  if (!hint.isMention) {
    return hint.threadTs;
  }
  switch (policy) {
    case 'always':
      return hint.threadTs ?? hint.parentTs;
    case 'never':
      return undefined;
    case 'auto':
      return hint.threadTs;
  }
}

function mapSlackError(err: unknown): unknown {
  if (err instanceof SlackApiError) {
    const http = err.httpStatus;
    const rateLimited =
      http === 429 || err.slackError === 'ratelimited' || err.slackError === 'rate_limited';
    if (rateLimited) {
      const retryAfterSec = err.retryAfterSec ?? 1;
      return new ChannelRateLimitError(Math.max(0, retryAfterSec) * 1000, err.message);
    }
  }
  return err;
}

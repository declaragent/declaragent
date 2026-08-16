/**
 * Fetch-backed Slack Web API client + a Socket Mode WebSocket transport.
 * Lightweight abstraction so tests can swap in an in-memory stub without
 * touching the network.
 *
 * All Web API calls POST to `https://slack.com/api/<method>`. Most accept
 * JSON (`Authorization: Bearer <token>`); a few legacy endpoints require
 * `application/x-www-form-urlencoded` but everything we consume here
 * accepts `application/json; charset=utf-8`.
 *
 * Responses follow the `{ ok: boolean, error?: string, ... }` envelope;
 * this module unwraps + surfaces errors as `SlackApiError`.
 *
 * File uploads use the v2 flow — `files.getUploadURLExternal` → upload to
 * the returned URL via PUT → `files.completeUploadExternal`. The legacy
 * `files.upload` endpoint is deprecated as of March 2025; v2 is the only
 * forward-compatible path.
 */

import type { SlackBlock } from '@declaragent/core';
import type {
  SlackAppsConnectionsOpenResponse,
  SlackAuthTestResponse,
  SlackConversationsRepliesResponse,
  SlackFilesUploadV2Response,
  SlackPostMessageResponse,
  SlackSocketFrame,
} from './slack-api.js';

// ── Request shapes ────────────────────────────────────────────────────────

export interface ChatPostMessageParams {
  channel: string;
  /** Plain-text fallback; always include alongside `blocks`. */
  text: string;
  blocks?: SlackBlock[];
  thread_ts?: string;
  reply_broadcast?: boolean;
  mrkdwn?: boolean;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ChatUpdateParams {
  channel: string;
  ts: string;
  text: string;
  blocks?: SlackBlock[];
}

export interface ChatDeleteParams {
  channel: string;
  ts: string;
}

export interface ReactionsAddParams {
  channel: string;
  timestamp: string;
  /** Emoji name without colons (e.g. `thumbsup`, not `:thumbsup:`). */
  name: string;
}

export interface ConversationsRepliesParams {
  channel: string;
  ts: string;
  cursor?: string;
  limit?: number;
  inclusive?: boolean;
}

export interface FilesUploadV2Params {
  /** Channel id to share the file into. If omitted, file is uploaded but not shared. */
  channel?: string;
  /** Optional thread_ts to share the file into a thread. */
  thread_ts?: string;
  filename: string;
  /** File bytes. Either bytes or `fromUrl` must be provided. */
  bytes?: Uint8Array;
  /**
   * Remote URL Slack will fetch on behalf of the bot. We pass this
   * straight through as an `initial_comment` hint — the adapter mirrors
   * the URL in chat.postMessage if filesUploadV2 returns an error (e.g.
   * the bot lacks `files:write`).
   */
  fromUrl?: string;
  initial_comment?: string;
  title?: string;
}

// ── Client surface ────────────────────────────────────────────────────────

export interface SlackClient {
  authTest(): Promise<SlackAuthTestResponse>;
  chatPostMessage(params: ChatPostMessageParams): Promise<SlackPostMessageResponse>;
  chatUpdate(params: ChatUpdateParams): Promise<SlackPostMessageResponse>;
  chatDelete(params: ChatDeleteParams): Promise<{ ok: boolean; channel?: string; ts?: string }>;
  reactionsAdd(params: ReactionsAddParams): Promise<{ ok: boolean }>;
  conversationsReplies(
    params: ConversationsRepliesParams,
  ): Promise<SlackConversationsRepliesResponse>;
  filesUploadV2(params: FilesUploadV2Params): Promise<SlackFilesUploadV2Response>;
  /**
   * Socket Mode only: exchange the app-level token for a WSS URL. The
   * URL is single-use and expires in ~30s if not connected.
   */
  appsConnectionsOpen(): Promise<SlackAppsConnectionsOpenResponse>;
}

// ── Errors ────────────────────────────────────────────────────────────────

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly slackError: string | undefined,
    /** Slack 429 responses carry this header (seconds). */
    readonly retryAfterSec: number | undefined,
    readonly httpStatus: number | undefined,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

// ── Socket Mode transport ────────────────────────────────────────────────

/** Callback invoked for each decoded Socket Mode frame. */
export type SlackSocketHandler = (frame: SlackSocketFrame) => void | Promise<void>;

/**
 * Minimal Socket Mode transport contract. The default implementation
 * opens a WebSocket with the URL returned by `apps.connections.open`,
 * auto-acks every envelope, and invokes the handler for each inbound
 * `events_api` / `interactive` / `slash_commands` frame.
 *
 * Tests supply their own transport so no real network is touched.
 */
export interface SocketModeTransport {
  /** Open the WSS connection. Rejects on the FIRST connect failure. */
  connect(): Promise<void>;
  /** Register the inbound-frame handler. Called for every decoded frame. */
  onEvent(handler: SlackSocketHandler): void;
  /** Close the WSS connection and stop reconnect attempts. */
  close(): Promise<void>;
  /**
   * True while the WSS is currently open. Reflects reconnect state honestly —
   * after Slack recycles the connection this reads `false` until the socket
   * re-establishes, so channel health doesn't lie. (WS11)
   */
  connected(): boolean;
}

export interface CreateSocketModeTransportOptions {
  /** Factory producing a WSS URL (calls `apps.connections.open`). */
  getUrl(): Promise<string>;
  /** Injected WebSocket constructor (defaults to global `WebSocket`). */
  webSocketImpl?: typeof WebSocket;
  /** Logger hook for connection lifecycle + decode errors. */
  logger?: {
    debug?: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
  /** Backoff (ms) before reconnect attempt N (0-indexed). Default exp 1s→30s. */
  backoffMs?: (attempt: number) => number;
  /** Fired on each reconnect attempt (e.g. to bump a `*_reconnects_total` counter). */
  onReconnect?: (attempt: number) => void;
  /** Timer seams (tests). */
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Hand-rolled Socket Mode transport. Handles the hello frame + auto-ack +
 * payload decode, and — since WS11 — reconnects with exponential backoff when
 * Slack recycles the WSS (every ~hour) or the network blips. `connected()`
 * reflects the live socket state so channel health is truthful.
 */
export function createSocketModeTransport(
  opts: CreateSocketModeTransportOptions,
): SocketModeTransport {
  const maybeWS = opts.webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!maybeWS) {
    throw new Error(
      'Socket Mode requires a WebSocket implementation (global.WebSocket is missing)',
    );
  }
  // Definitely-assigned const so nested closures (reopen) keep the narrowing.
  const WSImpl: typeof WebSocket = maybeWS;
  const backoff = opts.backoffMs ?? ((attempt) => Math.min(1000 * 2 ** attempt, 30_000));
  const setT = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let ws: WebSocket | null = null;
  let handler: SlackSocketHandler | null = null;
  let closed = false;
  let isConnected = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Attach the message + ack + close→reconnect listeners to a socket. Defined
  // per-socket so the ack `send` targets the CURRENT socket after a reconnect.
  function wire(socket: WebSocket): void {
    socket.addEventListener('message', (ev) => {
      if (closed) return;
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      let frame: SlackSocketFrame;
      try {
        frame = JSON.parse(raw) as SlackSocketFrame;
      } catch (err) {
        opts.logger?.warn?.('slack.socket.decode.failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (frame.envelope_id && !closed) {
        try {
          socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
        } catch (err) {
          opts.logger?.warn?.('slack.socket.ack.failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (handler) {
        void Promise.resolve(handler(frame)).catch((err: unknown) => {
          opts.logger?.warn?.('slack.socket.handler.error', {
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });
    socket.addEventListener('close', () => {
      isConnected = false;
      opts.logger?.debug?.('slack.socket.closed');
      if (!closed) scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    const delay = backoff(reconnectAttempt);
    reconnectAttempt += 1;
    opts.logger?.warn?.('slack.socket.reconnecting', { attempt: reconnectAttempt, delayMs: delay });
    opts.onReconnect?.(reconnectAttempt);
    reconnectTimer = setT(() => {
      reconnectTimer = null;
      void reopen();
    }, delay);
  }

  async function reopen(): Promise<void> {
    if (closed) return;
    try {
      const url = await opts.getUrl();
      const socket = new WSImpl(url);
      ws = socket;
      socket.addEventListener('open', () => {
        isConnected = true;
        reconnectAttempt = 0; // reset backoff once we're healthy again
        opts.logger?.debug?.('slack.socket.reconnected');
      });
      wire(socket);
    } catch (err) {
      opts.logger?.warn?.('slack.socket.reconnect.failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      scheduleReconnect();
    }
  }

  return {
    async connect() {
      const url = await opts.getUrl();
      const socket = new WSImpl(url);
      ws = socket;
      // Wire message + close→reconnect BEFORE awaiting open so no early frame
      // is missed and a drop during/after handshake triggers reconnect.
      wire(socket);
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          isConnected = true;
          reconnectAttempt = 0;
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('error', onError);
          resolve();
        };
        const onError = (err: unknown) => {
          socket.removeEventListener('open', onOpen);
          socket.removeEventListener('error', onError);
          reject(err instanceof Error ? err : new Error('socket-mode: WebSocket error'));
        };
        socket.addEventListener('open', onOpen);
        socket.addEventListener('error', onError);
      });
    },
    onEvent(h) {
      handler = h;
    },
    connected() {
      return isConnected;
    },
    async close() {
      closed = true;
      isConnected = false;
      if (reconnectTimer !== null) {
        clearT(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
    },
  };
}

// ── Fetch-backed Web API client ──────────────────────────────────────────

export interface CreateSlackClientOptions {
  botToken: string;
  /** App-level token (xapp-...) required only for Socket Mode. */
  appToken?: string;
  /** Base URL override (for on-prem proxies / tests). Default: api.slack.com. */
  baseUrl?: string;
  /** Injected fetch (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
}

export function createSlackClient(opts: CreateSlackClientOptions): SlackClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? 'https://slack.com';
  const endpoint = (method: string) => `${baseUrl}/api/${method}`;

  async function callJson<T extends { ok: boolean; error?: string }>(
    method: string,
    body: unknown,
    tokenOverride?: string,
  ): Promise<T> {
    const res = await fetchImpl(endpoint(method), {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${tokenOverride ?? opts.botToken}`,
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new SlackApiError(
        `invalid JSON response from ${method}: ${text.slice(0, 200)}`,
        method,
        undefined,
        undefined,
        res.status,
      );
    }
    if (!parsed.ok) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSec = retryAfterHeader
        ? Math.max(0, Number.parseInt(retryAfterHeader, 10))
        : undefined;
      throw new SlackApiError(
        parsed.error ?? `Slack ${method} failed`,
        method,
        parsed.error,
        Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
        res.status,
      );
    }
    return parsed;
  }

  async function authTest(): Promise<SlackAuthTestResponse> {
    return callJson<SlackAuthTestResponse>('auth.test', {});
  }

  async function chatPostMessage(params: ChatPostMessageParams): Promise<SlackPostMessageResponse> {
    return callJson<SlackPostMessageResponse>('chat.postMessage', params);
  }

  async function chatUpdate(params: ChatUpdateParams): Promise<SlackPostMessageResponse> {
    return callJson<SlackPostMessageResponse>('chat.update', params);
  }

  async function chatDelete(
    params: ChatDeleteParams,
  ): Promise<{ ok: boolean; channel?: string; ts?: string }> {
    return callJson<{ ok: boolean; channel?: string; ts?: string }>('chat.delete', params);
  }

  async function reactionsAdd(params: ReactionsAddParams): Promise<{ ok: boolean }> {
    return callJson<{ ok: boolean }>('reactions.add', params);
  }

  async function conversationsReplies(
    params: ConversationsRepliesParams,
  ): Promise<SlackConversationsRepliesResponse> {
    // conversations.replies supports GET with query params, but POST JSON is accepted too.
    return callJson<SlackConversationsRepliesResponse>('conversations.replies', params);
  }

  /**
   * Upload via the v2 external-upload flow:
   *  1. `files.getUploadURLExternal` → { upload_url, file_id }
   *  2. `PUT upload_url` with the bytes
   *  3. `files.completeUploadExternal` with `{ files: [{ id }], channel_id, initial_comment }`
   *
   * TODO: the legacy `files.upload` endpoint is also callable when bots
   * lack `files:read` but keep `files:write`. We only implement the v2
   * flow here — if a workspace fails step 1, the instance surfaces the
   * error and falls back to `chat.postMessage` with a link (see
   * `instance.ts`).
   */
  async function filesUploadV2(params: FilesUploadV2Params): Promise<SlackFilesUploadV2Response> {
    if (!params.bytes && !params.fromUrl) {
      throw new Error('filesUploadV2: one of bytes or fromUrl is required');
    }
    // Step 1 — request an upload URL.
    const length = params.bytes?.byteLength ?? 0;
    const step1 = await callJson<{
      ok: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    }>('files.getUploadURLExternal', {
      filename: params.filename,
      length,
    });
    if (!step1.upload_url || !step1.file_id) {
      return { ok: false, error: step1.error ?? 'upload_url_missing' };
    }

    // Step 2 — PUT bytes (or skip if fromUrl, let Slack fetch it later).
    if (params.bytes) {
      const putRes = await fetchImpl(step1.upload_url, {
        method: 'POST',
        body: params.bytes,
      });
      if (!putRes.ok) {
        return { ok: false, error: `upload_put_failed_${putRes.status}` };
      }
    }

    // Step 3 — complete.
    const completeBody: Record<string, unknown> = {
      files: [{ id: step1.file_id, title: params.title ?? params.filename }],
    };
    if (params.channel !== undefined) completeBody.channel_id = params.channel;
    if (params.thread_ts !== undefined) completeBody.thread_ts = params.thread_ts;
    if (params.initial_comment !== undefined) completeBody.initial_comment = params.initial_comment;

    const step3 = await callJson<SlackFilesUploadV2Response>(
      'files.completeUploadExternal',
      completeBody,
    );
    return step3;
  }

  async function appsConnectionsOpen(): Promise<SlackAppsConnectionsOpenResponse> {
    if (!opts.appToken) {
      throw new Error('appsConnectionsOpen requires appToken to be set');
    }
    return callJson<SlackAppsConnectionsOpenResponse>('apps.connections.open', {}, opts.appToken);
  }

  return {
    authTest,
    chatPostMessage,
    chatUpdate,
    chatDelete,
    reactionsAdd,
    conversationsReplies,
    filesUploadV2,
    appsConnectionsOpen,
  };
}

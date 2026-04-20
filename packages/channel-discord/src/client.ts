/**
 * Fetch-backed Discord REST client + a minimal Gateway transport. The
 * adapter deals only with this narrow surface so tests can swap in an
 * in-memory stub without real network traffic.
 *
 * REST calls go to `https://discord.com/api/v10/...`.
 * Gateway (WebSocket) is abstracted behind `GatewayTransport` so a stub
 * implementation can drive synthetic READY / MESSAGE_CREATE /
 * INTERACTION_CREATE events in tests.
 */

import type {
  DiscordApplicationCommand,
  DiscordChannel,
  DiscordGatewayBotInfo,
  DiscordGatewayPayload,
  DiscordInteractionResponse,
  DiscordMessage,
  DiscordUser,
} from './discord-api.js';

// ── REST request params ───────────────────────────────────────────────────

export interface DiscordSendMessageParams {
  channelId: string;
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  message_reference?: { message_id: string; channel_id?: string };
  /**
   * When set, the client sends `multipart/form-data` with these files
   * attached. The adapter passes already-fetched URL or local path
   * references; the client resolves them to bytes before POSTing.
   */
  files?: { name: string; url?: string; path?: string }[];
  allowed_mentions?: { parse?: string[]; replied_user?: boolean };
}

export interface DiscordEditMessageParams {
  channelId: string;
  messageId: string;
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

export interface DiscordDeleteMessageParams {
  channelId: string;
  messageId: string;
}

export interface DiscordCreateReactionParams {
  channelId: string;
  messageId: string;
  /** Unicode char or `name:id` for custom emoji. */
  emoji: string;
}

export interface DiscordTriggerTypingParams {
  channelId: string;
}

export interface DiscordUnarchiveThreadParams {
  threadId: string;
}

export interface DiscordRegisterGlobalCommandsParams {
  applicationId: string;
  commands: DiscordApplicationCommand[];
}

export interface DiscordCreateInteractionResponseParams {
  interactionId: string;
  interactionToken: string;
  response: DiscordInteractionResponse;
}

export interface DiscordCreateFollowupMessageParams {
  applicationId: string;
  interactionToken: string;
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  flags?: number;
}

// ── Gateway transport ─────────────────────────────────────────────────────

export type GatewayEventHandler = (payload: DiscordGatewayPayload) => void | Promise<void>;

/**
 * Minimal Gateway surface. The default implementation hand-rolls a
 * WebSocket client; tests inject a stub that pushes synthetic events.
 *
 * NOTE: The default transport ships identify + heartbeat + dispatch
 * only. Session resume, zombie detection, and automatic reconnect with
 * `resume_gateway_url` are TODOs — on disconnect the transport calls
 * `onDisconnect` (if provided) and stops. A higher-level reconnect loop
 * can be layered on later without changing this interface.
 */
export interface GatewayTransport {
  connect(): Promise<void>;
  onEvent(handler: GatewayEventHandler): void;
  onDisconnect?(handler: (reason: string) => void): void;
  close(): Promise<void>;
}

export interface CreateGatewayTransportOptions {
  botToken: string;
  /** Gateway intents bitfield. */
  intents: number;
  /** Gateway URL override (e.g. from `/gateway/bot`). */
  gatewayUrl?: string;
  /** Shard id + total. Default: `[0, 1]`. */
  shard?: [number, number];
  /**
   * Injected `WebSocket` constructor for tests. Default:
   * `globalThis.WebSocket`.
   */
  websocketImpl?: typeof WebSocket;
}

// ── Errors ────────────────────────────────────────────────────────────────

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly status: number,
    readonly body: unknown,
    /** Populated when Discord returns a `retry_after` in the body. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

// ── Client interface ──────────────────────────────────────────────────────

export interface DiscordClient {
  // REST
  getCurrentUser(): Promise<DiscordUser>;
  getGatewayBotInfo(): Promise<DiscordGatewayBotInfo>;
  getChannel(channelId: string): Promise<DiscordChannel>;
  sendMessage(params: DiscordSendMessageParams): Promise<DiscordMessage>;
  editMessage(params: DiscordEditMessageParams): Promise<DiscordMessage>;
  deleteMessage(params: DiscordDeleteMessageParams): Promise<void>;
  createReaction(params: DiscordCreateReactionParams): Promise<void>;
  triggerTypingIndicator(params: DiscordTriggerTypingParams): Promise<void>;
  unarchiveThread(params: DiscordUnarchiveThreadParams): Promise<void>;
  registerGlobalCommands(params: DiscordRegisterGlobalCommandsParams): Promise<unknown[]>;
  createInteractionResponse(params: DiscordCreateInteractionResponseParams): Promise<void>;
  createFollowupMessage(params: DiscordCreateFollowupMessageParams): Promise<DiscordMessage>;

  // Gateway factory (invoked by the instance at start)
  createGatewayTransport(opts: CreateGatewayTransportOptions): GatewayTransport;
}

// ── Fetch-backed implementation ───────────────────────────────────────────

export interface CreateDiscordClientOptions {
  botToken: string;
  applicationId: string;
  /** Base URL override (default `https://discord.com/api/v10`). */
  baseUrl?: string;
  /** Injected fetch (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /**
   * Gateway transport factory override. Tests inject a stub here;
   * production leaves unset and the default hand-rolled WebSocket
   * implementation is used.
   */
  gatewayTransport?: (opts: CreateGatewayTransportOptions) => GatewayTransport;
}

export function createDiscordClient(opts: CreateDiscordClientOptions): DiscordClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? 'https://discord.com/api/v10';
  const authHeader = `Bot ${opts.botToken}`;

  async function call<T>(
    method: string,
    path: string,
    init: { body?: unknown; json?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: authHeader,
      'user-agent': 'Declaragent (channel-discord, 0.0.1)',
      ...(init.headers ?? {}),
    };
    let body: string | FormData | undefined;
    if (init.body !== undefined) {
      if (init.json !== false) {
        if (!('content-type' in headers)) {
          headers['content-type'] = 'application/json';
        }
        body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      } else {
        body = init.body as FormData;
      }
    }
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body }),
    });
    const text = await res.text();
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        parsed = text;
      }
      let retryAfterMs: number | undefined;
      if (res.status === 429) {
        const maybe = parsed as { retry_after?: number } | null;
        if (maybe && typeof maybe.retry_after === 'number') {
          retryAfterMs = Math.ceil(maybe.retry_after * 1000);
        } else {
          const header = res.headers.get('retry-after');
          if (header) retryAfterMs = Math.ceil(Number(header) * 1000);
        }
      }
      throw new DiscordApiError(
        `Discord ${method} ${path} failed (${res.status})`,
        `${method} ${path}`,
        res.status,
        parsed,
        retryAfterMs,
      );
    }
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  function encodeEmoji(emoji: string): string {
    // Custom emoji look like `name:id`; pass through with URL encoding.
    return encodeURIComponent(emoji);
  }

  async function sendMessage(params: DiscordSendMessageParams): Promise<DiscordMessage> {
    if (params.files && params.files.length > 0) {
      // Discord accepts multipart form-data with a `payload_json` part
      // and numbered `files[N]` parts. We use the global FormData which
      // Bun and modern browsers ship; it integrates with fetch.
      const form = new FormData();
      const payload: Record<string, unknown> = {};
      if (params.content !== undefined) payload.content = params.content;
      if (params.embeds !== undefined) payload.embeds = params.embeds;
      if (params.components !== undefined) payload.components = params.components;
      if (params.message_reference !== undefined)
        payload.message_reference = params.message_reference;
      if (params.allowed_mentions !== undefined) payload.allowed_mentions = params.allowed_mentions;
      form.set('payload_json', JSON.stringify(payload));
      let i = 0;
      for (const file of params.files) {
        const bytes = await resolveFileBytes(file, fetchImpl);
        form.set(`files[${i}]`, new Blob([new Uint8Array(bytes)]), file.name);
        i += 1;
      }
      return call<DiscordMessage>('POST', `/channels/${params.channelId}/messages`, {
        body: form,
        json: false,
      });
    }
    const body: Record<string, unknown> = {};
    if (params.content !== undefined) body.content = params.content;
    if (params.embeds !== undefined) body.embeds = params.embeds;
    if (params.components !== undefined) body.components = params.components;
    if (params.message_reference !== undefined) body.message_reference = params.message_reference;
    if (params.allowed_mentions !== undefined) body.allowed_mentions = params.allowed_mentions;
    return call<DiscordMessage>('POST', `/channels/${params.channelId}/messages`, { body });
  }

  return {
    getCurrentUser: () => call<DiscordUser>('GET', '/users/@me'),
    getGatewayBotInfo: () => call<DiscordGatewayBotInfo>('GET', '/gateway/bot'),
    getChannel: (id) => call<DiscordChannel>('GET', `/channels/${id}`),
    sendMessage,
    editMessage: (params) =>
      call<DiscordMessage>('PATCH', `/channels/${params.channelId}/messages/${params.messageId}`, {
        body: {
          ...(params.content !== undefined && { content: params.content }),
          ...(params.embeds !== undefined && { embeds: params.embeds }),
          ...(params.components !== undefined && { components: params.components }),
        },
      }),
    deleteMessage: async (params) => {
      await call<void>('DELETE', `/channels/${params.channelId}/messages/${params.messageId}`);
    },
    createReaction: async (params) => {
      await call<void>(
        'PUT',
        `/channels/${params.channelId}/messages/${params.messageId}/reactions/${encodeEmoji(params.emoji)}/@me`,
      );
    },
    triggerTypingIndicator: async (params) => {
      await call<void>('POST', `/channels/${params.channelId}/typing`);
    },
    unarchiveThread: async (params) => {
      await call<void>('PATCH', `/channels/${params.threadId}`, {
        body: { archived: false },
      });
    },
    registerGlobalCommands: (params) =>
      call<unknown[]>('PUT', `/applications/${params.applicationId}/commands`, {
        body: params.commands,
      }),
    createInteractionResponse: async (params) => {
      await call<void>(
        'POST',
        `/interactions/${params.interactionId}/${params.interactionToken}/callback`,
        { body: params.response },
      );
    },
    createFollowupMessage: (params) =>
      call<DiscordMessage>('POST', `/webhooks/${params.applicationId}/${params.interactionToken}`, {
        body: {
          ...(params.content !== undefined && { content: params.content }),
          ...(params.embeds !== undefined && { embeds: params.embeds }),
          ...(params.components !== undefined && { components: params.components }),
          ...(params.flags !== undefined && { flags: params.flags }),
        },
      }),
    createGatewayTransport: (transportOpts) => {
      if (opts.gatewayTransport) return opts.gatewayTransport(transportOpts);
      return createDefaultGatewayTransport(transportOpts);
    },
  };
}

async function resolveFileBytes(
  file: { name: string; url?: string; path?: string },
  fetchImpl: typeof fetch,
): Promise<ArrayBuffer> {
  if (file.url) {
    const r = await fetchImpl(file.url);
    if (!r.ok) throw new Error(`failed to fetch ${file.url} (${r.status})`);
    return r.arrayBuffer();
  }
  if (file.path) {
    // Bun: Bun.file(path).arrayBuffer() avoids the Node fs dep. We also
    // support the `file://` URL form for ergonomics.
    const b = (
      globalThis as unknown as {
        Bun?: { file(p: string): { arrayBuffer(): Promise<ArrayBuffer> } };
      }
    ).Bun;
    if (b) return b.file(file.path).arrayBuffer();
    throw new Error(`file upload via path "${file.path}" requires Bun runtime; use url instead`);
  }
  throw new Error('discord file part requires url or path');
}

// ── Default Gateway transport (hand-rolled WebSocket) ─────────────────────

/**
 * Minimal hand-rolled Gateway transport.
 *
 * Scope:
 * - Opens a WebSocket to Discord's gateway URL.
 * - Parses the Hello (op 10) payload, schedules heartbeats at the
 *   provided `heartbeat_interval` with initial jitter.
 * - Sends Identify (op 2) after Hello.
 * - Dispatches every `op: 0` payload to the `onEvent` handler.
 * - On socket close or error, calls `onDisconnect` and stops. There is
 *   no automatic reconnect / resume — that lands in a follow-up slice
 *   (see TODO below).
 *
 * TODO: Session resume via `resume_gateway_url` + sequence ack, zombie
 * detection (missed heartbeats), reconnect backoff, and gateway URL
 * refresh on 4000-series close codes. Tests inject a stub today; a
 * production deployment should set `gatewayTransport` in
 * `createDiscordClient` until this transport is hardened.
 */
function createDefaultGatewayTransport(opts: CreateGatewayTransportOptions): GatewayTransport {
  const wsCtor = opts.websocketImpl ?? globalThis.WebSocket;
  let ws: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastSequence: number | null = null;
  const eventHandlers: GatewayEventHandler[] = [];
  const disconnectHandlers: ((reason: string) => void)[] = [];
  let closed = false;

  function send(payload: DiscordGatewayPayload): void {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  function dispatch(payload: DiscordGatewayPayload): void {
    for (const handler of eventHandlers) {
      try {
        void handler(payload);
      } catch {
        // swallow handler errors; adapter logs at a higher level
      }
    }
  }

  function notifyDisconnect(reason: string): void {
    for (const handler of disconnectHandlers) {
      try {
        handler(reason);
      } catch {
        /* noop */
      }
    }
  }

  return {
    async connect(): Promise<void> {
      if (!wsCtor) {
        throw new Error(
          'No WebSocket implementation available on globalThis. Inject `websocketImpl`.',
        );
      }
      const gatewayUrl = opts.gatewayUrl ?? 'wss://gateway.discord.gg/?v=10&encoding=json';
      ws = new wsCtor(gatewayUrl);
      ws.addEventListener('message', (evt: MessageEvent) => {
        let payload: DiscordGatewayPayload;
        try {
          payload = JSON.parse(
            typeof evt.data === 'string' ? evt.data : '',
          ) as DiscordGatewayPayload;
        } catch {
          return;
        }
        if (typeof payload.s === 'number') lastSequence = payload.s;
        if (payload.op === 10) {
          // Hello
          const data = payload.d as { heartbeat_interval: number };
          const interval = data.heartbeat_interval;
          heartbeatTimer = setInterval(() => {
            send({ op: 1, d: lastSequence });
          }, interval);
          // Identify
          send({
            op: 2,
            d: {
              token: opts.botToken,
              intents: opts.intents,
              properties: {
                os: 'linux',
                browser: 'declaragent',
                device: 'declaragent',
              },
              ...(opts.shard !== undefined && { shard: opts.shard }),
            },
          });
          return;
        }
        if (payload.op === 0) dispatch(payload);
      });
      ws.addEventListener('close', (evt: CloseEvent) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (!closed) notifyDisconnect(`close:${evt.code}:${evt.reason ?? ''}`);
      });
      ws.addEventListener('error', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (!closed) notifyDisconnect('error');
      });
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    onDisconnect(handler) {
      disconnectHandlers.push(handler);
    },
    async close(): Promise<void> {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (ws) {
        try {
          ws.close(1000, 'instance stop');
        } catch {
          /* noop */
        }
        ws = null;
      }
    },
  };
}

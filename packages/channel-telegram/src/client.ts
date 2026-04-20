/**
 * Fetch-backed Telegram Bot API client. Lightweight abstraction so
 * tests can swap in an in-memory stub without touching the network.
 *
 * The real client calls `https://api.telegram.org/bot<token>/<method>`
 * with a JSON body. All responses follow Telegram's `{ ok, result,
 * description, error_code, parameters }` envelope which this module
 * unwraps before returning.
 */

import type {
  TelegramBotInfo,
  TelegramChatAction,
  TelegramMessage,
  TelegramUpdate,
} from './telegram-api.js';

/**
 * InlineKeyboardButton — one of `callback_data` or `url` is populated
 * per Telegram Bot API. Left as an object with both optional so the
 * renderer's output type (from `@declaragent/core`) assigns directly.
 */
export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

export interface SendMessageParams {
  chat_id: string | number;
  text: string;
  parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  reply_markup?: TelegramReplyMarkup;
  reply_parameters?: { message_id: number };
  disable_notification?: boolean;
}

export interface SendDocumentParams {
  chat_id: string | number;
  document: string; // URL, file_id, or local path reference understood by the caller
  caption?: string;
  parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  reply_parameters?: { message_id: number };
}

export interface SendVoiceParams {
  chat_id: string | number;
  voice: string;
  duration?: number;
  reply_parameters?: { message_id: number };
}

export interface EditMessageTextParams {
  chat_id: string | number;
  message_id: number;
  text: string;
  parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  reply_markup?: TelegramReplyMarkup;
}

export interface DeleteMessageParams {
  chat_id: string | number;
  message_id: number;
}

export interface SendChatActionParams {
  chat_id: string | number;
  action: TelegramChatAction;
  message_thread_id?: number;
}

export interface SetMessageReactionParams {
  chat_id: string | number;
  message_id: number;
  /** Each reaction is either an emoji or a custom_emoji id. */
  reaction: { type: 'emoji'; emoji: string }[];
}

export interface SetWebhookParams {
  url: string;
  secret_token?: string;
  allowed_updates?: string[];
}

export interface GetUpdatesParams {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export interface AnswerCallbackQueryParams {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

/**
 * Narrow surface every Telegram call goes through. Tests supply a stub
 * that records calls + returns canned responses; production supplies
 * `createTelegramClient(token)`.
 */
export interface TelegramClient {
  getMe(): Promise<TelegramBotInfo>;
  getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]>;
  setWebhook(params: SetWebhookParams): Promise<boolean>;
  deleteWebhook(): Promise<boolean>;
  sendMessage(params: SendMessageParams): Promise<TelegramMessage>;
  sendDocument(params: SendDocumentParams): Promise<TelegramMessage>;
  sendVoice(params: SendVoiceParams): Promise<TelegramMessage>;
  editMessageText(params: EditMessageTextParams): Promise<TelegramMessage | true>;
  deleteMessage(params: DeleteMessageParams): Promise<boolean>;
  sendChatAction(params: SendChatActionParams): Promise<boolean>;
  setMessageReaction(params: SetMessageReactionParams): Promise<boolean>;
  answerCallbackQuery(params: AnswerCallbackQueryParams): Promise<boolean>;
}

// ── Errors ────────────────────────────────────────────────────────────────

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly errorCode: number | undefined,
    readonly parameters: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

// ── Fetch-backed implementation ───────────────────────────────────────────

export interface CreateTelegramClientOptions {
  token: string;
  /** Base URL override (for on-prem Bot API server). Default: api.telegram.org. */
  baseUrl?: string;
  /** Injected fetch (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
}

export function createTelegramClient(opts: CreateTelegramClientOptions): TelegramClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? 'https://api.telegram.org';
  const endpoint = (method: string) => `${baseUrl}/bot${opts.token}/${method}`;

  async function call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetchImpl(endpoint(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed: {
      ok: boolean;
      result?: unknown;
      description?: string;
      error_code?: number;
      parameters?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TelegramApiError(
        `invalid JSON response from ${method}: ${text.slice(0, 200)}`,
        method,
        undefined,
        undefined,
      );
    }
    if (!parsed.ok) {
      throw new TelegramApiError(
        parsed.description ?? `Telegram ${method} failed`,
        method,
        parsed.error_code,
        parsed.parameters,
      );
    }
    return parsed.result as T;
  }

  return {
    getMe: () => call<TelegramBotInfo>('getMe', {}),
    getUpdates: (params) => call<TelegramUpdate[]>('getUpdates', params),
    setWebhook: (params) => call<boolean>('setWebhook', params),
    deleteWebhook: () => call<boolean>('deleteWebhook', {}),
    sendMessage: (params) => call<TelegramMessage>('sendMessage', params),
    sendDocument: (params) => call<TelegramMessage>('sendDocument', params),
    sendVoice: (params) => call<TelegramMessage>('sendVoice', params),
    editMessageText: (params) => call<TelegramMessage | true>('editMessageText', params),
    deleteMessage: (params) => call<boolean>('deleteMessage', params),
    sendChatAction: (params) => call<boolean>('sendChatAction', params),
    setMessageReaction: (params) => call<boolean>('setMessageReaction', params),
    answerCallbackQuery: (params) => call<boolean>('answerCallbackQuery', params),
  };
}

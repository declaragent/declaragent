/**
 * Fetch-backed Meta WhatsApp Cloud API client. Lightweight abstraction so
 * tests can swap in an in-memory stub without touching the network.
 *
 * Every call hits `https://graph.facebook.com/<version>/<phoneNumberId>/<method>`
 * (or `/<businessAccountId>/<method>` for template management) with a JSON
 * body and a `Bearer <accessToken>` header. Error bodies follow Meta's
 * `{ error: { message, code, error_subcode, fbtrace_id, error_data: { details } } }`
 * envelope which this module unwraps before throwing.
 */

import type {
  WhatsAppPhoneNumberInfo,
  WhatsAppTemplate,
  WhatsAppTemplateComponent,
} from './whatsapp-api.js';

// ── Outbound payload shapes ────────────────────────────────────────────────

export interface WhatsAppSendTextParams {
  to: string;
  body: string;
  previewUrl?: boolean;
  replyTo?: string;
}

export interface WhatsAppReplyButton {
  type: 'reply';
  reply: { id: string; title: string };
}

export interface WhatsAppButtonInteractive {
  type: 'button';
  body: { text: string };
  footer?: { text: string };
  action: { buttons: WhatsAppReplyButton[] };
}

export interface WhatsAppListInteractive {
  type: 'list';
  body: { text: string };
  footer?: { text: string };
  action: {
    button: string;
    sections: { rows: { id: string; title: string; description?: string }[] }[];
  };
}

export type WhatsAppInteractive = WhatsAppButtonInteractive | WhatsAppListInteractive;

export interface WhatsAppSendInteractiveParams {
  to: string;
  interactive: WhatsAppInteractive;
  replyTo?: string;
}

export interface WhatsAppSendTemplateParams {
  to: string;
  name: string;
  language: string;
  components?: {
    type: 'header' | 'body' | 'footer' | 'button';
    parameters?: { type: 'text'; text: string }[];
  }[];
}

export type WhatsAppMediaType = 'document' | 'image' | 'audio' | 'video';

export interface WhatsAppSendMediaParams {
  to: string;
  mediaType: WhatsAppMediaType;
  /** Hosted URL — Meta fetches it server-side. */
  url?: string;
  /** Pre-uploaded media id. */
  id?: string;
  caption?: string;
  filename?: string;
  replyTo?: string;
}

export interface WhatsAppSendReactionParams {
  to: string;
  messageId: string;
  emoji: string;
}

export interface WhatsAppCreateTemplateParams {
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  components: WhatsAppTemplateComponent[];
}

export interface WhatsAppSentResponse {
  messaging_product: 'whatsapp';
  contacts: { input: string; wa_id: string }[];
  messages: { id: string }[];
}

export interface WhatsAppMediaUrlResponse {
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
  /** Messaging product identifier (always `whatsapp`). */
  messaging_product: 'whatsapp';
}

// ── Client surface ────────────────────────────────────────────────────────

export interface WhatsAppClient {
  sendText(params: WhatsAppSendTextParams): Promise<WhatsAppSentResponse>;
  sendInteractive(params: WhatsAppSendInteractiveParams): Promise<WhatsAppSentResponse>;
  sendTemplate(params: WhatsAppSendTemplateParams): Promise<WhatsAppSentResponse>;
  sendMedia(params: WhatsAppSendMediaParams): Promise<WhatsAppSentResponse>;
  sendReaction(params: WhatsAppSendReactionParams): Promise<WhatsAppSentResponse>;
  /** Fetch the Cloud API media descriptor (URL valid ~5 min). */
  getMedia(mediaId: string): Promise<WhatsAppMediaUrlResponse>;
  /** Download raw bytes from the descriptor URL. */
  downloadMedia(url: string): Promise<Uint8Array>;
  listTemplates(): Promise<WhatsAppTemplate[]>;
  createTemplate(params: WhatsAppCreateTemplateParams): Promise<WhatsAppTemplate>;
  getPhoneNumber(): Promise<WhatsAppPhoneNumberInfo>;
}

// ── Errors ────────────────────────────────────────────────────────────────

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly errorCode: number | undefined,
    readonly errorSubcode: number | undefined,
    readonly retryAfterMs: number | undefined,
    readonly fbtraceId: string | undefined,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

// ── Fetch-backed implementation ───────────────────────────────────────────

export interface CreateWhatsAppClientOptions {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  /** API version prefix; defaults to `v18.0`. */
  apiVersion?: string;
  /** Base URL override; defaults to `https://graph.facebook.com`. */
  baseUrl?: string;
  /** Injected fetch (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
}

export function createWhatsAppClient(opts: CreateWhatsAppClientOptions): WhatsAppClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? 'https://graph.facebook.com';
  const version = opts.apiVersion ?? 'v18.0';
  const root = `${baseUrl}/${version}`;
  const phoneScope = `${root}/${opts.phoneNumberId}`;
  const wabaScope = `${root}/${opts.businessAccountId}`;

  async function call<T>(method: string, url: string, init: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.accessToken}`,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body && !(init.body instanceof Uint8Array)) {
      headers['content-type'] = 'application/json';
    }
    const res = await fetchImpl(url, { ...init, headers });
    const text = await res.text();
    if (!res.ok) {
      let parsedErr: {
        error?: {
          message?: string;
          code?: number;
          error_subcode?: number;
          fbtrace_id?: string;
          error_data?: { details?: string };
        };
      } = {};
      try {
        parsedErr = JSON.parse(text);
      } catch {
        /* non-JSON body — fall through */
      }
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : res.status === 429
          ? 1000
          : undefined;
      throw new WhatsAppApiError(
        parsedErr.error?.message ??
          parsedErr.error?.error_data?.details ??
          `WhatsApp ${method} failed (${res.status})`,
        method,
        parsedErr.error?.code,
        parsedErr.error?.error_subcode,
        retryAfterMs,
        parsedErr.error?.fbtrace_id,
        res.status,
      );
    }
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WhatsAppApiError(
        `invalid JSON response from ${method}: ${text.slice(0, 200)}`,
        method,
        undefined,
        undefined,
        undefined,
        undefined,
        res.status,
      );
    }
  }

  function messageBody(base: Record<string, unknown>, replyTo?: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...base,
    };
    if (replyTo !== undefined) body.context = { message_id: replyTo };
    return body;
  }

  function postMessage<T>(method: string, body: Record<string, unknown>): Promise<T> {
    return call<T>(method, `${phoneScope}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  return {
    sendText: (params) => {
      const body = messageBody(
        {
          to: params.to,
          type: 'text',
          text: {
            body: params.body,
            ...(params.previewUrl !== undefined && { preview_url: params.previewUrl }),
          },
        },
        params.replyTo,
      );
      return postMessage<WhatsAppSentResponse>('sendText', body);
    },

    sendInteractive: (params) => {
      const body = messageBody(
        { to: params.to, type: 'interactive', interactive: params.interactive },
        params.replyTo,
      );
      return postMessage<WhatsAppSentResponse>('sendInteractive', body);
    },

    sendTemplate: (params) => {
      const template: Record<string, unknown> = {
        name: params.name,
        language: { code: params.language },
      };
      if (params.components && params.components.length > 0) {
        template.components = params.components;
      }
      const body = messageBody({ to: params.to, type: 'template', template });
      return postMessage<WhatsAppSentResponse>('sendTemplate', body);
    },

    sendMedia: (params) => {
      const media: Record<string, unknown> = {};
      if (params.id !== undefined) media.id = params.id;
      if (params.url !== undefined) media.link = params.url;
      if (params.caption !== undefined) media.caption = params.caption;
      if (params.filename !== undefined) media.filename = params.filename;
      const body = messageBody(
        { to: params.to, type: params.mediaType, [params.mediaType]: media },
        params.replyTo,
      );
      return postMessage<WhatsAppSentResponse>('sendMedia', body);
    },

    sendReaction: (params) => {
      const body = messageBody({
        to: params.to,
        type: 'reaction',
        reaction: { message_id: params.messageId, emoji: params.emoji },
      });
      return postMessage<WhatsAppSentResponse>('sendReaction', body);
    },

    getMedia: (mediaId) =>
      call<WhatsAppMediaUrlResponse>('getMedia', `${root}/${mediaId}`, { method: 'GET' }),

    downloadMedia: async (url) => {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.accessToken}` },
      });
      if (!res.ok) {
        throw new WhatsAppApiError(
          `downloadMedia failed (${res.status})`,
          'downloadMedia',
          undefined,
          undefined,
          undefined,
          undefined,
          res.status,
        );
      }
      return new Uint8Array(await res.arrayBuffer());
    },

    listTemplates: async () => {
      const resp = await call<{ data: WhatsAppTemplate[] }>(
        'listTemplates',
        `${wabaScope}/message_templates`,
        { method: 'GET' },
      );
      return resp.data ?? [];
    },

    createTemplate: (params) =>
      call<WhatsAppTemplate>('createTemplate', `${wabaScope}/message_templates`, {
        method: 'POST',
        body: JSON.stringify({
          name: params.name,
          language: params.language,
          category: params.category,
          components: params.components,
        }),
      }),

    getPhoneNumber: () =>
      call<WhatsAppPhoneNumberInfo>('getPhoneNumber', phoneScope, { method: 'GET' }),
  };
}

import type {
  AgentEvent,
  ChannelPrincipal,
  ConversationRef,
  EventKind,
  EventSourceTag,
  MessageRef,
} from '@declaragent/core';
import { conversationSessionId } from '@declaragent/core';
import type {
  WhatsAppContact,
  WhatsAppInboundMessage,
  WhatsAppMediaDescriptor,
  WhatsAppWebhookBody,
} from './whatsapp-api.js';

export interface ParsedUpdate {
  event: AgentEvent;
  conversation: ConversationRef;
  principal: ChannelPrincipal;
  lastInboundMessageRef: MessageRef;
  sessionId: string;
  /** ms-epoch the window tracker should use when `recordInbound(waId, ...)`. */
  recordedAtMs: number;
  /**
   * Populated when the inbound carries media (image/document/audio/video)
   * so the caller can asynchronously fetch the Cloud API media URL before
   * the 5-minute TTL expires.
   */
  media?: { mediaId: string; mediaType: 'image' | 'document' | 'audio' | 'video' };
  summary: string;
}

export interface ParseWebhookOptions {
  channelId: string;
  correlationId?: string;
}

/**
 * Convert a Meta WhatsApp Cloud API webhook body into zero-or-more
 * `ParsedUpdate`s — one per message across all `entry[].changes[].value.messages[]`.
 * Status callbacks (`statuses[]`) are ignored for v0.9.
 */
export function parseWhatsAppWebhook(
  body: WhatsAppWebhookBody,
  options: ParseWebhookOptions,
): ParsedUpdate[] {
  const out: ParsedUpdate[] = [];
  if (!body || body.object !== 'whatsapp_business_account') return out;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value || !Array.isArray(value.messages)) continue;
      const phoneNumberId = value.metadata?.phone_number_id ?? options.channelId;
      const contacts: Map<string, WhatsAppContact> = new Map();
      for (const c of value.contacts ?? []) contacts.set(c.wa_id, c);

      for (const message of value.messages) {
        const parsed = parseMessage(
          message,
          contacts.get(message.from),
          phoneNumberId,
          options.channelId,
          options.correlationId,
        );
        if (parsed) out.push(parsed);
      }
    }
  }

  return out;
}

function parseMessage(
  message: WhatsAppInboundMessage,
  contact: WhatsAppContact | undefined,
  phoneNumberId: string,
  channelId: string,
  correlationId: string | undefined,
): ParsedUpdate | null {
  const conversation: ConversationRef = {
    channelId,
    conversationId: message.from,
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipal(channelId, message.from, contact);
  const lastInboundMessageRef: MessageRef = { conversation, id: message.id };

  const source: EventSourceTag = {
    type: 'whatsapp',
    channelId,
    phoneNumberId,
    waId: message.from,
    messageId: message.id,
  };

  const tsSec = Number(message.timestamp);
  const timestampMs = Number.isFinite(tsSec) ? tsSec * 1000 : Date.now();

  let kind: EventKind;
  const payload: Record<string, unknown> = { from: message.from, raw: message };
  let summary: string;
  let media: ParsedUpdate['media'];

  switch (message.type) {
    case 'text': {
      kind = 'chat.dm';
      payload.text = message.text.body;
      summary = `text from ${principal.displayName ?? message.from}`;
      break;
    }
    case 'button': {
      kind = 'channel.interaction';
      payload.interaction = 'button';
      payload.buttonId = message.button.payload;
      payload.buttonText = message.button.text;
      summary = `template-button "${message.button.payload}" from ${message.from}`;
      break;
    }
    case 'interactive': {
      kind = 'channel.interaction';
      if (message.interactive.type === 'button_reply') {
        payload.interaction = 'button';
        payload.buttonId = message.interactive.button_reply.id;
        payload.buttonText = message.interactive.button_reply.title;
        summary = `interactive-button "${message.interactive.button_reply.id}" from ${message.from}`;
      } else {
        payload.interaction = 'list';
        payload.buttonId = message.interactive.list_reply.id;
        payload.buttonText = message.interactive.list_reply.title;
        if (message.interactive.list_reply.description !== undefined) {
          payload.buttonDescription = message.interactive.list_reply.description;
        }
        summary = `list-selection "${message.interactive.list_reply.id}" from ${message.from}`;
      }
      break;
    }
    case 'reaction': {
      kind = 'channel.reaction';
      payload.emoji = message.reaction.emoji;
      payload.reactedToMessageId = message.reaction.message_id;
      summary = `reaction "${message.reaction.emoji}" from ${message.from}`;
      break;
    }
    case 'image': {
      kind = 'chat.file';
      payload.media = message.image;
      summary = `image from ${message.from}`;
      media = mediaFrom(message.image, 'image');
      break;
    }
    case 'document': {
      kind = 'chat.file';
      payload.media = message.document;
      summary = `document from ${message.from}`;
      media = mediaFrom(message.document, 'document');
      break;
    }
    case 'audio': {
      kind = 'chat.voice';
      payload.media = message.audio;
      summary = `audio from ${message.from}`;
      media = mediaFrom(message.audio, 'audio');
      break;
    }
    case 'video': {
      kind = 'chat.file';
      payload.media = message.video;
      summary = `video from ${message.from}`;
      media = mediaFrom(message.video, 'video');
      break;
    }
    default: {
      // Unknown / future message type — swallow so the dispatcher keeps advancing.
      return null;
    }
  }

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind,
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: timestampMs,
    payload,
    auth: { kind: 'internal' },
    meta: {
      principal,
      ...(correlationId !== undefined && { correlationId }),
    },
  };

  return {
    event,
    conversation,
    principal,
    lastInboundMessageRef,
    sessionId,
    recordedAtMs: timestampMs,
    ...(media !== undefined && { media }),
    summary,
  };
}

function mediaFrom(
  desc: WhatsAppMediaDescriptor,
  mediaType: 'image' | 'document' | 'audio' | 'video',
): ParsedUpdate['media'] {
  return { mediaId: desc.id, mediaType };
}

function buildPrincipal(
  channelId: string,
  waId: string,
  contact: WhatsAppContact | undefined,
): ChannelPrincipal {
  const principal: ChannelPrincipal = {
    channelId,
    platformUserId: waId,
    scopes: [],
    verified: false,
  };
  if (contact?.profile?.name) principal.displayName = contact.profile.name;
  return principal;
}

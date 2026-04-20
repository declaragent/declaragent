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
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from './telegram-api.js';

/**
 * Everything the adapter extracts from a single Telegram update to emit
 * onto the bus + stash into the session-channel context store.
 */
export interface ParsedUpdate {
  event: AgentEvent;
  conversation: ConversationRef;
  principal: ChannelPrincipal;
  lastInboundMessageRef: MessageRef;
  /** Session id the dispatcher will use when the target is a session. */
  sessionId: string;
  /** Human-readable one-liner for debug logs. */
  summary: string;
}

export interface ParseUpdateOptions {
  channelId: string;
  /** Correlate inbound events into the same trace. */
  correlationId?: string;
}

/**
 * Convert a Telegram Update into a normalized `AgentEvent` + context
 * bundle. The adapter never calls the Phase-4 normalizer — channel events
 * have enough shape that we build them directly, which also keeps the
 * `${channel:conversationSessionId}` pseudo-variable interpretation
 * local to the adapter.
 *
 * Returns `null` for updates we don't handle (inline_query etc.) so the
 * caller can advance its `update_id` offset without publishing.
 */
export function parseUpdate(
  update: TelegramUpdate,
  options: ParseUpdateOptions,
): ParsedUpdate | null {
  const channelId = options.channelId;

  if (update.message) {
    return parseMessage(update, update.message, channelId, options.correlationId);
  }
  if (update.edited_message) {
    return parseMessage(update, update.edited_message, channelId, options.correlationId, true);
  }
  if (update.callback_query) {
    return parseCallback(update, update.callback_query, channelId, options.correlationId);
  }
  return null;
}

function parseMessage(
  update: TelegramUpdate,
  msg: TelegramMessage,
  channelId: string,
  correlationId: string | undefined,
  isEdit = false,
): ParsedUpdate | null {
  if (msg.from?.is_bot === true) return null; // never react to other bots

  const conversation: ConversationRef = {
    channelId,
    conversationId: String(msg.chat.id),
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipal(channelId, msg.from);
  const lastInboundMessageRef: MessageRef = {
    conversation,
    id: String(msg.message_id),
  };
  const source: EventSourceTag = {
    type: 'telegram',
    channelId,
    chatId: String(msg.chat.id),
    updateId: update.update_id,
  };

  const isCommand =
    typeof msg.text === 'string' &&
    msg.text.startsWith('/') &&
    (msg.entities ?? []).some((e) => e.type === 'bot_command' && e.offset === 0);

  const isDM = msg.chat.type === 'private';
  const kind: EventKind = isCommand
    ? 'channel.command'
    : isDM
      ? 'chat.dm'
      : msg.voice
        ? 'chat.voice'
        : msg.document || msg.photo
          ? 'chat.file'
          : 'chat.message';

  const payload: Record<string, unknown> = {
    text: msg.text ?? msg.caption ?? '',
    raw: msg,
    chatType: msg.chat.type,
    from: msg.from,
    ...(isEdit && { edited: true }),
  };
  if (isCommand) {
    const first = (msg.text ?? '').split(/\s+/)[0] ?? '';
    payload.command = first.replace(/^\//, '');
    payload.args = (msg.text ?? '').slice(first.length).trim();
  }
  if (msg.voice) payload.voice = msg.voice;
  if (msg.document) payload.document = msg.document;
  if (msg.photo) payload.photo = msg.photo;

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind,
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: msg.date * 1000,
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
    summary: `message from ${principal.displayName ?? principal.platformUserId} in chat ${msg.chat.id}${isEdit ? ' (edited)' : ''}`,
  };
}

function parseCallback(
  update: TelegramUpdate,
  cq: TelegramCallbackQuery,
  channelId: string,
  correlationId: string | undefined,
): ParsedUpdate | null {
  const chatId = cq.message?.chat.id;
  if (chatId === undefined) return null;

  const conversation: ConversationRef = {
    channelId,
    conversationId: String(chatId),
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipal(channelId, cq.from);
  const lastInboundMessageRef: MessageRef = {
    conversation,
    id: String(cq.message?.message_id ?? 0),
  };

  const source: EventSourceTag = {
    type: 'telegram',
    channelId,
    chatId: String(chatId),
    updateId: update.update_id,
  };

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind: 'channel.interaction',
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: Date.now(),
    payload: {
      interaction: 'button',
      callbackQueryId: cq.id,
      buttonId: cq.data ?? '',
      originalMessage: cq.message ?? null,
    },
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
    summary: `button "${cq.data ?? ''}" pressed by ${principal.displayName ?? principal.platformUserId}`,
  };
}

function buildPrincipal(channelId: string, user: TelegramUser | undefined): ChannelPrincipal {
  if (!user) {
    return {
      channelId,
      platformUserId: 'anonymous',
      scopes: [],
      verified: false,
    };
  }
  const principal: ChannelPrincipal = {
    channelId,
    platformUserId: String(user.id),
    scopes: [],
    verified: false,
  };
  if (user.username) {
    principal.displayName = `@${user.username}`;
  } else {
    principal.displayName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  }
  return principal;
}

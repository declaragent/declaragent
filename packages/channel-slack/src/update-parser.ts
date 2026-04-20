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
  SlackAppMentionEvent,
  SlackBlockActionsPayload,
  SlackEventInner,
  SlackEventWrapper,
  SlackMessageEvent,
  SlackReactionEvent,
  SlackSlashCommandPayload,
} from './slack-api.js';

/**
 * Normalized bundle produced by the Slack parser — mirrors the Telegram
 * adapter's shape so the instance layer can treat both the same.
 */
export interface ParsedUpdate {
  event: AgentEvent;
  conversation: ConversationRef;
  principal: ChannelPrincipal;
  lastInboundMessageRef: MessageRef;
  sessionId: string;
  summary: string;
  /**
   * Populated for `app_mention` + thread events. The instance layer reads
   * this to apply `threadOnMention` policy when replying.
   */
  threadHint?: {
    isMention: boolean;
    threadTs?: string;
    parentTs: string;
  };
}

export interface ParseSlackOptions {
  channelId: string;
  correlationId?: string;
}

/**
 * Top-level dispatch: Events API wrapper, Socket Mode `events_api`
 * inner payload, interactive `block_actions`, or a slash command.
 *
 * Returns `null` for:
 * - `url_verification` envelopes (caller handles those inline)
 * - bot-authored `message` events (loop prevention)
 * - unhandled `event.type` values (unfurl_link_shared, team_join, ...)
 */
export function parseSlackEvent(
  wrapperOrPayload:
    | SlackEventWrapper
    | SlackBlockActionsPayload
    | SlackSlashCommandPayload
    | Record<string, unknown>,
  options: ParseSlackOptions,
): ParsedUpdate | null {
  const channelId = options.channelId;
  const w = wrapperOrPayload as { type?: unknown; command?: unknown; event?: unknown };

  // Slash command — top-level `command` field.
  if (typeof w.command === 'string') {
    return parseSlashCommand(
      wrapperOrPayload as SlackSlashCommandPayload,
      channelId,
      options.correlationId,
    );
  }

  // Interactive `block_actions` payload — no `event` wrapper.
  if (w.type === 'block_actions') {
    return parseBlockActions(
      wrapperOrPayload as SlackBlockActionsPayload,
      channelId,
      options.correlationId,
    );
  }

  // Events API envelope.
  if (w.type === 'event_callback' && w.event && typeof w.event === 'object') {
    const wrapper = wrapperOrPayload as Extract<SlackEventWrapper, { type: 'event_callback' }>;
    return parseInnerEvent(wrapper.event, channelId, options.correlationId, wrapper.team_id);
  }

  return null;
}

function parseInnerEvent(
  event: SlackEventInner,
  channelId: string,
  correlationId: string | undefined,
  teamId: string | undefined,
): ParsedUpdate | null {
  switch (event.type) {
    case 'app_mention':
      return parseAppMention(event as SlackAppMentionEvent, channelId, correlationId, teamId);
    case 'message':
      return parseMessage(event as SlackMessageEvent, channelId, correlationId, teamId);
    case 'reaction_added':
    case 'reaction_removed':
      return parseReaction(event as SlackReactionEvent, channelId, correlationId, teamId);
    default:
      return null;
  }
}

function parseMessage(
  msg: SlackMessageEvent,
  channelId: string,
  correlationId: string | undefined,
  teamId: string | undefined,
): ParsedUpdate | null {
  // Loop-prevention: drop anything our own bot (or any bot) authored.
  if (msg.bot_id) return null;
  if (msg.subtype === 'bot_message') return null;
  // Most edit / delete subtypes carry no `user` — skip for now (v0.9).
  if (msg.subtype === 'message_deleted' || msg.subtype === 'message_changed') return null;

  const threadTs = msg.thread_ts;
  const threadedReply = typeof threadTs === 'string' && threadTs !== msg.ts;

  const conversation: ConversationRef = {
    channelId,
    conversationId: msg.channel,
    ...(threadedReply && { threadId: threadTs }),
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipalFromId(channelId, msg.user);
  const lastInboundMessageRef: MessageRef = { conversation, id: msg.ts };

  const source: EventSourceTag = {
    type: 'slack',
    channelId,
    teamId: teamId ?? msg.team ?? '',
    channelSlackId: msg.channel,
    ts: msg.ts,
    ...(threadTs !== undefined && { threadTs }),
  };

  const isDM = msg.channel_type === 'im';
  const kind: EventKind = isDM ? 'chat.dm' : 'chat.message';

  const payload: Record<string, unknown> = {
    text: msg.text ?? '',
    channelType: msg.channel_type ?? 'unknown',
    ts: msg.ts,
    ...(threadTs !== undefined && { threadTs }),
    raw: msg,
  };
  if (msg.files && msg.files.length > 0) payload.files = msg.files;

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind,
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: tsToMs(msg.ts),
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
    summary: `message from ${principal.displayName ?? principal.platformUserId} in ${msg.channel}${threadedReply ? ` (thread ${threadTs})` : ''}`,
    threadHint: {
      isMention: false,
      ...(threadTs !== undefined && { threadTs }),
      parentTs: msg.ts,
    },
  };
}

function parseAppMention(
  event: SlackAppMentionEvent,
  channelId: string,
  correlationId: string | undefined,
  teamId: string | undefined,
): ParsedUpdate | null {
  const threadTs = event.thread_ts;
  const conversation: ConversationRef = {
    channelId,
    conversationId: event.channel,
    ...(threadTs !== undefined && { threadId: threadTs }),
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipalFromId(channelId, event.user);
  const lastInboundMessageRef: MessageRef = { conversation, id: event.ts };

  const source: EventSourceTag = {
    type: 'slack',
    channelId,
    teamId: teamId ?? event.team ?? '',
    channelSlackId: event.channel,
    ts: event.ts,
    ...(threadTs !== undefined && { threadTs }),
  };

  const payload: Record<string, unknown> = {
    text: event.text ?? '',
    ts: event.ts,
    ...(threadTs !== undefined && { threadTs }),
    raw: event,
  };

  const agentEvent: AgentEvent = {
    id: crypto.randomUUID(),
    kind: 'chat.mention',
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: tsToMs(event.ts),
    payload,
    auth: { kind: 'internal' },
    meta: {
      principal,
      ...(correlationId !== undefined && { correlationId }),
    },
  };

  return {
    event: agentEvent,
    conversation,
    principal,
    lastInboundMessageRef,
    sessionId,
    summary: `@mention from ${principal.displayName ?? principal.platformUserId} in ${event.channel}`,
    threadHint: {
      isMention: true,
      ...(threadTs !== undefined && { threadTs }),
      parentTs: event.ts,
    },
  };
}

function parseReaction(
  event: SlackReactionEvent,
  channelId: string,
  correlationId: string | undefined,
  teamId: string | undefined,
): ParsedUpdate | null {
  const conversation: ConversationRef = {
    channelId,
    conversationId: event.item.channel,
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipalFromId(channelId, event.user);
  const lastInboundMessageRef: MessageRef = { conversation, id: event.item.ts };

  const source: EventSourceTag = {
    type: 'slack',
    channelId,
    teamId: teamId ?? '',
    channelSlackId: event.item.channel,
    ts: event.item.ts,
  };

  const agentEvent: AgentEvent = {
    id: crypto.randomUUID(),
    kind: 'channel.reaction',
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: Date.now(),
    payload: {
      added: event.type === 'reaction_added',
      emoji: event.reaction,
      targetTs: event.item.ts,
      channel: event.item.channel,
      raw: event,
    },
    auth: { kind: 'internal' },
    meta: {
      principal,
      ...(correlationId !== undefined && { correlationId }),
    },
  };

  return {
    event: agentEvent,
    conversation,
    principal,
    lastInboundMessageRef,
    sessionId,
    summary: `reaction :${event.reaction}: by ${principal.displayName ?? principal.platformUserId}`,
  };
}

function parseBlockActions(
  payload: SlackBlockActionsPayload,
  channelId: string,
  correlationId: string | undefined,
): ParsedUpdate | null {
  const channel = payload.channel?.id;
  if (!channel) return null;

  const threadTs = payload.container?.thread_ts ?? payload.message?.thread_ts;
  const ts = payload.message?.ts ?? payload.container?.message_ts ?? '';

  const conversation: ConversationRef = {
    channelId,
    conversationId: channel,
    ...(threadTs !== undefined && { threadId: threadTs }),
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipalFromId(channelId, payload.user.id, payload.user.username);
  const lastInboundMessageRef: MessageRef = { conversation, id: ts };

  const primaryAction = payload.actions[0];
  const source: EventSourceTag = {
    type: 'slack',
    channelId,
    teamId: payload.team?.id ?? '',
    channelSlackId: channel,
    ts,
    ...(threadTs !== undefined && { threadTs }),
  };

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind: 'channel.interaction',
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: Date.now(),
    payload: {
      interaction: 'button',
      actionId: primaryAction?.action_id ?? '',
      value: primaryAction?.value ?? primaryAction?.selected_option?.value ?? '',
      triggerId: payload.trigger_id,
      responseUrl: payload.response_url,
      actions: payload.actions,
      raw: payload,
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
    summary: `interaction "${primaryAction?.action_id ?? ''}" by ${principal.displayName ?? principal.platformUserId}`,
  };
}

function parseSlashCommand(
  payload: SlackSlashCommandPayload,
  channelId: string,
  correlationId: string | undefined,
): ParsedUpdate | null {
  const conversation: ConversationRef = {
    channelId,
    conversationId: payload.channel_id,
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipalFromId(channelId, payload.user_id, payload.user_name);
  // Slash commands have no anchor message ts; leave id empty.
  const lastInboundMessageRef: MessageRef = { conversation, id: '' };

  const source: EventSourceTag = {
    type: 'slack',
    channelId,
    teamId: payload.team_id ?? '',
    channelSlackId: payload.channel_id,
    ts: '',
  };

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind: 'channel.command',
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: Date.now(),
    payload: {
      command: payload.command.replace(/^\//, ''),
      args: payload.text ?? '',
      responseUrl: payload.response_url,
      triggerId: payload.trigger_id,
      raw: payload,
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
    summary: `slash "${payload.command}" from ${principal.displayName ?? principal.platformUserId}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildPrincipalFromId(
  channelId: string,
  userId: string | undefined,
  displayName?: string,
): ChannelPrincipal {
  if (!userId) {
    return {
      channelId,
      platformUserId: 'anonymous',
      scopes: [],
      verified: false,
    };
  }
  const principal: ChannelPrincipal = {
    channelId,
    platformUserId: userId,
    scopes: [],
    verified: false,
  };
  if (displayName) principal.displayName = displayName;
  return principal;
}

/**
 * Slack `ts` is a string of the form `"1702345678.001234"` — seconds and
 * microseconds as a decimal. `Number(ts) * 1000` loses microsecond precision
 * but millisecond precision is all `AgentEvent.timestamp` carries, so the
 * lossy conversion is intentional.
 */
function tsToMs(ts: string): number {
  const n = Number.parseFloat(ts);
  if (!Number.isFinite(n)) return Date.now();
  return Math.round(n * 1000);
}

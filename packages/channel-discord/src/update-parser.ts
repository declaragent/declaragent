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
  DiscordGuildMember,
  DiscordInteraction,
  DiscordMessage,
  DiscordUser,
} from './discord-api.js';

/**
 * Everything the adapter extracts from a single Discord Gateway /
 * webhook event to emit onto the bus + stash into the session-channel
 * context store.
 */
export interface ParsedUpdate {
  event: AgentEvent;
  conversation: ConversationRef;
  principal: ChannelPrincipal;
  lastInboundMessageRef: MessageRef;
  sessionId: string;
  summary: string;
  /**
   * Populated when the event originated from a Discord interaction
   * (button click or slash command). The adapter uses this to fire the
   * mandatory 3-second ack and, later, to dispatch follow-up replies via
   * `interactions/{token}/messages`.
   */
  interaction?: {
    interactionId: string;
    interactionToken: string;
    kind: 'button' | 'slash-command';
  };
}

export type DiscordInboundEvent =
  | { kind: 'MESSAGE_CREATE'; data: DiscordMessage }
  | { kind: 'INTERACTION_CREATE'; data: DiscordInteraction };

export interface ParseOptions {
  channelId: string;
  /** Correlate inbound events into the same trace. */
  correlationId?: string;
  /**
   * The bot's own user id (from `GET /users/@me`). Used to detect
   * `@mention` in MESSAGE_CREATE and classify as `chat.mention`.
   */
  botUserId?: string;
}

/**
 * Convert a Discord Gateway / webhook inbound into a normalized
 * `AgentEvent` + context bundle. Returns `null` for events we don't
 * handle (PING, autocompletes, modal submits in v0.9).
 */
export function parseDiscordEvent(
  event: DiscordInboundEvent,
  options: ParseOptions,
): ParsedUpdate | null {
  switch (event.kind) {
    case 'MESSAGE_CREATE':
      return parseMessage(event.data, options);
    case 'INTERACTION_CREATE':
      return parseInteraction(event.data, options);
  }
}

function parseMessage(msg: DiscordMessage, options: ParseOptions): ParsedUpdate | null {
  if (msg.author.bot === true) return null; // bot-loop prevention

  const channelId = options.channelId;
  const isDM = msg.guild_id === undefined || msg.type === 1;
  const mentioned =
    options.botUserId !== undefined && (msg.mentions ?? []).some((u) => u.id === options.botUserId);

  const conversation: ConversationRef = {
    channelId,
    conversationId: msg.channel_id,
    ...(msg.guild_id !== undefined && {
      platformMeta: { guildId: msg.guild_id },
    }),
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipal(channelId, msg.author, msg.member);
  const lastInboundMessageRef: MessageRef = {
    conversation,
    id: msg.id,
  };
  const source: EventSourceTag = {
    type: 'discord',
    channelId,
    ...(msg.guild_id !== undefined && { guildId: msg.guild_id }),
    channelDiscordId: msg.channel_id,
    messageId: msg.id,
  };

  const kind: EventKind = isDM ? 'chat.dm' : mentioned ? 'chat.mention' : 'chat.message';

  const payload: Record<string, unknown> = {
    text: msg.content,
    raw: msg,
    author: msg.author,
    ...(msg.guild_id !== undefined && { guildId: msg.guild_id }),
    channelDiscordId: msg.channel_id,
  };
  if (msg.attachments && msg.attachments.length > 0) {
    payload.attachments = msg.attachments;
  }

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind,
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: parseTimestamp(msg.timestamp),
    payload,
    auth: { kind: 'internal' },
    meta: {
      principal,
      ...(options.correlationId !== undefined && { correlationId: options.correlationId }),
    },
  };

  return {
    event,
    conversation,
    principal,
    lastInboundMessageRef,
    sessionId,
    summary: `message from ${principal.displayName ?? principal.platformUserId} in channel ${msg.channel_id}`,
  };
}

function parseInteraction(
  interaction: DiscordInteraction,
  options: ParseOptions,
): ParsedUpdate | null {
  // Type 2 = APPLICATION_COMMAND (slash), 3 = MESSAGE_COMPONENT (button).
  if (interaction.type !== 2 && interaction.type !== 3) return null;

  const channelId = options.channelId;
  const channelDiscordId = interaction.channel_id ?? interaction.channel?.id ?? '';
  if (!channelDiscordId) return null;

  const user = interaction.user ?? interaction.member?.user;
  if (!user) return null;

  const conversation: ConversationRef = {
    channelId,
    conversationId: channelDiscordId,
    ...(interaction.guild_id !== undefined && {
      platformMeta: { guildId: interaction.guild_id },
    }),
  };
  const sessionId = conversationSessionId(conversation);
  const principal = buildPrincipal(channelId, user, interaction.member);
  const lastInboundMessageRef: MessageRef = {
    conversation,
    id: interaction.message?.id ?? interaction.id,
  };
  const source: EventSourceTag = {
    type: 'discord',
    channelId,
    ...(interaction.guild_id !== undefined && { guildId: interaction.guild_id }),
    channelDiscordId,
    messageId: interaction.message?.id ?? interaction.id,
  };

  const isSlash = interaction.type === 2;
  const kind: EventKind = isSlash ? 'channel.command' : 'channel.interaction';
  const interactionKind: 'button' | 'slash-command' = isSlash ? 'slash-command' : 'button';

  const payload: Record<string, unknown> = {
    interactionId: interaction.id,
    interactionToken: interaction.token,
  };
  if (isSlash) {
    payload.command = interaction.data?.name ?? '';
    if (interaction.data?.options) payload.options = interaction.data.options;
  } else {
    payload.interaction = 'button';
    payload.buttonId = interaction.data?.custom_id ?? '';
    if (interaction.message) payload.originalMessage = interaction.message;
  }

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind,
    source,
    target: { type: 'session', sessionId, mode: 'inject' },
    timestamp: Date.now(),
    payload,
    auth: { kind: 'internal' },
    meta: {
      principal,
      ...(options.correlationId !== undefined && { correlationId: options.correlationId }),
    },
  };

  return {
    event,
    conversation,
    principal,
    lastInboundMessageRef,
    sessionId,
    summary: isSlash
      ? `slash command /${interaction.data?.name ?? '?'} from ${principal.displayName ?? principal.platformUserId}`
      : `button "${interaction.data?.custom_id ?? ''}" pressed by ${principal.displayName ?? principal.platformUserId}`,
    interaction: {
      interactionId: interaction.id,
      interactionToken: interaction.token,
      kind: interactionKind,
    },
  };
}

function buildPrincipal(
  channelId: string,
  user: DiscordUser,
  member?: DiscordGuildMember,
): ChannelPrincipal {
  const principal: ChannelPrincipal = {
    channelId,
    platformUserId: user.id,
    scopes: member?.roles ? [...member.roles] : [],
    verified: false,
  };
  const display = member?.nick ?? user.global_name ?? user.username;
  if (display) principal.displayName = display;
  return principal;
}

function parseTimestamp(iso: string | undefined): number {
  if (!iso) return Date.now();
  const n = Date.parse(iso);
  return Number.isNaN(n) ? Date.now() : n;
}

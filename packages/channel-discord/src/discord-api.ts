/**
 * Narrow, hand-written type shapes for the subset of the Discord API
 * this adapter consumes. The full API is sprawling; we only model the
 * fields we read or produce so upgrades to newer API versions surface
 * as explicit type additions rather than churn elsewhere.
 *
 * Reference: https://discord.com/developers/docs/reference.
 */

// ── Users / members ────────────────────────────────────────────────────────

export interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
  /** True when the author is a bot (used for loop prevention). */
  bot?: boolean;
  avatar?: string | null;
}

export interface DiscordGuildMember {
  user?: DiscordUser;
  nick?: string | null;
  roles?: string[];
  joined_at?: string;
}

// ── Channels ───────────────────────────────────────────────────────────────

/**
 * Discord channel types. See
 * https://discord.com/developers/docs/resources/channel#channel-object-channel-types.
 * Only the values this adapter branches on are enumerated; unknown types
 * pass through as `number`.
 */
export type DiscordChannelType =
  | 0 // GUILD_TEXT
  | 1 // DM
  | 3 // GROUP_DM
  | 5 // GUILD_ANNOUNCEMENT
  | 10 // ANNOUNCEMENT_THREAD
  | 11 // PUBLIC_THREAD
  | 12 // PRIVATE_THREAD
  | 13 // GUILD_STAGE_VOICE
  | 15; // GUILD_FORUM

export interface DiscordThreadMetadata {
  archived: boolean;
  auto_archive_duration?: number;
  archive_timestamp?: string;
  locked?: boolean;
  invitable?: boolean;
}

export interface DiscordChannel {
  id: string;
  type: DiscordChannelType | number;
  guild_id?: string;
  name?: string | null;
  parent_id?: string | null;
  thread_metadata?: DiscordThreadMetadata;
}

// ── Messages ───────────────────────────────────────────────────────────────

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url?: string;
  content_type?: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedObject {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  image?: { url: string };
  fields?: DiscordEmbedField[];
}

export interface DiscordComponentButton {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id?: string;
  url?: string;
}

export interface DiscordActionRowComponent {
  type: 1;
  components: DiscordComponentButton[];
}

export interface DiscordMessageReference {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
  fail_if_not_exists?: boolean;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  member?: DiscordGuildMember;
  content: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  edited_timestamp?: string | null;
  mentions?: DiscordUser[];
  mention_everyone?: boolean;
  mention_roles?: string[];
  attachments?: DiscordAttachment[];
  embeds?: DiscordEmbedObject[];
  components?: DiscordActionRowComponent[];
  referenced_message?: DiscordMessage | null;
  /** DMs set type === 1. */
  type?: number;
  /** For thread messages. */
  thread?: DiscordChannel;
}

// ── Interactions ───────────────────────────────────────────────────────────

/** https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object-interaction-type */
export type DiscordInteractionType =
  | 1 // PING
  | 2 // APPLICATION_COMMAND (slash command)
  | 3 // MESSAGE_COMPONENT (button / select)
  | 4 // APPLICATION_COMMAND_AUTOCOMPLETE
  | 5; // MODAL_SUBMIT

export interface DiscordInteractionDataOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordInteractionDataOption[];
}

export interface DiscordInteractionData {
  /** Slash command name (type 2). */
  name?: string;
  /** Button custom_id (type 3). */
  custom_id?: string;
  component_type?: number;
  options?: DiscordInteractionDataOption[];
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: DiscordInteractionType;
  data?: DiscordInteractionData;
  guild_id?: string;
  channel_id?: string;
  channel?: DiscordChannel;
  member?: DiscordGuildMember;
  user?: DiscordUser;
  token: string;
  version: number;
  message?: DiscordMessage;
}

// ── Interaction responses ─────────────────────────────────────────────────

/** https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object-interaction-callback-type */
export type DiscordInteractionResponseType =
  | 1 // PONG
  | 4 // CHANNEL_MESSAGE_WITH_SOURCE
  | 5 // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  | 6 // DEFERRED_UPDATE_MESSAGE
  | 7; // UPDATE_MESSAGE

export interface DiscordInteractionResponse {
  type: DiscordInteractionResponseType;
  data?: {
    content?: string;
    embeds?: DiscordEmbedObject[];
    components?: DiscordActionRowComponent[];
    flags?: number;
  };
}

// ── Gateway ────────────────────────────────────────────────────────────────

/**
 * Gateway opcodes we care about.
 * https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-opcodes
 */
export enum GatewayOpcode {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  Resume = 6,
  Reconnect = 7,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatAck = 11,
}

export interface DiscordGatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export interface DiscordHelloData {
  heartbeat_interval: number;
}

export interface DiscordReadyData {
  v: number;
  user: DiscordUser;
  session_id: string;
  resume_gateway_url?: string;
  application?: { id: string; flags?: number };
}

/** GET /gateway/bot — response shape. */
export interface DiscordGatewayBotInfo {
  url: string;
  shards: number;
  session_start_limit: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}

// ── Slash command registration ────────────────────────────────────────────

export interface DiscordApplicationCommand {
  name: string;
  description: string;
  /**
   * Command type 1 = CHAT_INPUT (slash). Other values (user/message
   * context menu) are allowed by the API but unused by this adapter.
   */
  type?: 1 | 2 | 3;
  options?: DiscordInteractionDataOption[];
}

// ── Reactions / typing / file uploads ─────────────────────────────────────

/**
 * Emoji format used by the reactions endpoint:
 * https://discord.com/developers/docs/resources/channel#create-reaction.
 * For unicode emoji pass the raw character; for custom emoji pass
 * `name:id`. Either way the adapter URL-encodes the value.
 */
export type DiscordEmojiIdentifier = string;

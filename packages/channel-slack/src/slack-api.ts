/**
 * Narrow, hand-written type shapes for the subset of the Slack Web API /
 * Events API we consume. The full Slack surface is enormous; we only
 * model the fields this adapter reads or produces so that future changes
 * to other Slack features surface as explicit additions rather than churn
 * elsewhere.
 *
 * References:
 * - https://api.slack.com/events
 * - https://api.slack.com/web
 * - https://api.slack.com/apis/socket-mode
 */

import type { SlackBlock } from '@declaragent/core';

// ── Core entities ─────────────────────────────────────────────────────────

export interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
}

export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}

// ── Events ────────────────────────────────────────────────────────────────

/**
 * `message` event — the workhorse. `subtype` distinguishes bot messages,
 * edits, deletes, etc. We key most filtering on `bot_id` + `subtype`.
 *
 * `channel_type` is present on `message.*` events and tells us if this is
 * a DM (`im`), multi-party DM (`mpim`), private channel (`group`), or
 * public channel (`channel`).
 */
export interface SlackMessageEvent {
  type: 'message';
  subtype?: string;
  channel: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  /** Set when this message was posted by a bot. Used for loop-prevention. */
  bot_id?: string;
  /** On a channel in a shared workspace. */
  team?: string;
  blocks?: unknown[];
  attachments?: unknown[];
  files?: Array<{
    id: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private?: string;
    url_private_download?: string;
  }>;
  edited?: { ts: string; user: string };
}

export interface SlackAppMentionEvent {
  type: 'app_mention';
  user?: string;
  text?: string;
  ts: string;
  channel: string;
  thread_ts?: string;
  team?: string;
  blocks?: unknown[];
}

export interface SlackReactionEvent {
  type: 'reaction_added' | 'reaction_removed';
  user: string;
  reaction: string;
  item_user?: string;
  item: {
    type: 'message';
    channel: string;
    ts: string;
  };
  event_ts: string;
}

// ── Interactivity payloads ───────────────────────────────────────────────

export interface SlackBlockActionsPayload {
  type: 'block_actions';
  user: { id: string; username?: string; name?: string; team_id?: string };
  team?: { id: string; domain?: string };
  channel?: { id: string; name?: string };
  container?: {
    type: string;
    message_ts?: string;
    channel_id?: string;
    thread_ts?: string;
  };
  trigger_id: string;
  response_url?: string;
  actions: Array<{
    action_id: string;
    block_id?: string;
    type: string;
    value?: string;
    selected_option?: { value: string };
    text?: { type: string; text: string };
  }>;
  message?: {
    ts: string;
    text?: string;
    user?: string;
    thread_ts?: string;
  };
}

/**
 * Slash commands arrive as `application/x-www-form-urlencoded` POSTs in
 * Events API mode, and as a `slash_commands` envelope in Socket Mode. The
 * fields are identical; `parseSlackEvent` normalizes both.
 */
export interface SlackSlashCommandPayload {
  token?: string;
  team_id?: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  command: string;
  text: string;
  response_url?: string;
  trigger_id?: string;
  api_app_id?: string;
}

// ── Events API envelope ──────────────────────────────────────────────────

export type SlackEventInner =
  | SlackMessageEvent
  | SlackAppMentionEvent
  | SlackReactionEvent
  | { type: string; [k: string]: unknown };

/**
 * Outer envelope delivered to an Events API webhook endpoint. Same shape
 * is re-used inside a Socket Mode `events_api` frame.
 *
 * `type: 'url_verification'` is the handshake Slack sends once when you
 * register the Events URL; we echo back `challenge`.
 */
export type SlackEventWrapper =
  | {
      type: 'url_verification';
      token: string;
      challenge: string;
    }
  | {
      type: 'event_callback';
      token?: string;
      team_id?: string;
      api_app_id?: string;
      event: SlackEventInner;
      event_id?: string;
      event_time?: number;
      authorizations?: Array<{ team_id?: string; user_id?: string; is_bot?: boolean }>;
    };

// ── Web API response envelopes ───────────────────────────────────────────

export interface SlackAuthTestResponse {
  ok: boolean;
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
  bot_id?: string;
  /**
   * Slack returns granted scopes either in the `X-OAuth-Scopes` response
   * header or — for recently-issued tokens — in this field when requested
   * via `auth.test.scopes`. Adapter inspects both.
   */
  response_metadata?: { scopes?: string[]; acceptedScopes?: string[] };
}

export interface SlackPostMessageResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
  message?: {
    ts: string;
    text?: string;
    user?: string;
    thread_ts?: string;
    blocks?: SlackBlock[];
  };
  error?: string;
  warning?: string;
  response_metadata?: { warnings?: string[] };
}

export interface SlackAppsConnectionsOpenResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

export interface SlackFilesUploadV2Response {
  ok: boolean;
  files?: Array<{
    id: string;
    title?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    permalink?: string;
  }>;
  error?: string;
}

export interface SlackConversationsRepliesResponse {
  ok: boolean;
  messages?: SlackMessageEvent[];
  has_more?: boolean;
  error?: string;
}

// ── Socket Mode frames ───────────────────────────────────────────────────

/**
 * Socket Mode wraps every inbound event/command/interaction in an
 * acknowledgement envelope. The client must respond with the matching
 * `envelope_id` or Slack considers the event unacked and resends.
 */
export interface SlackSocketFrame {
  type: 'hello' | 'events_api' | 'interactive' | 'slash_commands' | 'disconnect';
  envelope_id?: string;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
  payload?:
    | SlackEventWrapper
    | SlackBlockActionsPayload
    | SlackSlashCommandPayload
    | Record<string, unknown>;
  /** `hello` frame debug info. */
  num_connections?: number;
  /** `disconnect` reason. */
  reason?: string;
}

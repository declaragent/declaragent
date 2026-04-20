import type {
  BaseChannelOutboundConfig,
  DeliveryConfig,
  LimitsConfig,
  RoutingConfig,
} from '@declaragent/core';

/** Transport selection — Socket Mode (WSS) or Events API (HTTP webhook). */
export type SlackTransportMode = 'socket' | 'events';

export interface SlackTransportConfig {
  mode: SlackTransportMode;
  /** Bot user OAuth token (xoxb-...). Always required for Web API calls. */
  botToken: string;
  /**
   * App-level token (xapp-...) — required in `socket` mode to open a WSS
   * via `apps.connections.open`. Ignored in `events` mode.
   */
  appToken?: string;
  /**
   * Signing secret (`Basic Information → App-Level Tokens → Signing Secret`).
   * Required in `events` mode so the adapter can HMAC-verify every
   * inbound POST. Ignored in `socket` mode (Slack signs WSS frames
   * implicitly via the single-use URL).
   */
  signingSecret?: string;
  /** Base URL override — mostly useful for tests + on-prem proxies. */
  baseUrl?: string;
}

/**
 * When should the adapter reply in-thread vs. as a top-level channel
 * message? Slack's norm is thread-reply-by-default once a conversation
 * starts; the `auto` policy matches that (threads when the inbound event
 * is itself threaded or is an `app_mention` in a busy channel).
 */
export type ThreadOnMentionPolicy = 'always' | 'never' | 'auto';

export interface SlackChannelConfig {
  id: string;
  transport: SlackTransportConfig;
  /**
   * Threading policy for `app_mention` replies. Default: `auto`.
   * - `always`: reply in-thread every time the bot is @mentioned.
   * - `never`: reply at the top level even when mentioned.
   * - `auto`: reply in-thread if the mention already has `thread_ts`;
   *   otherwise start a new thread on the mention message.
   */
  threadOnMention?: ThreadOnMentionPolicy;
  /**
   * Slack event type filter — populates the app manifest you paste into
   * `api.slack.com/apps/<id>/event-subscriptions`. Not enforced at runtime
   * (Slack controls which events it sends); purely informational for the
   * CLI's config validator.
   *
   * Default: `['message.channels', 'message.im', 'app_mention', 'reaction_added']`.
   */
  events?: readonly string[];
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
  outbound?: BaseChannelOutboundConfig;
  idempotency?: { ttlMs?: number; maxEntries?: number };
}

/** Default event filter (used by config validator + manifest hint). */
export const DEFAULT_SLACK_EVENTS: readonly string[] = [
  'message.channels',
  'message.im',
  'app_mention',
  'reaction_added',
];

export function assertSlackConfig(cfg: unknown): asserts cfg is SlackChannelConfig {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('slack config must be an object');
  }
  const c = cfg as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('slack.id must be a non-empty string');
  }
  const t = c.transport as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') {
    throw new Error(`slack[${c.id}].transport is required`);
  }
  if (t.mode !== 'socket' && t.mode !== 'events') {
    throw new Error(`slack[${c.id}].transport.mode must be "socket" or "events"`);
  }
  if (typeof t.botToken !== 'string' || t.botToken.length === 0) {
    throw new Error(`slack[${c.id}].transport.botToken is required`);
  }
  if (t.mode === 'socket') {
    if (typeof t.appToken !== 'string' || t.appToken.length === 0) {
      throw new Error(`slack[${c.id}].transport.appToken is required in socket mode`);
    }
  }
  if (t.mode === 'events') {
    if (typeof t.signingSecret !== 'string' || t.signingSecret.length === 0) {
      throw new Error(`slack[${c.id}].transport.signingSecret is required in events mode`);
    }
  }
  if (c.threadOnMention !== undefined) {
    if (
      c.threadOnMention !== 'always' &&
      c.threadOnMention !== 'never' &&
      c.threadOnMention !== 'auto'
    ) {
      throw new Error(
        `slack[${c.id}].threadOnMention must be "always" | "never" | "auto" when set`,
      );
    }
  }
  if (!c.routing) throw new Error(`slack[${c.id}].routing is required`);
  if (!c.delivery) throw new Error(`slack[${c.id}].delivery is required`);
  if (!c.limits) throw new Error(`slack[${c.id}].limits is required`);
}

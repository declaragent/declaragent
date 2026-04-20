import type { ConversationRef } from './types.js';

/**
 * Deterministic session-id derivation from a `ConversationRef`. Used by
 * the routing layer's `${channel:conversationSessionId}` pseudo-variable
 * (slice 3) and by `ChannelOutboundBridge` (slice 2) to look up the
 * session that spawned from a given conversation.
 *
 * Shape: `chat:<channelId>:<conversationId>:<threadId | 'main'>`
 *
 * The separator `:` is escaped in each component to preserve parseability
 * (some platforms allow `:` in user/chat ids — Slack thread_ts, for
 * instance, is a dotted ts string; Telegram chat ids are signed ints).
 */
const SESSION_ID_PREFIX = 'chat';
const THREAD_PLACEHOLDER = 'main';

/**
 * Strategy selector. Channel configs pick one; default is `per-conversation`.
 *
 * - `per-conversation` — one session per (channel, conversationId, threadId).
 * - `per-user`         — one session per (channel, platformUserId) regardless of conversation.
 * - `ephemeral`        — a fresh session per message (the caller supplies a unique suffix).
 */
export type SessionStrategy = 'per-conversation' | 'per-user' | 'ephemeral';

export function conversationSessionId(ref: ConversationRef): string {
  return [
    SESSION_ID_PREFIX,
    escapeComponent(ref.channelId),
    escapeComponent(ref.conversationId),
    escapeComponent(ref.threadId ?? THREAD_PLACEHOLDER),
  ].join(':');
}

/**
 * Variant for the `per-user` strategy. `platformUserId` must be supplied
 * by the caller — channel adapters read it from the inbound message.
 */
export function userSessionId(channelId: string, platformUserId: string): string {
  return ['chat-user', escapeComponent(channelId), escapeComponent(platformUserId)].join(':');
}

/**
 * Variant for the `ephemeral` strategy. The caller supplies a unique
 * suffix (typically the inbound message id or a UUID); the returned id
 * is guaranteed to differ across calls so no session reuse occurs.
 */
export function ephemeralSessionId(ref: ConversationRef, uniqueSuffix: string): string {
  return [conversationSessionId(ref), escapeComponent(uniqueSuffix)].join(':');
}

/**
 * Minimal escaper: backslash-escapes `:` and `\` in a component so the
 * session id remains round-trippable even when a platform id contains a
 * colon. Not URL-encoding — the session id is not routed through URLs.
 */
function escapeComponent(component: string): string {
  return component.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
}

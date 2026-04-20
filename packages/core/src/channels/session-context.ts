import type { ChannelPrincipal, ConversationRef, MessageRef } from './types.js';

/**
 * Runtime channel metadata associated with a session. Populated when a
 * session is spawned (or first bound) from a channel event; read by the
 * `ChannelOutboundBridge` so assistant replies route back to the
 * originating conversation.
 */
export interface SessionChannelContext {
  channelOrigin: ConversationRef;
  channelPrincipal?: ChannelPrincipal;
  /**
   * Last inbound message ref on this session. Adapters that support
   * `replyTo:` can use it as the parent so bot replies thread properly.
   */
  lastInboundMessageRef?: MessageRef;
}

/**
 * Passive lookup surface. Not keyed on an AgentEvent — keyed on the
 * session's own id so lookups work for proactive outbound too (a skill
 * kicks off by timer; its `runAgent` result goes through the same bridge).
 *
 * The daemon (slice 3) is responsible for writing; the bridge (this
 * slice) is responsible for reading; extensions may also consume via
 * their `ExtensionContext.sessionChannel` in later slices.
 */
export interface SessionChannelContextStore {
  set(sessionId: string, context: SessionChannelContext): void;
  get(sessionId: string): SessionChannelContext | undefined;
  clear(sessionId: string): void;
  /** Snapshot for tests + `/status` output. */
  list(): readonly { sessionId: string; context: SessionChannelContext }[];
}

/**
 * In-memory implementation. Channel-context state is small (at most one
 * entry per active session) so an LRU cap is not needed; sessions clean
 * up their own context on close via the daemon's session lifecycle hook.
 */
export function createSessionChannelContextStore(): SessionChannelContextStore {
  const contexts = new Map<string, SessionChannelContext>();
  return {
    set(sessionId, context) {
      contexts.set(sessionId, context);
    },
    get(sessionId) {
      return contexts.get(sessionId);
    },
    clear(sessionId) {
      contexts.delete(sessionId);
    },
    list() {
      return Array.from(contexts.entries()).map(([sessionId, context]) => ({
        sessionId,
        context,
      }));
    },
  };
}

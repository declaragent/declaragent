import type {
  AssistantFinalPayload,
  AssistantMessagePayload,
  TurnStartedPayload,
} from '../engine/engine.js';
import type { AgentEvent, EventBus } from '../events/types.js';
import type { Logger } from '../types/logger.js';
import type { MessageContent as LLMContent, Message } from '../types/messages.js';
import type { SessionChannelContextStore } from './session-context.js';
import type {
  ChannelInstance,
  ChannelRegistry,
  ConversationRef,
  MessageContent,
  MessageRef,
  SentMessage,
} from './types.js';

/**
 * Payload shape consumed from bus events of kind `channel.send.request`.
 * Slice 11's `SendMessage` tool extension emits these; any caller that
 * wants to post out-of-band goes through the same surface. The bridge
 * supplies a default idempotency key when the payload omits one.
 */
export interface ChannelSendRequestPayload {
  conversation: ConversationRef;
  content: MessageContent;
  idempotencyKey?: string;
  replyTo?: MessageRef;
}

export interface ChannelOutboundBridgeDeps {
  bus: EventBus;
  channels: ChannelRegistry;
  sessionChannelContext: SessionChannelContextStore;
  logger: Logger;
  /**
   * Slice 13. When true, the bridge subscribes to `turn.started` and
   * calls `channel.setTyping(...)` on channels that declare
   * `supportsTypingIndicator`. Defaults to false so the slice-2 contract
   * stays unchanged.
   */
  typingEnabled?: boolean;
  /**
   * Slice 13. When true, `assistant.message` events drive
   * send-then-edit behavior for channels that declare
   * `supportsEditMessage`. The final `assistant.final` event for a
   * streamed turn is a no-op (the stream already delivered). Channels
   * without edit support silently fall back to buffered mode — the
   * bridge emits a single send per `assistant.final` and ignores
   * `assistant.message`. Defaults to false.
   */
  streaming?: boolean;
}

export interface ChannelOutboundBridge {
  /** Attach subscribers; returns a detach fn. Idempotent. */
  start(): () => void;
  /** Directly route an assistant message (used by tests + streaming). */
  forwardAssistantFinal(payload: AssistantFinalPayload): Promise<SentMessage | null>;
  /** Directly route an explicit send (used by tests + `SendMessage` tool). */
  forwardSendRequest(
    payload: ChannelSendRequestPayload,
    idempotencyKeyFallback: string,
  ): Promise<SentMessage | null>;
}

/**
 * Per-session/turn streaming state. Captured the first time an
 * `assistant.message` event lands for a given `(sessionId, turnId)` so
 * subsequent deltas can call `channel.edit(ref, ...)` instead of
 * `channel.send(...)`. Cleared when the matching `assistant.final`
 * lands (or when a new turn starts for the same session).
 */
interface StreamState {
  turnId: string;
  /** Message ref of the first send this turn, used for subsequent edits. */
  messageRef?: MessageRef;
  /**
   * True once the first `assistant.message` has arrived for this turn.
   * Signals that `assistant.final` should be a no-op and that typing
   * re-renewal should cease.
   */
  streamed: boolean;
}

/**
 * Subscribes to `assistant.final` + `channel.send.request` on the event
 * bus, looks up the originating channel + conversation, and calls
 * `ChannelInstance.send()` with a deterministic idempotency key so
 * retries never double-post.
 *
 * Slice-13 additions (all opt-in, off by default — slice-2 callers see
 * no behavior change):
 *
 *   - `typingEnabled`: subscribe to `turn.started`, call `setTyping`
 *     on capable channels. Typing re-renewal is the adapter's job
 *     (Telegram refreshes every 4s, Discord every 8s); the bridge just
 *     issues the initial nudge.
 *   - `streaming`: subscribe to `assistant.message`. First delta for a
 *     turn → `send`; subsequent deltas → `edit` against the captured
 *     ref. Channels without `supportsEditMessage` silently stay in
 *     buffered mode (one `send` per `assistant.final`).
 */
export function createChannelOutboundBridge(
  deps: ChannelOutboundBridgeDeps,
): ChannelOutboundBridge {
  const { bus, channels, sessionChannelContext, logger } = deps;
  const typingEnabled = deps.typingEnabled ?? false;
  const streamingEnabled = deps.streaming ?? false;

  // Active per-session stream state. In streaming mode an `assistant.final`
  // after a streamed turn should be a no-op; the state survives until
  // `assistant.final` lands (or a new `turn.started` supersedes it).
  const streams = new Map<string, StreamState>();

  async function forwardAssistantFinal(
    payload: AssistantFinalPayload,
  ): Promise<SentMessage | null> {
    const ctx = sessionChannelContext.get(payload.sessionId);
    if (!ctx) return null; // session is not bound to a channel

    const channel = channels.get(ctx.channelOrigin.channelId);
    if (!channel) {
      logger.warn('channels.outbound.unregistered', {
        sessionId: payload.sessionId,
        channelId: ctx.channelOrigin.channelId,
      });
      return null;
    }

    // Streaming short-circuit: if the stream already delivered this turn
    // via `assistant.message`, the `assistant.final` carries no net-new
    // content to send. Clear the state slot and bail.
    const existing = streams.get(payload.sessionId);
    if (streamingEnabled && existing?.turnId === payload.turnId && existing.streamed) {
      streams.delete(payload.sessionId);
      return null;
    }

    const content = extractAssistantContent(payload.content);
    if (!content) {
      logger.debug('channels.outbound.empty', { sessionId: payload.sessionId });
      // Still clear any stream slot for this turn to avoid leaks.
      if (existing?.turnId === payload.turnId) streams.delete(payload.sessionId);
      return null;
    }

    const sent = await sendWithLogging(channel, {
      conversation: ctx.channelOrigin,
      content,
      idempotencyKey: `session:${payload.sessionId}:${payload.turnId}`,
      ...(ctx.lastInboundMessageRef !== undefined && {
        replyTo: ctx.lastInboundMessageRef,
      }),
    });
    // Final landed (buffered path): clear any lingering stream state.
    if (existing?.turnId === payload.turnId) streams.delete(payload.sessionId);
    return sent;
  }

  async function forwardAssistantMessage(payload: AssistantMessagePayload): Promise<void> {
    if (!streamingEnabled) return;
    if (payload.delta.length === 0) return;

    const ctx = sessionChannelContext.get(payload.sessionId);
    if (!ctx) return;

    const channel = channels.get(ctx.channelOrigin.channelId);
    if (!channel) {
      logger.warn('channels.outbound.unregistered', {
        sessionId: payload.sessionId,
        channelId: ctx.channelOrigin.channelId,
      });
      return;
    }

    // If the channel can't edit, there's nothing to stream with —
    // stay in buffered mode and let `assistant.final` drive the lone send.
    if (!channel.capabilities.supportsEditMessage || channel.edit === undefined) {
      return;
    }

    const content: MessageContent = { kind: 'text', text: payload.delta, format: 'markdown' };

    let state = streams.get(payload.sessionId);
    // If the state is stale (prior turn), start fresh.
    if (state && state.turnId !== payload.turnId) {
      streams.delete(payload.sessionId);
      state = undefined;
    }

    if (!state || state.messageRef === undefined) {
      // First delta for this turn — send a fresh message and capture ref.
      const sent = await sendWithLogging(channel, {
        conversation: ctx.channelOrigin,
        content,
        idempotencyKey: `session:${payload.sessionId}:${payload.turnId}:stream`,
        ...(ctx.lastInboundMessageRef !== undefined && {
          replyTo: ctx.lastInboundMessageRef,
        }),
      });
      if (!sent) return;
      const next: StreamState = {
        turnId: payload.turnId,
        messageRef: { conversation: sent.conversation, id: sent.id },
        streamed: true,
      };
      streams.set(payload.sessionId, next);
      return;
    }

    // Subsequent delta — edit the existing message in place.
    try {
      await channel.edit(state.messageRef, content);
      state.streamed = true;
    } catch (err) {
      logger.warn('channels.outbound.edit.failed', {
        channelId: channel.id,
        conversationId: state.messageRef.conversation.conversationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function forwardTurnStarted(payload: TurnStartedPayload): Promise<void> {
    if (!typingEnabled) return;

    // Drop any stale stream state for this session — a new turn is
    // starting, and `assistant.final` for the previous turn should have
    // already cleaned up. This is defensive.
    const prior = streams.get(payload.sessionId);
    if (prior && prior.turnId !== payload.turnId) {
      streams.delete(payload.sessionId);
    }

    const ctx = sessionChannelContext.get(payload.sessionId);
    if (!ctx) return;

    const channel = channels.get(ctx.channelOrigin.channelId);
    if (!channel) return;

    if (!channel.capabilities.supportsTypingIndicator || channel.setTyping === undefined) {
      return;
    }

    try {
      await channel.setTyping(ctx.channelOrigin);
    } catch (err) {
      logger.warn('channels.outbound.typing.failed', {
        channelId: channel.id,
        conversationId: ctx.channelOrigin.conversationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function forwardSendRequest(
    payload: ChannelSendRequestPayload,
    idempotencyKeyFallback: string,
  ): Promise<SentMessage | null> {
    const channel = channels.get(payload.conversation.channelId);
    if (!channel) {
      logger.warn('channels.outbound.unregistered', {
        channelId: payload.conversation.channelId,
      });
      return null;
    }
    return sendWithLogging(channel, {
      conversation: payload.conversation,
      content: payload.content,
      idempotencyKey: payload.idempotencyKey ?? idempotencyKeyFallback,
      ...(payload.replyTo !== undefined && { replyTo: payload.replyTo }),
    });
  }

  async function sendWithLogging(
    channel: ChannelInstance,
    params: Parameters<ChannelInstance['send']>[0],
  ): Promise<SentMessage | null> {
    try {
      return await channel.send(params);
    } catch (err) {
      logger.warn('channels.outbound.failed', {
        channelId: channel.id,
        conversationId: params.conversation.conversationId,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  function start(): () => void {
    const offFinal = bus.subscribe('assistant.final', async (event) => {
      try {
        await forwardAssistantFinal(event.payload as AssistantFinalPayload);
      } catch (err) {
        logger.error('channels.outbound.assistant_final.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    const offRequest = bus.subscribe('channel.send.request', async (event) => {
      try {
        await forwardSendRequest(event.payload as ChannelSendRequestPayload, `event:${event.id}`);
      } catch (err) {
        logger.error('channels.outbound.send_request.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Slice-13 subscriptions. Registered unconditionally so opt-in flags
    // can be flipped without re-attaching; the handlers themselves
    // bail early when their feature flag is off.
    const offStarted = bus.subscribe('turn.started', async (event) => {
      try {
        await forwardTurnStarted(event.payload as TurnStartedPayload);
      } catch (err) {
        logger.error('channels.outbound.turn_started.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    const offMessage = bus.subscribe('assistant.message', async (event) => {
      try {
        await forwardAssistantMessage(event.payload as AssistantMessagePayload);
      } catch (err) {
        logger.error('channels.outbound.assistant_message.error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return () => {
      offFinal();
      offRequest();
      offStarted();
      offMessage();
    };
  }

  return { start, forwardAssistantFinal, forwardSendRequest };
}

/**
 * Extract the channel-sendable content from an engine assistant message.
 * Slice 2 ships a text-only path: every `text` block concatenated with a
 * single newline. Slice 4 replaces this with rich-block rendering; tool
 * calls + tool results never become outbound content.
 */
export function extractAssistantContent(content: Message['content']): MessageContent | null {
  const pieces: string[] = [];
  for (const block of content) {
    if (isTextBlock(block) && block.text.length > 0) {
      pieces.push(block.text);
    }
  }
  if (pieces.length === 0) return null;
  return { kind: 'text', text: pieces.join('\n'), format: 'markdown' };
}

function isTextBlock(content: LLMContent): content is Extract<LLMContent, { type: 'text' }> {
  return content.type === 'text';
}

// `AgentEvent` is referenced only in type-level contexts of this module.
// Silence the unused-import diagnostic without enabling escape hatches.
export type { AgentEvent };

/**
 * Inbound channel bridge (Slice 6 / PR 6.1).
 *
 * Channel adapters (Slack, Telegram, Discord, WhatsApp) publish inbound
 * events onto the shared bus with `target: { type: 'session', … }` —
 * designed for human-driven conversations where a session already
 * exists. That path does not fit a mention-bot pattern: when someone
 * `@bot`s in a Slack channel, no declaragent session is live yet, so
 * the session-target dispatch rejects with `no-handler`.
 *
 * This bridge closes the gap declaratively. Operators add routes to
 * `channels.json` per channel:
 *
 * ```json
 * {
 *   "channels": [
 *     {
 *       "id": "slack-main",
 *       "type": "slack",
 *       "config": { … },
 *       "inbound": {
 *         "routes": [
 *           { "event": "chat.mention", "skill": "triage" },
 *           { "event": "chat.dm",      "skill": "chat"    }
 *         ]
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * When an inbound event arrives whose `source.channelId` matches and
 * whose `kind` matches a route's `event`, the bridge publishes an
 * additional event with `target: { type: 'skill', name: route.skill }`
 * and `meta.causedBy` linking back to the original. The dispatcher
 * picks it up through its normal routing.
 *
 * Only events with `target.type === 'session'` are re-routed — keeps
 * bridged events from re-entering the bridge (they carry
 * `target.type === 'skill'` so the guard above filters them out).
 *
 * @since 0.6.0-slice.6
 */

import type { AgentEvent, EventBus } from '../events/types.js';
import type { Logger } from '../types/logger.js';

export interface InboundRoute {
  /** Match against `AgentEvent.kind`. Exact equality, no glob. */
  event: string;
  /** Skill `lookupName` to dispatch. */
  skill: string;
}

export interface ChannelInboundBridgeOptions {
  bus: EventBus;
  /**
   * Routes keyed by channel instance id (e.g. `"slack-main"`). Empty
   * or missing entries mean "no bridge wiring for this channel".
   */
  routesByChannel: Readonly<Record<string, readonly InboundRoute[]>>;
  logger?: Logger;
  /** Injected id generator — tests pin the UUID for deterministic assertions. */
  idFactory?: () => string;
}

export interface ChannelInboundBridge {
  /** Detach the bus subscription. Idempotent. */
  detach(): void;
  /**
   * For diagnostics / tests: number of skill-events the bridge has
   * emitted since construction.
   */
  readonly emitted: number;
}

export function createChannelInboundBridge(
  opts: ChannelInboundBridgeOptions,
): ChannelInboundBridge {
  const id = opts.idFactory ?? (() => crypto.randomUUID());
  let emitted = 0;

  const unsub = opts.bus.subscribe('*', async (event: AgentEvent) => {
    // Only re-route the channel's own session-targeted inbound events.
    // This is the guard that prevents re-entry: bridged events are
    // skill-targeted, so they fall through here without further action.
    if (event.target.type !== 'session') return;

    const channelId = extractChannelId(event);
    if (channelId === undefined) return;
    const routes = opts.routesByChannel[channelId];
    if (routes === undefined || routes.length === 0) return;

    for (const route of routes) {
      if (route.event !== event.kind) continue;
      const basePayload =
        event.payload !== null && typeof event.payload === 'object'
          ? (event.payload as Record<string, unknown>)
          : {};
      const skillEvent: AgentEvent = {
        id: id(),
        kind: event.kind,
        source: event.source,
        target: { type: 'skill', name: route.skill, inputs: basePayload },
        timestamp: event.timestamp,
        payload: event.payload,
        auth: event.auth,
        meta: {
          ...(event.meta ?? {}),
          causedBy: event.id,
        },
      };
      try {
        await opts.bus.publish(skillEvent);
        emitted += 1;
      } catch (err) {
        opts.logger?.warn('channel-inbound-bridge.publish-failed', {
          channelId,
          skill: route.skill,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  return {
    detach: unsub,
    get emitted() {
      return emitted;
    },
  };
}

/**
 * Extract the channel instance id from an event's source tag. Channel
 * adapters place the id on `source.channelId` (see every
 * `update-parser.ts`); anything that doesn't is not a channel event.
 */
function extractChannelId(event: AgentEvent): string | undefined {
  const src = event.source as { channelId?: unknown };
  return typeof src.channelId === 'string' ? src.channelId : undefined;
}

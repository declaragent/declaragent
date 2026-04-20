import type {
  BaseChannelOutboundConfig,
  DeliveryConfig,
  LimitsConfig,
  RoutingConfig,
} from '@declaragent/core';

/** Long-polling vs webhook selection. */
export type TelegramTransportMode = 'long-polling' | 'webhook';

export interface TelegramTransportConfig {
  mode: TelegramTransportMode;
  botToken: string;
  /** Required in webhook mode. */
  webhookUrl?: string;
  /**
   * Secret returned in the `X-Telegram-Bot-Api-Secret-Token` header on
   * every webhook POST. Required in webhook mode for signature checks.
   */
  webhookSecret?: string;
  /** Update types to receive. Empty / undefined → all. */
  allowedUpdates?: readonly string[];
  /** Long-polling only. Max updates per getUpdates call. Default 100. */
  pollLimit?: number;
  /** Long-polling only. Timeout in seconds passed to getUpdates. Default 50. */
  pollTimeoutSec?: number;
  /** Base URL override for on-prem Bot API server. */
  baseUrl?: string;
}

export interface TelegramChannelConfig {
  id: string;
  transport: TelegramTransportConfig;
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
  outbound?: BaseChannelOutboundConfig;
  idempotency?: { ttlMs?: number; maxEntries?: number };
  /**
   * When true, the adapter emits a startup warning if Telegram reports
   * the bot cannot read all group messages (privacy mode on). Most bots
   * that participate in group chats need privacy mode off. Default: true.
   */
  warnOnPrivacyMode?: boolean;
}

export function assertTelegramConfig(cfg: unknown): asserts cfg is TelegramChannelConfig {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('telegram config must be an object');
  }
  const c = cfg as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('telegram.id must be a non-empty string');
  }
  const t = c.transport as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') {
    throw new Error(`telegram[${c.id}].transport is required`);
  }
  if (t.mode !== 'long-polling' && t.mode !== 'webhook') {
    throw new Error(`telegram[${c.id}].transport.mode must be "long-polling" or "webhook"`);
  }
  if (typeof t.botToken !== 'string' || t.botToken.length === 0) {
    throw new Error(`telegram[${c.id}].transport.botToken is required`);
  }
  if (t.mode === 'webhook') {
    if (typeof t.webhookUrl !== 'string' || t.webhookUrl.length === 0) {
      throw new Error(`telegram[${c.id}].transport.webhookUrl is required in webhook mode`);
    }
    if (typeof t.webhookSecret !== 'string' || t.webhookSecret.length === 0) {
      throw new Error(`telegram[${c.id}].transport.webhookSecret is required in webhook mode`);
    }
  }
  if (!c.routing) throw new Error(`telegram[${c.id}].routing is required`);
  if (!c.delivery) throw new Error(`telegram[${c.id}].delivery is required`);
  if (!c.limits) throw new Error(`telegram[${c.id}].limits is required`);
}

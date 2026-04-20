import type { ChannelAdapter, ChannelDependencies, ChannelInstance } from '@declaragent/core';
import { TELEGRAM_CAPABILITIES } from './capabilities.js';
import type { TelegramClient } from './client.js';
import { type TelegramChannelConfig, assertTelegramConfig } from './config.js';
import { TelegramChannelInstance } from './instance.js';

export interface TelegramAdapterOptions {
  /**
   * Test seam: supply a pre-built `TelegramClient` stub. Production
   * callers leave this unset so each instance builds its own client from
   * its bot token.
   */
  client?: TelegramClient;
  /** Test seam: factory override. Overrides `client` when the adapter creates more than one instance. */
  createClient?(config: TelegramChannelConfig, deps: ChannelDependencies): TelegramClient;
}

/**
 * Telegram channel adapter. Registered under `type: 'telegram'`.
 * Produces a `TelegramChannelInstance` per configured entry.
 */
export function createTelegramAdapter(
  opts: TelegramAdapterOptions = {},
): ChannelAdapter<TelegramChannelConfig> {
  return {
    type: 'telegram',
    agentCompat: '>=0.0.1',
    capabilities: TELEGRAM_CAPABILITIES,
    validateConfig(cfg: unknown): asserts cfg is TelegramChannelConfig {
      assertTelegramConfig(cfg);
    },
    async create(cfg: TelegramChannelConfig, deps: ChannelDependencies): Promise<ChannelInstance> {
      const client = opts.client ?? opts.createClient?.(cfg, deps);
      return new TelegramChannelInstance({
        config: cfg,
        deps,
        ...(client !== undefined && { client }),
      });
    },
  };
}

/** Default adapter instance. */
export const telegramAdapter = createTelegramAdapter();

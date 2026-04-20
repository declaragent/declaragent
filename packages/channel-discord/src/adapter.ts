import type { ChannelAdapter, ChannelDependencies, ChannelInstance } from '@declaragent/core';
import { DISCORD_CAPABILITIES } from './capabilities.js';
import type { DiscordClient } from './client.js';
import { type DiscordChannelConfig, assertDiscordConfig } from './config.js';
import { DiscordChannelInstance } from './instance.js';

export interface DiscordAdapterOptions {
  /**
   * Test seam: supply a pre-built `DiscordClient` stub. Production
   * callers leave this unset so each instance builds its own client
   * from its bot token + application id.
   */
  client?: DiscordClient;
  /** Test seam: factory override. Overrides `client` when the adapter creates more than one instance. */
  createClient?(config: DiscordChannelConfig, deps: ChannelDependencies): DiscordClient;
}

/**
 * Discord channel adapter. Registered under `type: 'discord'`. Produces
 * a `DiscordChannelInstance` per configured entry.
 */
export function createDiscordAdapter(
  opts: DiscordAdapterOptions = {},
): ChannelAdapter<DiscordChannelConfig> {
  return {
    type: 'discord',
    agentCompat: '>=0.0.1',
    capabilities: DISCORD_CAPABILITIES,
    validateConfig(cfg: unknown): asserts cfg is DiscordChannelConfig {
      assertDiscordConfig(cfg);
    },
    async create(cfg: DiscordChannelConfig, deps: ChannelDependencies): Promise<ChannelInstance> {
      const client = opts.client ?? opts.createClient?.(cfg, deps);
      return new DiscordChannelInstance({
        config: cfg,
        deps,
        ...(client !== undefined && { client }),
      });
    },
  };
}

/** Default adapter instance. */
export const discordAdapter = createDiscordAdapter();

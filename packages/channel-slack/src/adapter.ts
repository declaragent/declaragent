import type { ChannelAdapter, ChannelDependencies, ChannelInstance } from '@declaragent/core';
import { SLACK_CAPABILITIES } from './capabilities.js';
import type { SlackClient, SocketModeTransport } from './client.js';
import { type SlackChannelConfig, assertSlackConfig } from './config.js';
import { SlackChannelInstance } from './instance.js';

export interface SlackAdapterOptions {
  /**
   * Test seam: supply a pre-built `SlackClient` stub. Production callers
   * leave this unset so each instance builds its own client from its
   * bot token + optional app token.
   */
  client?: SlackClient;
  /** Test seam: factory override (overrides `client` when the adapter creates more than one instance). */
  createClient?(config: SlackChannelConfig, deps: ChannelDependencies): SlackClient;
  /**
   * Test seam: supply a stub Socket Mode transport. Production callers
   * let the instance build its own from `apps.connections.open`.
   */
  socketTransport?: SocketModeTransport;
  createSocketTransport?(
    config: SlackChannelConfig,
    deps: ChannelDependencies,
  ): SocketModeTransport;
}

/**
 * Slack channel adapter. Registered under `type: 'slack'`. Produces a
 * `SlackChannelInstance` per configured entry.
 */
export function createSlackAdapter(
  opts: SlackAdapterOptions = {},
): ChannelAdapter<SlackChannelConfig> {
  return {
    type: 'slack',
    agentCompat: '>=0.0.1',
    capabilities: SLACK_CAPABILITIES,
    validateConfig(cfg: unknown): asserts cfg is SlackChannelConfig {
      assertSlackConfig(cfg);
    },
    async create(cfg: SlackChannelConfig, deps: ChannelDependencies): Promise<ChannelInstance> {
      const client = opts.client ?? opts.createClient?.(cfg, deps);
      const socketTransport = opts.socketTransport ?? opts.createSocketTransport?.(cfg, deps);
      return new SlackChannelInstance({
        config: cfg,
        deps,
        ...(client !== undefined && { client }),
        ...(socketTransport !== undefined && { socketTransport }),
      });
    },
  };
}

/** Default adapter instance. */
export const slackAdapter = createSlackAdapter();

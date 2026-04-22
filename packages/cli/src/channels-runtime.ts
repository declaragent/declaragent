/**
 * Channel runtime wiring for `declaragent up`.
 *
 * Loads `channels.json` (or `.yaml`) from `~/.declaragent/`, discovers
 * every `@declaragent/channel-*` adapter installed in `node_modules`,
 * instantiates each configured channel, and returns a {@link ChannelRegistry}
 * + `SendMessage`-ready mailbox. The factory is infrastructure — it
 * does not subscribe to the bus for auto-forward (that's the optional
 * {@link createChannelOutboundBridge} layer, added in a future slice).
 *
 * @since 0.5.0-slice.3
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type {
  ChannelAdapter,
  ChannelInstance,
  ChannelRegistry,
  EventBus,
  Logger,
  Mailbox,
  MetricsRegistry,
  Tracer,
} from '@declaragent/core';
import type { ChannelInboundBridge, InboundRoute } from '@declaragent/core';
import {
  createChannelInboundBridge,
  createChannelRegistry,
  createMailbox,
  discoverChannelAdapters,
  loadChannelsConfig,
} from '@declaragent/core';
import { channelsConfigPath, configDir, sessionsDbPath } from './paths.js';

export interface ChannelRuntime {
  /** Populated registry — pass into `createSendMessageTool({ channels })`. */
  channels: ChannelRegistry;
  /** Mailbox scoped to the shared sessions db. */
  mailbox: Mailbox;
  /** Shape-preserving list of "this channel didn't start" reasons. */
  skipped: readonly { type: string; reason: string }[];
  /** Close every channel instance + the mailbox db. Idempotent. */
  shutdown(): Promise<void>;
}

export interface StartChannelRuntimeOptions {
  bus: EventBus;
  logger: Logger;
  /** Override for channels config path. Default: `~/.declaragent/channels.json`. */
  configPath?: string;
  /** Override for sessions db path. Default: shared `sessionsDbPath()`. */
  sessionsDb?: string;
  /** Extra search paths for channel adapter discovery. Default: agent dir + cwd + configDir. */
  agentDir?: string;
  /**
   * Metrics registry passed to every channel instance via `deps.metrics`.
   * Shared with {@link startAgentSources} by `declaragent up` so inbound
   * + outbound counters land in the same `/metrics` exposition.
   * @since 0.6.0-slice.1
   */
  metrics?: MetricsRegistry;
  /**
   * Tracer passed to every channel instance via `deps.tracer`. Shared
   * with {@link startAgentSources} by `declaragent up` so the same
   * trace covers source → channel bookkeeping when OTel is enabled.
   * @since 0.6.0-slice.2
   */
  tracer?: Tracer;
}

/**
 * Bring up every configured channel + construct a mailbox so
 * `SendMessage({ kind: 'channel' | 'agent' })` has a live destination.
 *
 * Missing config file → returns an empty runtime (no channels, no
 * mailbox table mutations). A broken individual channel is logged +
 * skipped so sibling channels still start.
 */
export async function startChannelRuntime(
  opts: StartChannelRuntimeOptions,
): Promise<ChannelRuntime> {
  const registry = createChannelRegistry();
  const instances: ChannelInstance[] = [];
  const skipped: { type: string; reason: string }[] = [];

  const path = opts.configPath ?? channelsConfigPath();
  const dbPath = opts.sessionsDb ?? sessionsDbPath();
  const db = new Database(dbPath);
  const mailbox = createMailbox({ db, bus: opts.bus });

  if (!existsSync(path)) {
    return {
      channels: registry,
      mailbox,
      skipped,
      shutdown: async () => {
        try {
          db.close();
        } catch {
          // best-effort
        }
      },
    };
  }

  // Discover installed adapters + index by type.
  const searchPaths = uniquePaths([opts.agentDir, process.cwd(), configDir()]);
  let discovered: Awaited<ReturnType<typeof discoverChannelAdapters>>;
  try {
    discovered = await discoverChannelAdapters({ searchPaths, logger: opts.logger });
  } catch (err) {
    opts.logger.warn('channels.adapter-discovery-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    discovered = [];
  }
  const byType = new Map<string, ChannelAdapter<unknown>>();
  for (const d of discovered) byType.set(d.type, d.adapter);

  // Load + validate the per-channel config.
  let loaded: Awaited<ReturnType<typeof loadChannelsConfig>>;
  try {
    loaded = await loadChannelsConfig({ path });
  } catch (err) {
    opts.logger.warn('channels.config-load-failed', {
      path,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      channels: registry,
      mailbox,
      skipped,
      shutdown: async () => {
        try {
          db.close();
        } catch {
          // best-effort
        }
      },
    };
  }

  // Collect inbound routes per channel (Slice 6 / PR 6.1) so we can
  // wire the bridge once the instances are registered. Parsing is
  // defensive: malformed entries log + skip rather than abort, so one
  // bad inbound block doesn't stop a whole config from loading.
  const routesByChannel: Record<string, readonly InboundRoute[]> = {};

  for (const entry of loaded.channels) {
    const adapter = byType.get(entry.type);
    if (adapter === undefined) {
      skipped.push({
        type: entry.type,
        reason: `no @declaragent/channel-${entry.type} package installed`,
      });
      opts.logger.warn('channels.adapter-missing', { type: entry.type });
      continue;
    }
    try {
      // validateConfig is an assertion function; apply it via a helper
      // whose binding is explicitly typed so TypeScript accepts the
      // narrowing through an interface-method call.
      const validate: (c: unknown) => asserts c is unknown = (c) => adapter.validateConfig(c);
      validate(entry.config);
      const instance = await adapter.create(entry.config as never, {
        bus: opts.bus,
        logger: opts.logger.child({ channel: entry.type }),
        configDir: configDir(),
        channels: registry,
        ...(opts.metrics !== undefined && { metrics: opts.metrics }),
        ...(opts.tracer !== undefined && { tracer: opts.tracer }),
      });
      registry.register(instance);
      instances.push(instance);
      opts.logger.info('channels.channel-ready', { type: entry.type, id: instance.id });

      const routes = parseInboundRoutes(entry.config, opts.logger);
      if (routes.length > 0) routesByChannel[instance.id] = routes;
    } catch (err) {
      skipped.push({
        type: entry.type,
        reason: err instanceof Error ? err.message : String(err),
      });
      opts.logger.warn('channels.channel-failed', {
        type: entry.type,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Single bridge per up-process, shared across all channels. The bus
  // is the same one every adapter publishes inbound events onto, so one
  // subscription covers every channel.
  let bridge: ChannelInboundBridge | undefined;
  const hasRoutes = Object.values(routesByChannel).some((r) => r.length > 0);
  if (hasRoutes) {
    bridge = createChannelInboundBridge({
      bus: opts.bus,
      routesByChannel,
      logger: opts.logger,
    });
    opts.logger.info('channels.inbound-bridge.ready', {
      channelIds: Object.keys(routesByChannel),
    });
  }

  let stopped = false;
  return {
    channels: registry,
    mailbox,
    skipped,
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
      try {
        bridge?.detach();
      } catch {
        // best-effort — detach is idempotent by contract
      }
      await Promise.all(
        instances.map(async (inst) => {
          try {
            await inst.stop();
          } catch {
            // best-effort shutdown
          }
        }),
      );
      try {
        db.close();
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Extract `inbound.routes` from a channel entry's config object. The
 * config is `Record<string, unknown>` at this layer, so we validate
 * shape defensively and skip entries that don't match. Shape:
 *
 * ```json
 * "inbound": { "routes": [{ "event": "chat.mention", "skill": "triage" }, …] }
 * ```
 *
 * @since 0.6.0-slice.6
 */
function parseInboundRoutes(
  config: Readonly<Record<string, unknown>>,
  logger: Logger,
): readonly InboundRoute[] {
  const inbound = config.inbound;
  if (inbound === undefined || inbound === null) return [];
  if (typeof inbound !== 'object') {
    logger.warn('channels.inbound-config.invalid', {
      reason: `inbound must be an object (got ${typeof inbound})`,
    });
    return [];
  }
  const routesRaw = (inbound as { routes?: unknown }).routes;
  if (routesRaw === undefined || routesRaw === null) return [];
  if (!Array.isArray(routesRaw)) {
    logger.warn('channels.inbound-config.invalid', {
      reason: 'inbound.routes must be an array',
    });
    return [];
  }
  const out: InboundRoute[] = [];
  for (const [i, raw] of routesRaw.entries()) {
    if (!raw || typeof raw !== 'object') {
      logger.warn('channels.inbound-config.route-invalid', {
        index: i,
        reason: 'entry is not an object',
      });
      continue;
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.event !== 'string' || r.event.length === 0) {
      logger.warn('channels.inbound-config.route-invalid', {
        index: i,
        reason: 'event must be a non-empty string',
      });
      continue;
    }
    if (typeof r.skill !== 'string' || r.skill.length === 0) {
      logger.warn('channels.inbound-config.route-invalid', {
        index: i,
        reason: 'skill must be a non-empty string',
      });
      continue;
    }
    out.push({ event: r.event, skill: r.skill });
  }
  return out;
}

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const p of paths) {
    if (p !== undefined && p.length > 0) seen.add(p);
  }
  return [...seen];
}

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
} from '@declaragent/core';
import {
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
      });
      registry.register(instance);
      instances.push(instance);
      opts.logger.info('channels.channel-ready', { type: entry.type, id: instance.id });
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

  let stopped = false;
  return {
    channels: registry,
    mailbox,
    skipped,
    shutdown: async () => {
      if (stopped) return;
      stopped = true;
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

function uniquePaths(paths: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const p of paths) {
    if (p !== undefined && p.length > 0) seen.add(p);
  }
  return [...seen];
}

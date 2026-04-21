/**
 * Plugin runtime activation for `declaragent up`.
 *
 * Reads `~/.declaragent/plugins.json`, calls `loadPlugin` on every
 * consented entry, and returns a handle that exposes the contributed
 * tools (so the engine's tool array picks them up) alongside the
 * per-plugin `deactivate` handles (so `stopAll` unwinds cleanly).
 *
 * Contributions flow:
 *   - `tools`     → registered in the per-agent `ExtensionRegistry`
 *                   + surfaced via `runtime.tools` for the engine.
 *   - `skills`    → registered alongside scaffold skills; the
 *                   dispatcher's skill lookup sees both transparently.
 *   - `mcpServers`→ currently spawned by `loadPlugin` itself (stdio
 *                   only). HTTP/SSE/streamable remain scoped to the
 *                   slice-2a loader — plugin-contributed remote MCP
 *                   servers are deferred until the plugin loader
 *                   learns about the newer transports.
 *   - `hooks`     → subscribed to the shared `HookRegistry`.
 *
 * Plugins that are installed but lack `consentedPermissions` are
 * skipped with a warning. Matches the pluginInstall UX: the user has
 * to explicitly approve before runtime activation.
 *
 * @since 0.5.0-slice.4
 */

import type {
  ExtensionRegistry,
  HookRegistry,
  Logger,
  PluginActivation,
  PluginStore,
  Tool,
} from '@declaragent/core';
import { createPluginStore, loadPlugin } from '@declaragent/core';
import { pluginStorePath } from './paths.js';

export interface PluginRuntime {
  /** Contributed tools extracted from the per-agent registry. */
  tools: readonly Tool[];
  /** Activations tracked for cleanup. Ordering preserves activation-order. */
  activations: readonly PluginActivation[];
  /** Plugins that were present in the store but couldn't be activated. */
  skipped: readonly { name: string; reason: string }[];
  /** Deactivate every plugin in reverse activation order. Idempotent. */
  shutdown(): Promise<void>;
}

export interface StartPluginRuntimeOptions {
  registry: ExtensionRegistry;
  hookRegistry: HookRegistry;
  logger: Logger;
  /** Test seam. Defaults to the user-global plugin store. */
  store?: PluginStore;
}

export async function startPluginRuntime(opts: StartPluginRuntimeOptions): Promise<PluginRuntime> {
  const store = opts.store ?? createPluginStore(pluginStorePath());
  const activations: PluginActivation[] = [];
  const skipped: { name: string; reason: string }[] = [];

  let entries: Awaited<ReturnType<PluginStore['list']>>;
  try {
    entries = await store.list();
  } catch (err) {
    opts.logger.warn('plugins.store-unreadable', {
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      tools: [],
      activations,
      skipped,
      shutdown: async () => {},
    };
  }

  for (const entry of entries) {
    // Plugins without consented permissions were never approved. Matches
    // pluginInstall's behavior: consent is opt-in, not automatic.
    // A plugin with no `permissions` in its manifest still gets a
    // `consentedAt` timestamp on approval, so the presence of
    // `consentedAt` is the actual gate.
    if (entry.consentedAt === undefined) {
      skipped.push({
        name: entry.name,
        reason: 'not consented — run `declaragent plugin install`',
      });
      opts.logger.warn('plugins.unconsented', { name: entry.name });
      continue;
    }
    try {
      const activation = await loadPlugin({
        pluginDir: entry.dir,
        registry: opts.registry,
        hookRegistry: opts.hookRegistry,
        logger: opts.logger,
      });
      activations.push(activation);
      opts.logger.info('plugins.activated', {
        name: activation.pluginId,
        version: activation.pluginVersion,
        extensions: activation.extensionIds.length,
      });
    } catch (err) {
      skipped.push({
        name: entry.name,
        reason: err instanceof Error ? err.message : String(err),
      });
      opts.logger.warn('plugins.activation-failed', {
        name: entry.name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Snapshot plugin-contributed tools. `registry.byKind('tool')` also
  // surfaces the scaffold / built-in tools if they were registered —
  // for the up-cli flow they aren't, so this returns plugin tools only.
  // Unwrap from the Extension envelope into the raw Tool object.
  const toolExtensions = opts.registry.byKind('tool');
  const tools: Tool[] = toolExtensions.map((ext) => ext.payload);

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Reverse order so dependents come down before depends — same
    // convention `loadPlugin`'s rollback uses.
    for (const a of [...activations].reverse()) {
      try {
        await a.deactivate();
      } catch {
        // loadPlugin logs internally on unregister failure.
      }
    }
  };

  return { tools, activations, skipped, shutdown };
}

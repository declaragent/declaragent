import * as path from 'node:path';
import { toolExtension } from '../extension/tool-extension.js';
import type { Extension, ExtensionRegistry, ExtensionSource } from '../extension/types.js';
import { hookExtension } from '../hooks/hook-extension.js';
import type { HookRegistry } from '../hooks/types.js';
import { mcpServerExtension } from '../mcp/server-extension.js';
import { createStdioMCPClient } from '../mcp/stdio-client.js';
import { listMCPToolExtensions } from '../mcp/tool-adapter.js';
import { loadSkills } from '../skills/loader.js';
import { skillExtension } from '../skills/skill-extension.js';
import type { Logger } from '../types/logger.js';
import type { Tool } from '../types/tool.js';
import { loadPluginManifest } from './manifest.js';
import {
  type PluginActivation,
  PluginActivationError,
  type PluginMCPServerSpec,
  type PluginManifest,
} from './types.js';

const NOOP_LOGGER: Logger = (() => {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
})();

export interface LoadPluginOptions {
  /** Absolute path to the plugin's directory (containing `plugin.json`). */
  pluginDir: string;
  registry: ExtensionRegistry;
  hookRegistry: HookRegistry;
  /** Optional override for the manifest (skips `plugin.json` read — used by tests). */
  manifest?: PluginManifest;
  logger?: Logger;
}

/**
 * Load a plugin from a local directory: parse the manifest, register
 * every contribution through the `ExtensionRegistry`, subscribe hooks
 * to the `HookRegistry`. On any error, rolls back everything that was
 * registered so far before throwing.
 *
 * Idempotency: if a contribution id already exists in the registry the
 * `register` call throws `ExtensionConflictError`, which propagates and
 * triggers rollback. Callers should check `~/.declaragent/plugins.json`
 * before calling `loadPlugin` for the same plugin twice.
 */
export async function loadPlugin(options: LoadPluginOptions): Promise<PluginActivation> {
  const logger = (options.logger ?? NOOP_LOGGER).child({ pluginDir: options.pluginDir });
  const manifest = options.manifest ?? (await loadPluginManifest(options.pluginDir));
  const source: ExtensionSource = {
    type: 'plugin',
    pluginId: manifest.name,
    pluginVersion: manifest.version,
  };

  // Each handle removes one registration (in reverse order on rollback /
  // deactivate). Hook subscriptions also live here.
  const handles: Array<() => Promise<void>> = [];
  const extensionIds: string[] = [];

  async function register(ext: Extension): Promise<void> {
    await options.registry.register(ext);
    extensionIds.push(ext.descriptor.id);
    handles.push(async () => {
      await options.registry.unregister(ext.descriptor.id).catch((err) => {
        logger.warn('plugin.unregister.error', { id: ext.descriptor.id, err: String(err) });
      });
    });
  }

  try {
    // ── Tools ────────────────────────────────────────────────────────────
    for (const toolPath of manifest.contributes.tools) {
      const tools = await importContributions<Tool>(
        options.pluginDir,
        toolPath,
        manifest.name,
        'tools',
      );
      for (const tool of tools) {
        await register(toolExtension(tool, source));
      }
    }

    // ── Skills ───────────────────────────────────────────────────────────
    for (const skillsDir of manifest.contributes.skills) {
      const result = await loadSkills({
        sources: [
          {
            tier: { type: 'plugin', pluginId: manifest.name, pluginVersion: manifest.version },
            dir: path.resolve(options.pluginDir, skillsDir),
          },
        ],
        logger,
      });
      for (const err of result.errors) {
        logger.warn('plugin.skill.parseError', { file: err.filePath, err: String(err.error) });
      }
      for (const skill of result.skills) {
        await register(skillExtension(skill));
      }
    }

    // ── MCP servers ──────────────────────────────────────────────────────
    for (const mcpSpec of manifest.contributes.mcpServers) {
      await activateMCPServer(mcpSpec, source, register, logger);
    }

    // ── Hooks ────────────────────────────────────────────────────────────
    for (const hookPath of manifest.contributes.hooks) {
      const hooks = await importContributions<import('../hooks/types.js').Hook>(
        options.pluginDir,
        hookPath,
        manifest.name,
        'hooks',
      );
      for (const hook of hooks) {
        const ext = hookExtension(hook, source);
        await register(ext);
        const off = options.hookRegistry.on(hook.point, hook.subscriber);
        // Subscription is paired with the registration; pop the auto
        // unregister handle and re-push a combined one.
        const lastUnregister = handles.pop();
        handles.push(async () => {
          off();
          if (lastUnregister) await lastUnregister();
        });
      }
    }

    // ── Commands ─────────────────────────────────────────────────────────
    // Slice 7 will fill this in once the Command type lands. We accept
    // the manifest entries today so plugins can declare them ahead of
    // the runtime that consumes them.
    for (const commandPath of manifest.contributes.commands) {
      logger.debug('plugin.command.deferred', { path: commandPath });
    }
  } catch (err) {
    // Rollback in reverse order so dependents come down before depends.
    for (const handle of handles.reverse()) {
      try {
        await handle();
      } catch {
        // already logged
      }
    }
    if (err instanceof PluginActivationError) throw err;
    throw new PluginActivationError(
      manifest.name,
      err instanceof Error ? err.message : String(err),
      err,
    );
  }

  return {
    pluginId: manifest.name,
    pluginVersion: manifest.version,
    pluginDir: options.pluginDir,
    manifest,
    extensionIds,
    deactivate: async () => {
      for (const handle of handles.reverse()) {
        try {
          await handle();
        } catch {
          // logged inside the handle
        }
      }
      handles.length = 0;
    },
  };
}

async function activateMCPServer(
  spec: PluginMCPServerSpec,
  source: ExtensionSource,
  register: (ext: Extension) => Promise<void>,
  logger: Logger,
): Promise<void> {
  if (spec.transport.type !== 'stdio') {
    throw new PluginActivationError(
      source.type === 'plugin' ? source.pluginId : '<unknown>',
      `mcpServers[${spec.name}]: HTTP transport not supported in this slice (lands in slice 9)`,
    );
  }
  const client = createStdioMCPClient({
    name: spec.name,
    transport: spec.transport,
    protocolVersion: spec.protocolVersion,
    logger,
  });

  // Register the server itself first so deactivate() shuts it down even
  // if tool listing fails.
  await register(mcpServerExtension(client, spec.name, source));

  let toolExts: Awaited<ReturnType<typeof listMCPToolExtensions>>;
  try {
    toolExts = await listMCPToolExtensions({
      serverName: spec.name,
      client,
      source,
    });
  } catch (err) {
    throw new PluginActivationError(
      source.type === 'plugin' ? source.pluginId : '<unknown>',
      `mcpServers[${spec.name}]: failed to list tools: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }

  // Re-use the existing registry from the toolExtension wrapper.
  for (const ext of toolExts) {
    await register(ext);
  }
}

/**
 * Dynamic-import a contributed JS module from the plugin dir and pull
 * out the contribution array. Accepted shapes:
 *   - `export default <Item> | <Item>[]`
 *   - `export const <kind>: <Item>[]`  (e.g. `export const tools = [...]`)
 *   - `export const <singular>: <Item>` (singular form, auto-wrapped)
 */
async function importContributions<T>(
  pluginDir: string,
  modulePath: string,
  pluginName: string,
  kind: 'tools' | 'hooks',
): Promise<T[]> {
  const absolute = path.resolve(pluginDir, modulePath);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(absolute)) as Record<string, unknown>;
  } catch (err) {
    throw new PluginActivationError(
      pluginName,
      `failed to import ${modulePath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const candidates: unknown[] = [];
  const namedKey = kind; // 'tools' or 'hooks'
  if (mod[namedKey] !== undefined) candidates.push(mod[namedKey]);
  if (mod.default !== undefined) candidates.push(mod.default);
  for (const c of candidates) {
    if (Array.isArray(c)) return c as T[];
    if (c !== undefined && c !== null) return [c as T];
  }
  throw new PluginActivationError(
    pluginName,
    `${modulePath} did not export "${namedKey}" or a default value`,
  );
}

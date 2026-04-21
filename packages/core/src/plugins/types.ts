import type { MCPTransportConfig } from '../mcp/types.js';

/**
 * Validated plugin manifest. Mirrors the JSON shape in `plugin.json`
 * but with strongly-typed defaults applied (empty arrays for any
 * unspecified contribution kind).
 *
 * @since 1.0.0
 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  /**
   * Permission patterns the plugin requires. Surfaced at install time
   * for user consent; once consented, the patterns are merged into the
   * permission gate's allow list.
   */
  permissions: readonly string[];
  contributes: {
    /** Relative paths to JS modules that export `Tool[]`. */
    tools: readonly string[];
    /** Relative paths to directories of `*.md` skill files. */
    skills: readonly string[];
    /** MCP servers spawned + wrapped at activation time. */
    mcpServers: readonly PluginMCPServerSpec[];
    /** Relative paths to JS modules that export `Hook[]`. */
    hooks: readonly string[];
    /** Relative paths to JS modules that export commands (slice 7). */
    commands: readonly string[];
  };
}

export interface PluginMCPServerSpec {
  /** Short name; namespaces tools as `mcp__<name>__<tool>`. */
  name: string;
  /**
   * Supported transports: stdio (local subprocess), http (plain
   * request/response), sse (older 2024-11-05 remote), http-streamable
   * (current 2025-03-26 remote). Wired in slices 2a/2b/2c.
   */
  transport: MCPTransportConfig;
  protocolVersion: string;
}

/**
 * Handle returned by `loadPlugin`. Closing it deactivates every
 * extension the plugin registered, in reverse order.
 */
export interface PluginActivation {
  pluginId: string;
  pluginVersion: string;
  pluginDir: string;
  manifest: PluginManifest;
  /** All extension descriptor ids registered by this plugin (for `/plugin info`). */
  extensionIds: readonly string[];
  /** Idempotent: deactivates and unregisters all contributions. */
  deactivate(): Promise<void>;
}

export class PluginManifestError extends Error {
  readonly code = 'EPLUGINMANIFEST';
  readonly pluginDir: string;
  constructor(pluginDir: string, message: string) {
    super(`${pluginDir}: ${message}`);
    this.name = 'PluginManifestError';
    this.pluginDir = pluginDir;
  }
}

export class PluginActivationError extends Error {
  readonly code = 'EPLUGINACTIVATE';
  readonly pluginId: string;
  override readonly cause?: unknown;
  constructor(pluginId: string, message: string, cause?: unknown) {
    super(`${pluginId}: ${message}`);
    this.name = 'PluginActivationError';
    this.pluginId = pluginId;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Disk-backed plugin registry persisted at `~/.declaragent/plugins.json`.
 * Tracks installed plugins + their consent state.
 */
export interface PluginStoreEntry {
  name: string;
  version: string;
  /** Absolute path to the plugin's directory on disk. */
  dir: string;
  installedAt: string;
  /**
   * Permissions the user consented to at install time. Filled in by
   * slice 8's consent flow; absent in slice 6.
   */
  consentedPermissions?: readonly string[];
  consentedAt?: string;
}

export interface PluginStoreShape {
  version: 1;
  plugins: Record<string, PluginStoreEntry>;
}

import type { EventSourceAdapter, EventSourceInstance } from '../events/types.js';
import type { Hook } from '../hooks/types.js';
import type { MCPClient } from '../mcp/types.js';
import type { Skill } from '../skills/types.js';
import type { Logger } from '../types/logger.js';
import type { PermissionGate } from '../types/permission.js';
import type { Tool } from '../types/tool.js';

export type ExtensionKind =
  | 'tool'
  | 'skill'
  | 'mcp-server'
  | 'hook'
  | 'command'
  | 'event-source'
  | 'event-source-adapter';

export type ExtensionSource =
  | { type: 'built-in' }
  | { type: 'user' }
  | { type: 'plugin'; pluginId: string; pluginVersion: string }
  | { type: 'team'; path: string };

export interface ExtensionDescriptor {
  /**
   * Globally unique. Convention: `<kind>:<name>` for built-ins
   * (`tool:Bash`), `<kind>:<plugin>:<name>` for plugin contributions
   * (`skill:plugin-github:pr-review`), and `tool:mcp__<server>__<tool>`
   * for MCP-wrapped tools.
   */
  id: string;
  kind: ExtensionKind;
  source: ExtensionSource;
  /** Glob patterns surfaced to the user at install/consent time. */
  declaredPermissions?: readonly string[];
}

/**
 * Payload carried by each extension keyed by kind. Future slices fill
 * in the `unknown` slots: skills (slice 4), mcp-server (slice 2), hooks
 * (slice 5), commands (slice 7).
 */
export interface ExtensionPayloads {
  tool: Tool;
  skill: Skill;
  'mcp-server': MCPClient;
  hook: Hook;
  /** Slice 7 will fill this in with `Command` once CLI commands land. */
  command: unknown;
  /** Phase-3 slice 3 widens `EventSourceInstance` to the full adapter shape. */
  'event-source': EventSourceInstance;
  /**
   * Phase-4 slice 1. An `EventSourceAdapter` (not a live instance) that
   * Slice 4's discovery layer registers once per installed npm package.
   * Per-source instances are built from these adapters via
   * `sourceInstanceExtension()` and registered separately as
   * `'event-source'` entries.
   */
  'event-source-adapter': EventSourceAdapter<unknown>;
}

export interface ExtensionContext {
  registry: ExtensionRegistry;
  logger: Logger;
  /** Read-only inspection; mutation only via consent flow. */
  permissions: PermissionGate;
  /** Absolute path to the user config dir, e.g. `~/.declaragent`. */
  configDir: string;
}

export interface Extension<K extends ExtensionKind = ExtensionKind> {
  descriptor: ExtensionDescriptor & { kind: K };
  payload: ExtensionPayloads[K];
  activate(ctx: ExtensionContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface ExtensionRegistry {
  /**
   * Register and activate. Throws on duplicate id (centralized conflict
   * detection — e.g. two MCP servers contributing `mcp__github__pr`).
   *
   * Note: deviates from the draft Phase-2 plan which had this sync.
   * We need to await `activate()` for MCP servers (spawning child
   * processes) before tools become callable, otherwise `byKind('tool')`
   * could return half-initialized extensions.
   */
  register(ext: Extension): Promise<void>;
  unregister(id: string): Promise<void>;
  list(): readonly ExtensionDescriptor[];
  byKind<K extends ExtensionKind>(kind: K): readonly Extension<K>[];
  get(id: string): Extension | undefined;
  /** Reload an extension in place. Used by hot reload (slice 6+). */
  reload(id: string): Promise<void>;
}

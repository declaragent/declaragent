import type { Tool } from '../types/tool.js';
import type { Extension, ExtensionSource } from './types.js';

/**
 * Wrap a Phase-1 `Tool` so it can register through the `ExtensionRegistry`.
 * Built-in tools default to `source: { type: 'built-in' }`; MCP-wrapped
 * tools (slice 3) and plugin-contributed tools (slice 6) supply their own.
 */
export function toolExtension(
  tool: Tool,
  source: ExtensionSource = { type: 'built-in' },
): Extension<'tool'> {
  return {
    descriptor: {
      id: `tool:${tool.name}`,
      kind: 'tool',
      source,
    },
    payload: tool,
    activate() {
      // Built-in tools have no startup; MCP/plugin wrappers override.
    },
  };
}

import type { Extension, ExtensionSource } from '../extension/types.js';
import type { MCPClient } from './types.js';

/**
 * Wrap an `MCPClient` for the `ExtensionRegistry`. The plugin loader
 * (slice 6) registers one of these per declared `mcpServers` entry; the
 * client's tools are registered separately via `listMCPToolExtensions`.
 *
 * Activation is a no-op — the client is started lazily on the first
 * `listTools` / `callTool`. Deactivation calls `client.shutdown()`.
 */
export function mcpServerExtension(
  client: MCPClient,
  serverName: string,
  source: ExtensionSource,
): Extension<'mcp-server'> {
  return {
    descriptor: {
      id: `mcp-server:${serverName}`,
      kind: 'mcp-server',
      source,
    },
    payload: client,
    activate() {},
    async deactivate() {
      await client.shutdown();
    },
  };
}

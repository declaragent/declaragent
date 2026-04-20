import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { PluginMCPServerSpec } from '@declaragent/core';

const STORE_VERSION = 1 as const;

export interface MCPConfigShape {
  version: 1;
  servers: PluginMCPServerSpec[];
}

export interface MCPConfigStore {
  list(): Promise<readonly PluginMCPServerSpec[]>;
  get(name: string): Promise<PluginMCPServerSpec | undefined>;
  add(spec: PluginMCPServerSpec): Promise<void>;
  remove(name: string): Promise<boolean>;
}

/**
 * JSON-file-backed list of user-configured MCP servers (added via
 * `declaragent mcp add`). Distinct from plugin-contributed MCP servers,
 * which are declared in each plugin's manifest.
 */
export function createMCPConfigStore(filePath: string): MCPConfigStore {
  async function read(): Promise<MCPConfigShape> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as MCPConfigShape;
      if (parsed.version !== STORE_VERSION) {
        throw new Error(
          `${filePath}: unsupported mcp-config version ${parsed.version}; expected ${STORE_VERSION}`,
        );
      }
      return { version: STORE_VERSION, servers: parsed.servers ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: STORE_VERSION, servers: [] };
      }
      throw err;
    }
  }

  async function write(state: MCPConfigShape): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  return {
    async list() {
      const state = await read();
      return state.servers;
    },

    async get(name) {
      const state = await read();
      return state.servers.find((s) => s.name === name);
    },

    async add(spec) {
      const state = await read();
      const idx = state.servers.findIndex((s) => s.name === spec.name);
      if (idx === -1) state.servers.push(spec);
      else state.servers[idx] = spec;
      await write(state);
    },

    async remove(name) {
      const state = await read();
      const next = state.servers.filter((s) => s.name !== name);
      if (next.length === state.servers.length) return false;
      state.servers = next;
      await write(state);
      return true;
    },
  };
}

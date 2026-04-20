import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PluginStoreEntry, PluginStoreShape } from './types.js';

const STORE_VERSION = 1 as const;
const EMPTY_STORE: PluginStoreShape = { version: STORE_VERSION, plugins: {} };

export interface PluginStore {
  list(): Promise<readonly PluginStoreEntry[]>;
  get(pluginId: string): Promise<PluginStoreEntry | undefined>;
  add(entry: PluginStoreEntry): Promise<void>;
  remove(pluginId: string): Promise<boolean>;
  /** Patch a stored entry (used by slice 8 to record consent timestamps). */
  update(pluginId: string, patch: Partial<PluginStoreEntry>): Promise<PluginStoreEntry>;
}

/**
 * JSON-file-backed plugin registry. Reads + writes the file on every
 * call — slice 6 doesn't need to optimize for hot paths and round-trip
 * I/O keeps the in-memory state honest if multiple processes touch the
 * file (e.g. CLI install while REPL is running).
 */
export function createPluginStore(filePath: string): PluginStore {
  async function read(): Promise<PluginStoreShape> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PluginStoreShape;
      if (parsed.version !== STORE_VERSION) {
        throw new Error(
          `${filePath}: unsupported plugin-store version ${parsed.version}; expected ${STORE_VERSION}`,
        );
      }
      // Ensure shape is sound — return a fresh object so callers don't
      // accidentally mutate the parsed copy.
      return { version: STORE_VERSION, plugins: parsed.plugins ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: STORE_VERSION, plugins: {} };
      }
      throw err;
    }
  }

  async function write(state: PluginStoreShape): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  return {
    async list() {
      const state = await read();
      return Object.values(state.plugins);
    },

    async get(pluginId) {
      const state = await read();
      return state.plugins[pluginId];
    },

    async add(entry) {
      const state = await read();
      state.plugins[entry.name] = entry;
      await write(state);
    },

    async remove(pluginId) {
      const state = await read();
      if (!(pluginId in state.plugins)) return false;
      delete state.plugins[pluginId];
      await write(state);
      return true;
    },

    async update(pluginId, patch) {
      const state = await read();
      const current = state.plugins[pluginId];
      if (!current) {
        throw new Error(`plugin "${pluginId}" not in store ${filePath}`);
      }
      const updated = { ...current, ...patch };
      state.plugins[pluginId] = updated;
      await write(state);
      return updated;
    },
  };
}

export const DEFAULT_PLUGIN_STORE_FILE = 'plugins.json';

void EMPTY_STORE; // keep referenced for documentation of the default shape

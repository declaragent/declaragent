import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

const STORE_VERSION = 1 as const;

export interface MCPConsentRecord {
  name: string;
  approvedAt: string;
}

interface MCPConsentShape {
  version: 1;
  approved: MCPConsentRecord[];
}

export interface MCPConsentStore {
  isApproved(name: string): Promise<boolean>;
  approve(name: string, approvedAt?: string): Promise<void>;
  revoke(name: string): Promise<boolean>;
  list(): Promise<readonly MCPConsentRecord[]>;
}

/**
 * User-scope record of which MCP servers the user has explicitly
 * consented to run. Keyed by server name only — swapping the transport
 * under the same name does NOT re-prompt, matching how plugin consent
 * behaves today. Tighten to a transport fingerprint if that turns out
 * to be the wrong trade-off.
 */
export function createMCPConsentStore(filePath: string): MCPConsentStore {
  async function read(): Promise<MCPConsentShape> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as MCPConsentShape;
      if (parsed.version !== STORE_VERSION) {
        throw new Error(
          `${filePath}: unsupported mcp-consent version ${parsed.version}; expected ${STORE_VERSION}`,
        );
      }
      return { version: STORE_VERSION, approved: parsed.approved ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: STORE_VERSION, approved: [] };
      }
      throw err;
    }
  }

  async function write(state: MCPConsentShape): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  }

  return {
    async isApproved(name) {
      const state = await read();
      return state.approved.some((r) => r.name === name);
    },
    async approve(name, approvedAt) {
      const state = await read();
      const ts = approvedAt ?? new Date().toISOString();
      const idx = state.approved.findIndex((r) => r.name === name);
      if (idx === -1) state.approved.push({ name, approvedAt: ts });
      else state.approved[idx] = { name, approvedAt: ts };
      await write(state);
    },
    async revoke(name) {
      const state = await read();
      const next = state.approved.filter((r) => r.name !== name);
      if (next.length === state.approved.length) return false;
      state.approved = next;
      await write(state);
      return true;
    },
    async list() {
      const state = await read();
      return state.approved;
    },
  };
}

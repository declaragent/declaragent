/**
 * MCP runtime wiring for `declaragent up` + `fleet-run`.
 *
 * Loads MCP server configs from three scopes, spawns each via the
 * existing stdio client, wraps `listTools()` results as runtime `Tool`s
 * (`mcp__<server>__<tool>`), and returns a shutdown hook. Match for the
 * MCP story Claude Code ships.
 *
 * Scope precedence when the same server name appears in multiple files:
 *   local > project > user
 *
 * Consent gate (Slice 2a):
 *   - Interactive boot: un-consented server triggers the Ink consent UI
 *     exactly once. Approve → persisted to `~/.declaragent/mcp-consent.json`.
 *     Reject → server is skipped for this boot.
 *   - Non-interactive boot (detached / CI): un-consented server is
 *     skipped with a warning. Already-consented servers run normally.
 *
 * @since 0.5.0-slice.2a
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Logger, MCPClient, PluginMCPServerSpec, Tool } from '@declaragent/core';
import { createHTTPMCPClient, createMCPTool, createStdioMCPClient } from '@declaragent/core';
import type { MCPConsentStore } from './mcp-consent.js';
import { createMCPConsentStore } from './mcp-consent.js';
import {
  configDir,
  mcpConfigPath,
  mcpConsentPath,
  mcpLocalConfigPath,
  mcpProjectConfigPath,
} from './paths.js';

export type MCPScope = 'user' | 'project' | 'local';

export interface ScopedMCPServer {
  spec: PluginMCPServerSpec;
  scope: MCPScope;
  /** Absolute path the spec was loaded from; surfaced in errors. */
  sourcePath: string;
}

export interface LoadScopedMCPServersOptions {
  /** Agent scaffold dir — used for project + local scopes. */
  agentDir: string;
  /** Test seam for `~/.declaragent`. Defaults to `configDir()`. */
  userConfigDir?: string;
}

interface MCPConfigShape {
  version?: number;
  servers?: PluginMCPServerSpec[];
}

async function readMcpFile(path: string): Promise<PluginMCPServerSpec[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as MCPConfigShape;
  return parsed.servers ?? [];
}

/**
 * Merge user + project + local MCP configs into a deduped list. The
 * returned order is the order they'll be spawned in — local/project
 * wins on name collision with user.
 */
export async function loadScopedMCPServers(
  opts: LoadScopedMCPServersOptions,
): Promise<readonly ScopedMCPServer[]> {
  const userDir = opts.userConfigDir ?? configDir();
  const userPath = mcpConfigPath(userDir);
  const projectPath = mcpProjectConfigPath(opts.agentDir);
  const localPath = mcpLocalConfigPath(opts.agentDir);

  const [userServers, projectServers, localServers] = await Promise.all([
    readMcpFile(userPath),
    readMcpFile(projectPath),
    readMcpFile(localPath),
  ]);

  const byName = new Map<string, ScopedMCPServer>();
  for (const s of userServers) byName.set(s.name, { spec: s, scope: 'user', sourcePath: userPath });
  for (const s of projectServers) {
    byName.set(s.name, { spec: s, scope: 'project', sourcePath: projectPath });
  }
  for (const s of localServers) {
    byName.set(s.name, { spec: s, scope: 'local', sourcePath: localPath });
  }
  return [...byName.values()];
}

/** Result of a successful MCP spawn pass. */
export interface MCPRuntime {
  /** Wrapped MCP tools ready to pass into `createEngine`. */
  tools: readonly Tool[];
  /** Servers that were skipped (consent denied, spawn failed, etc.). Useful for banner output. */
  skipped: readonly { name: string; scope: MCPScope; reason: string }[];
  /** Close every running client. Idempotent. */
  shutdown(): Promise<void>;
}

export type ConsentResolver = (spec: PluginMCPServerSpec, scope: MCPScope) => Promise<boolean>;

export interface StartMCPServersOptions {
  servers: readonly ScopedMCPServer[];
  logger: Logger;
  /**
   * Called per un-consented server. Implementations:
   *   - interactive CLI: render the Ink consent UI, return y/n
   *   - detached / CI: return false (caller treats that as "skip this server")
   * If omitted, all un-consented servers are skipped silently (safe default).
   */
  consent?: ConsentResolver;
  /** Test seam; defaults to the user-scope consent store. */
  consentStore?: MCPConsentStore;
  /** Test seam; defaults to `createStdioMCPClient` from core. */
  spawn?: (spec: PluginMCPServerSpec, logger: Logger) => MCPClient;
  /** Per-server init + listTools timeout. Defaults to 10s. */
  handshakeTimeoutMs?: number;
}

function defaultSpawn(spec: PluginMCPServerSpec, logger: Logger): MCPClient {
  if (spec.transport.type === 'stdio') {
    return createStdioMCPClient({
      name: spec.name,
      transport: spec.transport,
      protocolVersion: spec.protocolVersion,
      logger,
    });
  }
  if (spec.transport.type === 'http') {
    return createHTTPMCPClient({
      name: spec.name,
      transport: spec.transport,
      protocolVersion: spec.protocolVersion,
      logger,
    });
  }
  // TypeScript's exhaustive check — new transports land in 2c.
  const exhausted: never = spec.transport;
  throw new Error(`MCP server "${spec.name}": unsupported transport ${JSON.stringify(exhausted)}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Spawn each consented server, await `initialize()` + `listTools()` in
 * parallel, wrap every reported tool as a runtime `Tool`. Servers that
 * fail handshake are skipped with a warning — they don't block the boot.
 */
export async function startMCPServers(opts: StartMCPServersOptions): Promise<MCPRuntime> {
  const spawn = opts.spawn ?? defaultSpawn;
  const consentStore = opts.consentStore ?? createMCPConsentStore(mcpConsentPath());
  const timeoutMs = opts.handshakeTimeoutMs ?? 10_000;

  const tools: Tool[] = [];
  const clients: MCPClient[] = [];
  const skipped: { name: string; scope: MCPScope; reason: string }[] = [];

  // Phase 1: consent filtering. Serial because interactive prompts
  // should not overlap. Detached + auto-approved servers move through
  // near-instantly anyway.
  const approved: ScopedMCPServer[] = [];
  for (const s of opts.servers) {
    if (await consentStore.isApproved(s.spec.name)) {
      approved.push(s);
      continue;
    }
    if (!opts.consent) {
      skipped.push({
        name: s.spec.name,
        scope: s.scope,
        reason: 'awaiting-consent (run `declaragent mcp approve <name>` or boot interactively)',
      });
      opts.logger.warn('mcp.consent-missing', { name: s.spec.name, scope: s.scope });
      continue;
    }
    const ok = await opts.consent(s.spec, s.scope);
    if (!ok) {
      skipped.push({ name: s.spec.name, scope: s.scope, reason: 'consent-declined' });
      continue;
    }
    await consentStore.approve(s.spec.name);
    approved.push(s);
  }

  // Phase 2: spawn + handshake in parallel. Each is independently
  // timeboxed; a slow server doesn't delay the fast ones.
  const results = await Promise.all(
    approved.map(async (s) => {
      const childLog = opts.logger.child({ mcp: s.spec.name, scope: s.scope });
      try {
        const client = spawn(s.spec, childLog);
        await withTimeout(client.initialize(), timeoutMs, `mcp[${s.spec.name}].initialize`);
        const mcpTools = await withTimeout(
          client.listTools(),
          timeoutMs,
          `mcp[${s.spec.name}].listTools`,
        );
        const wrapped = mcpTools.map((t) =>
          createMCPTool({ serverName: s.spec.name, client, mcpTool: t }),
        );
        childLog.info('mcp.server-ready', { tools: wrapped.length });
        return { client, tools: wrapped, scope: s.scope, name: s.spec.name };
      } catch (err) {
        childLog.warn('mcp.server-failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        skipped.push({
          name: s.spec.name,
          scope: s.scope,
          reason: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }),
  );

  for (const r of results) {
    if (r === null) continue;
    clients.push(r.client);
    tools.push(...r.tools);
  }

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all(
      clients.map(async (c) => {
        try {
          await c.shutdown();
        } catch {
          // Best-effort shutdown.
        }
      }),
    );
  };

  return { tools, skipped, shutdown };
}

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
import type {
  CreateMCPSupervisorOptions,
  GetAuthHeaderFn,
  LoadedMCPSupervised,
  Logger,
  MCPClient,
  MCPLifecycleHandlers,
  MCPSupervisor,
  MetricsRegistry,
  OnAuthErrorFn,
  PluginMCPServerSpec,
  Tool,
} from '@declaragent/core';
import {
  createHTTPMCPClient,
  createMCPSupervisor,
  createMCPTool,
  createSSEMCPClient,
  createStdioMCPClient,
  createStreamableHTTPMCPClient,
} from '@declaragent/core';
import type { MCPConsentStore } from './mcp-consent.js';
import { createMCPConsentStore } from './mcp-consent.js';
import {
  type MCPOAuthTokenStore,
  bearerHeader,
  createMCPOAuthTokenStore,
  refreshMCPOAuthToken,
} from './mcp-oauth.js';
import {
  configDir,
  mcpConfigPath,
  mcpConsentPath,
  mcpLocalConfigPath,
  mcpProjectConfigPath,
  mcpTokensPath,
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
  /**
   * Look up a live MCP client by server name. Used by `@server:uri`
   * resource references to call `readResource()` at send-time.
   * Returns `undefined` for unknown names + for servers that were
   * skipped during boot (consent denied, spawn failed).
   *
   * @since 0.5.0-slice.2e
   */
  getClient(serverName: string): MCPClient | undefined;
  /**
   * Look up the supervisor for a server name. Present only when the
   * server was supervised (opt-in controlled by `agent.yaml#mcp.supervised`).
   * Returns `undefined` for un-supervised servers or unknown names.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #8
   */
  getSupervisor(serverName: string): MCPSupervisor | undefined;
  /** Servers that were skipped (consent denied, spawn failed, etc.). Useful for banner output. */
  skipped: readonly { name: string; scope: MCPScope; reason: string }[];
  /** Close every running client. Idempotent. */
  shutdown(): Promise<void>;
}

export type ConsentResolver = (spec: PluginMCPServerSpec, scope: MCPScope) => Promise<boolean>;

/**
 * Spawn hook signature. Accepts the supervisor-mandated lifecycle hooks
 * (forwarded into `createStdioMCPClient({ lifecycle, ... })`) when the
 * server is supervised; non-supervised callers may ignore both args.
 *
 * Kept backwards-compatible with pre-0.7.x two-argument callers — tests
 * that stub `spawn: (spec, logger) => fakeClient()` keep working because
 * the extra `lifecycle` / `clientOverrides` parameters are optional.
 */
export type SpawnMCPClientFn = (
  spec: PluginMCPServerSpec,
  logger: Logger,
  lifecycle?: MCPLifecycleHandlers,
  clientOverrides?: {
    readonly maxConsecutiveFailures: number;
    readonly backoffMs: (attempt: number) => number;
  },
) => MCPClient;

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
  /** Test seam; defaults to the user-scope OAuth token store. */
  oauthStore?: MCPOAuthTokenStore;
  /** Test seam; defaults to `createStdioMCPClient` from core. */
  spawn?: SpawnMCPClientFn;
  /** Per-server init + listTools timeout. Defaults to 10s. */
  handshakeTimeoutMs?: number;
  /**
   * MCP supervisor opt-in per `agent.yaml#mcp.supervised`. Defaults to
   * `'all'` — every consented server is wrapped in a supervisor that
   * drives respawn + circuit-breaker + tool-catalog re-registration.
   *
   * @since 0.7.x — Enterprise Production Plan §3 Item #8
   */
  supervised?: LoadedMCPSupervised;
  /**
   * Prometheus / metrics registry threaded into every supervisor so
   * `mcp_server_restarts_total` + `mcp_server_circuit_state` scrape
   * under the daemon's `/metrics` endpoint.
   */
  metrics?: MetricsRegistry;
  /**
   * Overrides for the supervisor factory itself. Test seam; production
   * callers leave these undefined.
   *
   * @since 0.7.x
   */
  supervisorOverrides?: Partial<
    Pick<
      CreateMCPSupervisorOptions,
      | 'pingIntervalMs'
      | 'pingFailureThreshold'
      | 'pingTimeoutMs'
      | 'backoffMs'
      | 'circuitThreshold'
      | 'circuitResetMs'
      | 'now'
      | 'sleep'
      | 'setTimer'
    >
  >;
}

/**
 * Decide whether a named server should be wrapped in the supervisor.
 * Exported for testability — the CLI gate matches what `loadAgent`
 * surfaces as `mcpSupervised`.
 *
 * `undefined` (no opt-in passed) defaults to `none` inside this runtime
 * module so existing in-process callers (tests, fleet-run harness) keep
 * the raw-client behaviour. The `up` CLI path passes the loaded
 * `mcpSupervised` explicitly, which defaults to `'all'` at the agent-
 * config layer — see `packages/core/src/agents/load-agent.ts`.
 */
export function isMCPSupervised(
  serverName: string,
  supervised: LoadedMCPSupervised | undefined,
): boolean {
  if (supervised === undefined) return false;
  if (supervised === 'all') return true;
  if (supervised === 'none') return false;
  return supervised.includes(serverName);
}

/**
 * Build OAuth callbacks for a single server name. `getAuthHeader` reads
 * the stored token on every request so token rotation is invisible to
 * the caller. `onAuthError` runs refresh_token grant on 401; if that
 * fails (or no refresh_token), returns false so the request fails back
 * to the caller + the user is prompted to re-run `mcp login <name>`.
 */
function makeAuthCallbacks(
  serverName: string,
  oauthStore: MCPOAuthTokenStore,
  logger: Logger,
): { getAuthHeader: GetAuthHeaderFn; onAuthError: OnAuthErrorFn } {
  return {
    getAuthHeader: async () => {
      const token = await oauthStore.get(serverName);
      return token ? bearerHeader(token) : undefined;
    },
    onAuthError: async () => {
      const token = await oauthStore.get(serverName);
      if (!token) return false;
      try {
        const refreshed = await refreshMCPOAuthToken(token);
        if (refreshed !== undefined) {
          await oauthStore.save(serverName, refreshed);
          return true;
        }
        logger.warn('mcp.oauth.refresh-unavailable', { serverName });
        return false;
      } catch (err) {
        logger.warn('mcp.oauth.refresh-failed', {
          serverName,
          err: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
  };
}

function makeDefaultSpawn(oauthStore: MCPOAuthTokenStore): SpawnMCPClientFn {
  return (spec, logger, lifecycle, clientOverrides) => {
    const baseArgs = {
      name: spec.name,
      protocolVersion: spec.protocolVersion,
      logger,
    } as const;
    if (spec.transport.type === 'stdio') {
      // Only the stdio client supports the supervisor lifecycle hooks;
      // HTTP/SSE/Streamable clients are managed by the supervisor via
      // ping + initialize re-checks only.
      return createStdioMCPClient({
        ...baseArgs,
        transport: spec.transport,
        ...(lifecycle !== undefined && { lifecycle }),
        ...(clientOverrides?.maxConsecutiveFailures !== undefined && {
          maxConsecutiveFailures: clientOverrides.maxConsecutiveFailures,
        }),
        ...(clientOverrides?.backoffMs !== undefined && {
          backoffMs: clientOverrides.backoffMs,
        }),
      });
    }
    const auth = makeAuthCallbacks(spec.name, oauthStore, logger);
    if (spec.transport.type === 'http') {
      return createHTTPMCPClient({ ...baseArgs, transport: spec.transport, ...auth });
    }
    if (spec.transport.type === 'sse') {
      return createSSEMCPClient({ ...baseArgs, transport: spec.transport, ...auth });
    }
    if (spec.transport.type === 'http-streamable') {
      return createStreamableHTTPMCPClient({ ...baseArgs, transport: spec.transport, ...auth });
    }
    const exhausted: never = spec.transport;
    throw new Error(
      `MCP server "${spec.name}": unsupported transport ${JSON.stringify(exhausted)}`,
    );
  };
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
  const oauthStore = opts.oauthStore ?? createMCPOAuthTokenStore(mcpTokensPath());
  const spawn = opts.spawn ?? makeDefaultSpawn(oauthStore);
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
  const supervisorsByName = new Map<string, MCPSupervisor>();
  const results = await Promise.all(
    approved.map(async (s) => {
      const childLog = opts.logger.child({ mcp: s.spec.name, scope: s.scope });
      const supervisedThis = isMCPSupervised(s.spec.name, opts.supervised);
      try {
        if (supervisedThis) {
          // Build a supervisor whose factory hands fresh clients on
          // every respawn. The supervisor drives the handshake +
          // listTools itself, so we don't need to pre-initialize.
          const supervisor = buildSupervisor({
            spec: s.spec,
            childLog,
            spawn,
            ...(opts.metrics !== undefined && { metrics: opts.metrics }),
            ...(opts.supervisorOverrides !== undefined && {
              overrides: opts.supervisorOverrides,
            }),
          });
          const ready = await withTimeout(
            supervisor.start(),
            timeoutMs,
            `mcp[${s.spec.name}].supervisor.start`,
          );
          // `start()` returns once the first spawn either succeeds or
          // its backoff loop give-up opens the circuit. Inspect state
          // to decide whether to surface tools.
          const snap = supervisor.snapshot();
          if (snap.state !== 'ready') {
            // Teardown so a degraded server doesn't keep respawning
            // while still reporting itself as "bound".
            await supervisor.stop();
            throw new Error(
              `MCP supervisor for "${s.spec.name}" failed to reach ready state (state=${snap.state}, circuit=${snap.circuit})`,
            );
          }
          void ready;
          const catalog = supervisor.currentTools();
          const wrapped = catalog.map((t) =>
            createMCPTool({ serverName: s.spec.name, supervisor, mcpTool: t }),
          );
          childLog.info('mcp.server-ready', { tools: wrapped.length, supervised: true });
          return {
            tools: wrapped,
            scope: s.scope,
            name: s.spec.name,
            supervisor,
            client: undefined,
          };
        }
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
        childLog.info('mcp.server-ready', { tools: wrapped.length, supervised: false });
        return {
          client,
          tools: wrapped,
          scope: s.scope,
          name: s.spec.name,
          supervisor: undefined,
        };
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

  const clientsByName = new Map<string, MCPClient>();
  const supervisors: MCPSupervisor[] = [];
  for (const r of results) {
    if (r === null) continue;
    if (r.client) {
      clients.push(r.client);
      clientsByName.set(r.name, r.client);
    }
    if (r.supervisor) {
      supervisors.push(r.supervisor);
      supervisorsByName.set(r.name, r.supervisor);
    }
    tools.push(...r.tools);
  }

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await Promise.all(
      supervisors.map(async (sup) => {
        try {
          await sup.stop();
        } catch {
          // best-effort
        }
      }),
    );
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

  return {
    tools,
    skipped,
    shutdown,
    getClient: (name) => clientsByName.get(name),
    getSupervisor: (name) => supervisorsByName.get(name),
  };
}

/**
 * Assemble an `MCPSupervisor` around the supplied `spawn` + spec. The
 * supervisor's factory hands the lifecycle hooks + recommended inner-
 * client overrides to the spawn each time a respawn fires.
 *
 * @since 0.7.x — Enterprise Production Plan §3 Item #8
 */
function buildSupervisor(opts: {
  spec: PluginMCPServerSpec;
  childLog: Logger;
  spawn: SpawnMCPClientFn;
  metrics?: MetricsRegistry;
  overrides?: StartMCPServersOptions['supervisorOverrides'];
}): MCPSupervisor {
  const { spec, childLog, spawn, metrics, overrides } = opts;
  const supervisorOpts: CreateMCPSupervisorOptions = {
    serverId: spec.name,
    protocolVersion: spec.protocolVersion,
    factory: (lifecycle, clientOverrides) => spawn(spec, childLog, lifecycle, clientOverrides),
    logger: childLog,
    ...(metrics !== undefined && { metrics }),
    ...(overrides?.pingIntervalMs !== undefined && { pingIntervalMs: overrides.pingIntervalMs }),
    ...(overrides?.pingFailureThreshold !== undefined && {
      pingFailureThreshold: overrides.pingFailureThreshold,
    }),
    ...(overrides?.pingTimeoutMs !== undefined && { pingTimeoutMs: overrides.pingTimeoutMs }),
    ...(overrides?.backoffMs !== undefined && { backoffMs: overrides.backoffMs }),
    ...(overrides?.circuitThreshold !== undefined && {
      circuitThreshold: overrides.circuitThreshold,
    }),
    ...(overrides?.circuitResetMs !== undefined && { circuitResetMs: overrides.circuitResetMs }),
    ...(overrides?.now !== undefined && { now: overrides.now }),
    ...(overrides?.sleep !== undefined && { sleep: overrides.sleep }),
    ...(overrides?.setTimer !== undefined && { setTimer: overrides.setTimer }),
    onToolsRegistered: (tools, ctx) => {
      childLog.info('mcp.supervisor.tools-registered', {
        serverId: ctx.serverId,
        tools: tools.length,
      });
    },
  };
  return createMCPSupervisor(supervisorOpts);
}

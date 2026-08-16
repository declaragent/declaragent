import type { Logger } from '../types/logger.js';
import { type JSONRPCConnection, JSONRPCError, TransportClosedError } from './jsonrpc.js';
import {
  type MCPClient,
  type MCPClientInfo,
  type MCPClientStatus,
  MCPClientUnavailableError,
  type MCPResourceContents,
  type MCPServerInfo,
  type MCPTool,
  type MCPToolResult,
  type StdioTransportConfig,
} from './types.js';

const DEFAULT_CLIENT_INFO: MCPClientInfo = { name: 'declaragent', version: '0.0.1' };
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_CAP_MS = 30_000;

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

export type ConnectFn = () => Promise<JSONRPCConnection>;

/**
 * Reason a lifecycle `exit` event fired. `'shutdown'` is graceful
 * (`client.shutdown()` called). `'transport-closed'` is an unexpected
 * close — the supervisor treats this as a crash signal. `'init-failed'`
 * is a failed handshake before we reached `ready`. `'restart-failed'`
 * is a failed respawn attempt from inside the restart loop.
 */
export type MCPLifecycleExitReason =
  | 'shutdown'
  | 'transport-closed'
  | 'init-failed'
  | 'restart-failed';

/**
 * Lifecycle events emitted by the MCP client. Non-breaking — existing
 * consumers that don't pass a `lifecycle` handler block continue to work
 * unchanged. The supervisor (`@declaragent/core/mcp/supervisor`) uses
 * these to drive respawn + circuit-breaker semantics.
 *
 * @since 0.7.0
 */
export interface MCPLifecycleHandlers {
  /** Fires after a fresh session has completed its handshake + is `ready`. */
  onSpawn?: (info: MCPServerInfo) => void;
  /** Fires when a previously-ready session terminates. */
  onExit?: (reason: MCPLifecycleExitReason, err?: unknown) => void;
  /** Fires on transport-level errors (as surfaced by `connection.onError`). */
  onError?: (err: unknown) => void;
}

export interface CreateMCPClientOptions {
  /** User-chosen short id; surfaced in errors and logs. */
  name: string;
  protocolVersion: string;
  clientInfo?: MCPClientInfo;
  /**
   * Establishes a fresh `JSONRPCConnection` on initial connect and on
   * each restart attempt. Slice 2 supplies a `Bun.spawn` factory; tests
   * supply paired in-memory connections.
   */
  connect: ConnectFn;
  /** Default 5. Status flips to `failed` when this many consecutive starts fail. */
  maxConsecutiveFailures?: number;
  /** Custom backoff (default: 500ms × 2^N capped at 30s). */
  backoffMs?: (attempt: number) => number;
  /** Test seam for backoff sleep. Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /**
   * Opt-in lifecycle hooks. Supplied by the MCP supervisor to observe
   * spawn / exit / transport-error events. Handler errors are caught
   * and logged — a misbehaving listener never wedges the client.
   *
   * @since 0.7.0
   */
  lifecycle?: MCPLifecycleHandlers;
}

export function defaultBackoff(attempt: number): number {
  const ms = DEFAULT_BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(ms, DEFAULT_BACKOFF_CAP_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ActiveSession {
  connection: JSONRPCConnection;
  serverInfo: MCPServerInfo;
  unsubscribeNotifications: () => void;
}

export function createMCPClient(options: CreateMCPClientOptions): MCPClient {
  const logger = (options.logger ?? NOOP_LOGGER).child({ mcp: options.name });
  const maxFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES;
  const backoff = options.backoffMs ?? defaultBackoff;
  const sleep = options.sleep ?? defaultSleep;
  const clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
  const lifecycle = options.lifecycle ?? {};
  const toolsChangedHandlers = new Set<() => void>();

  function emitSpawn(info: MCPServerInfo): void {
    if (!lifecycle.onSpawn) return;
    try {
      lifecycle.onSpawn(info);
    } catch (err) {
      logger.warn('mcp.lifecycle.spawn.error', { err: String(err) });
    }
  }
  function emitExit(reason: MCPLifecycleExitReason, err?: unknown): void {
    if (!lifecycle.onExit) return;
    try {
      lifecycle.onExit(reason, err);
    } catch (cbErr) {
      logger.warn('mcp.lifecycle.exit.error', { err: String(cbErr) });
    }
  }
  function emitError(err: unknown): void {
    if (!lifecycle.onError) return;
    try {
      lifecycle.onError(err);
    } catch (cbErr) {
      logger.warn('mcp.lifecycle.error.error', { err: String(cbErr) });
    }
  }

  let status: MCPClientStatus = 'starting';
  let session: ActiveSession | undefined;
  let toolsCache: readonly MCPTool[] | undefined;
  let initPromise: Promise<MCPServerInfo> | undefined;
  let consecutiveFailures = 0;
  let stopped = false;

  function setStatus(next: MCPClientStatus): void {
    if (status === next) return;
    logger.debug('mcp.status', { from: status, to: next });
    status = next;
  }

  async function startSession(): Promise<ActiveSession> {
    const connection = await options.connect();

    connection.onError((err) => {
      logger.warn('mcp.transport.error', { err: String(err) });
      emitError(err);
    });

    const unsubscribeNotifications = connection.onNotification((method) => {
      if (method === 'notifications/tools/list_changed') {
        toolsCache = undefined;
        for (const h of toolsChangedHandlers) {
          try {
            h();
          } catch (err) {
            logger.warn('mcp.toolsChanged.handler.error', { err: String(err) });
          }
        }
      }
    });

    let initResult: unknown;
    try {
      initResult = await connection.request('initialize', {
        protocolVersion: options.protocolVersion,
        capabilities: {},
        clientInfo,
      });
    } catch (err) {
      unsubscribeNotifications();
      await connection.close().catch(() => {});
      throw err;
    }

    const serverInfo = parseInitResult(initResult);
    await connection.notify('notifications/initialized');

    // Watch for unexpected closure → trigger restart.
    void connection.closed.then(() => {
      if (stopped) return;
      if (session?.connection === connection) {
        logger.warn('mcp.connection.closed.unexpected');
        session = undefined;
        toolsCache = undefined;
        emitExit('transport-closed');
        scheduleRestart();
      }
    });

    return { connection, serverInfo, unsubscribeNotifications };
  }

  function scheduleRestart(): void {
    if (stopped) return;
    setStatus('reconnecting');
    void (async () => {
      while (!stopped && consecutiveFailures < maxFailures) {
        const attempt = consecutiveFailures;
        const delay = backoff(attempt);
        logger.info('mcp.restart.attempt', { attempt, delayMs: delay });
        await sleep(delay);
        if (stopped) return;
        try {
          session = await startSession();
          consecutiveFailures = 0;
          setStatus('ready');
          emitSpawn(session.serverInfo);
          return;
        } catch (err) {
          consecutiveFailures++;
          logger.warn('mcp.restart.failed', { attempt, err: String(err) });
          emitExit('restart-failed', err);
        }
      }
      if (!stopped) {
        setStatus('failed');
      }
    })();
  }

  async function ensureSession(): Promise<ActiveSession> {
    if (session) return session;
    if (stopped) throw new MCPClientUnavailableError(options.name, 'stopped');
    if (status === 'failed') throw new MCPClientUnavailableError(options.name, 'failed');
    if (!initPromise) {
      initPromise = (async () => {
        try {
          session = await startSession();
          consecutiveFailures = 0;
          setStatus('ready');
          emitSpawn(session.serverInfo);
          return session.serverInfo;
        } catch (err) {
          consecutiveFailures++;
          emitExit('init-failed', err);
          if (consecutiveFailures >= maxFailures) {
            setStatus('failed');
          } else {
            scheduleRestart();
          }
          throw err;
        } finally {
          initPromise = undefined;
        }
      })();
    }
    await initPromise;
    if (!session) throw new MCPClientUnavailableError(options.name, status);
    return session;
  }

  return {
    get status() {
      return status;
    },
    get serverInfo() {
      return session?.serverInfo;
    },

    async initialize() {
      const s = await ensureSession();
      return s.serverInfo;
    },

    async listTools() {
      const s = await ensureSession();
      if (toolsCache) return toolsCache;
      const result = await s.connection.request('tools/list');
      toolsCache = parseToolsList(result);
      return toolsCache;
    },

    async callTool(name, input, signal) {
      const s = await ensureSession();
      const result = await s.connection.request(
        'tools/call',
        { name, arguments: input ?? {} },
        signal,
      );
      return parseToolResult(result);
    },

    async readResource(uri, signal) {
      const s = await ensureSession();
      const result = await s.connection.request('resources/read', { uri }, signal);
      return parseResourceRead(result);
    },

    async shutdown() {
      if (stopped) return;
      stopped = true;
      setStatus('stopped');
      const current = session;
      session = undefined;
      toolsCache = undefined;
      if (!current) return;
      current.unsubscribeNotifications();
      try {
        await current.connection.close();
      } catch (err) {
        logger.warn('mcp.shutdown.error', { err: String(err) });
      }
      emitExit('shutdown');
    },

    onToolsChanged(handler) {
      toolsChangedHandlers.add(handler);
      return () => {
        toolsChangedHandlers.delete(handler);
      };
    },
  };
}

function parseInitResult(result: unknown): MCPServerInfo {
  if (typeof result !== 'object' || result === null) {
    throw new Error('initialize: expected object result');
  }
  const r = result as Record<string, unknown>;
  const protocolVersion = r.protocolVersion;
  const serverInfo = r.serverInfo as Record<string, unknown> | undefined;
  const capabilities = r.capabilities as Record<string, unknown> | undefined;
  if (typeof protocolVersion !== 'string') {
    throw new Error('initialize: missing protocolVersion');
  }
  return {
    protocolVersion,
    name: typeof serverInfo?.name === 'string' ? serverInfo.name : 'unknown',
    version: typeof serverInfo?.version === 'string' ? serverInfo.version : '0.0.0',
    capabilities: capabilities ?? {},
  };
}

function parseToolsList(result: unknown): readonly MCPTool[] {
  if (typeof result !== 'object' || result === null) {
    throw new Error('tools/list: expected object result');
  }
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    throw new Error('tools/list: missing tools array');
  }
  return tools.map((t, i): MCPTool => {
    if (typeof t !== 'object' || t === null) {
      throw new Error(`tools/list[${i}]: expected object`);
    }
    const obj = t as Record<string, unknown>;
    if (typeof obj.name !== 'string') {
      throw new Error(`tools/list[${i}]: missing name`);
    }
    return {
      name: obj.name,
      ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
      inputSchema:
        typeof obj.inputSchema === 'object' && obj.inputSchema !== null
          ? (obj.inputSchema as Record<string, unknown>)
          : { type: 'object' },
    };
  });
}

function parseToolResult(result: unknown): MCPToolResult {
  if (typeof result !== 'object' || result === null) {
    throw new Error('tools/call: expected object result');
  }
  const r = result as Record<string, unknown>;
  const content = Array.isArray(r.content) ? (r.content as MCPToolResult['content']) : [];
  return {
    content,
    ...(typeof r.isError === 'boolean' ? { isError: r.isError } : {}),
  };
}

function parseResourceRead(result: unknown): readonly MCPResourceContents[] {
  if (typeof result !== 'object' || result === null) {
    throw new Error('resources/read: expected object result');
  }
  const contents = (result as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) {
    throw new Error('resources/read: missing contents array');
  }
  return contents.map((c, i): MCPResourceContents => {
    if (typeof c !== 'object' || c === null) {
      throw new Error(`resources/read[${i}]: expected object`);
    }
    const obj = c as Record<string, unknown>;
    if (typeof obj.uri !== 'string') {
      throw new Error(`resources/read[${i}]: missing uri`);
    }
    return {
      uri: obj.uri,
      ...(typeof obj.mimeType === 'string' ? { mimeType: obj.mimeType } : {}),
      ...(typeof obj.text === 'string' ? { text: obj.text } : {}),
      ...(typeof obj.blob === 'string' ? { blob: obj.blob } : {}),
    };
  });
}

/**
 * Build a `connect` factory backed by a child process spawned with Bun.
 * Each invocation spawns a fresh subprocess and wires its stdio into a
 * `JSONRPCConnection`.
 */
/** Grace between SIGTERM on close and the SIGKILL fallback (THREAT_MODEL §kill-on-shutdown). */
export const STDIO_KILL_GRACE_MS = 5_000;

export function createStdioConnectFn(
  config: StdioTransportConfig,
  logger: Logger = NOOP_LOGGER,
  killGraceMs: number = STDIO_KILL_GRACE_MS,
): ConnectFn {
  // Lazy-import the runtime dependency so this module is still importable
  // outside Bun (e.g. for typechecking under tsc).
  return async () => {
    // Bun is provided by the runtime; reference globally to avoid a hard import.
    const bunGlobal = (globalThis as { Bun?: typeof import('bun') }).Bun;
    if (!bunGlobal) {
      throw new Error('createStdioConnectFn requires the Bun runtime');
    }
    const proc = bunGlobal.spawn({
      cmd: [config.command, ...(config.args ?? [])],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: config.env ? { ...process.env, ...config.env } : process.env,
    });

    if (!proc.stdout || !proc.stdin) {
      throw new Error(`failed to wire stdio for "${config.command}"`);
    }

    if (proc.stderr) {
      void (async () => {
        const decoder = new TextDecoder();
        try {
          for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
            const text = decoder.decode(chunk).trimEnd();
            if (text.length > 0) logger.debug('mcp.stderr', { line: text });
          }
        } catch {
          // ignore
        }
      })();
    }

    const stdin = proc.stdin as { write(buf: Uint8Array): number; flush(): void; end(): void };

    const { createJSONRPCConnection } = await importJSONRPC();
    const conn = createJSONRPCConnection({
      read: proc.stdout as ReadableStream<Uint8Array>,
      write: (chunk) => {
        stdin.write(chunk);
        stdin.flush();
      },
      closeWrite: () => {
        stdin.end();
      },
    });
    // Kill-on-shutdown (THREAT_MODEL): closing the adapter must not leave
    // the child running. SIGTERM immediately alongside the graceful close,
    // SIGKILL if the process is still alive after the grace window — a
    // hung server can otherwise stall `conn.close()` forever (it waits
    // for reader EOF).
    return {
      ...conn,
      close: async () => {
        const drained = conn.close().catch(() => {});
        try {
          proc.kill('SIGTERM');
        } catch {
          // already exited
        }
        const graceTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already exited
          }
        }, killGraceMs);
        (graceTimer as unknown as { unref?: () => void }).unref?.();
        await (proc.exited as Promise<unknown>).catch(() => {});
        clearTimeout(graceTimer);
        await drained;
      },
    };
  };
}

// Local re-import indirection so createStdioConnectFn doesn't pull
// jsonrpc.ts into module init order issues during tests.
async function importJSONRPC(): Promise<typeof import('./jsonrpc.js')> {
  return import('./jsonrpc.js');
}

export interface CreateStdioMCPClientOptions {
  name: string;
  transport: StdioTransportConfig;
  protocolVersion: string;
  clientInfo?: MCPClientInfo;
  maxConsecutiveFailures?: number;
  backoffMs?: (attempt: number) => number;
  logger?: Logger;
  /**
   * Optional lifecycle hooks forwarded to `createMCPClient`. Used by the
   * supervisor to observe spawn / exit / transport-error events.
   *
   * @since 0.7.0
   */
  lifecycle?: MCPLifecycleHandlers;
}

export function createStdioMCPClient(options: CreateStdioMCPClientOptions): MCPClient {
  return createMCPClient({
    name: options.name,
    protocolVersion: options.protocolVersion,
    connect: createStdioConnectFn(options.transport, options.logger),
    ...(options.clientInfo === undefined ? {} : { clientInfo: options.clientInfo }),
    ...(options.maxConsecutiveFailures === undefined
      ? {}
      : { maxConsecutiveFailures: options.maxConsecutiveFailures }),
    ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
  });
}

// Re-export error types so downstream code (slice 3 tool adapter) can
// `instanceof`-check without importing both modules.
export { JSONRPCError, MCPClientUnavailableError, TransportClosedError };

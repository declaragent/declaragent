import type { Logger } from '../types/logger.js';
import { type JSONRPCConnection, JSONRPCError, TransportClosedError } from './jsonrpc.js';
import {
  type MCPClient,
  type MCPClientInfo,
  type MCPClientStatus,
  MCPClientUnavailableError,
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
  const toolsChangedHandlers = new Set<() => void>();

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
          return;
        } catch (err) {
          consecutiveFailures++;
          logger.warn('mcp.restart.failed', { attempt, err: String(err) });
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
          return session.serverInfo;
        } catch (err) {
          consecutiveFailures++;
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

/**
 * Build a `connect` factory backed by a child process spawned with Bun.
 * Each invocation spawns a fresh subprocess and wires its stdio into a
 * `JSONRPCConnection`.
 */
export function createStdioConnectFn(
  config: StdioTransportConfig,
  logger: Logger = NOOP_LOGGER,
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

    return importJSONRPC().then(({ createJSONRPCConnection }) =>
      createJSONRPCConnection({
        read: proc.stdout as ReadableStream<Uint8Array>,
        write: (chunk) => {
          stdin.write(chunk);
          stdin.flush();
        },
        closeWrite: () => {
          stdin.end();
        },
      }),
    );
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
  });
}

// Re-export error types so downstream code (slice 3 tool adapter) can
// `instanceof`-check without importing both modules.
export { JSONRPCError, MCPClientUnavailableError, TransportClosedError };

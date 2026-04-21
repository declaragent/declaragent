import type { JSONSchema } from '../types/tool.js';

export interface MCPClientInfo {
  name: string;
  version: string;
}

export interface MCPServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
}

export type MCPContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } };

export interface MCPToolResult {
  content: MCPContent[];
  isError?: boolean;
}

export type MCPClientStatus = 'starting' | 'ready' | 'reconnecting' | 'failed' | 'stopped';

export type StdioTransportConfig = {
  type: 'stdio';
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
};

export type HTTPTransportConfig = {
  type: 'http';
  url: string;
  headers?: Readonly<Record<string, string>>;
};

/**
 * Older MCP remote transport (2024-11-05 spec). Client opens an SSE
 * stream via GET to receive server→client messages; outbound
 * client→server messages are POST'd to a per-session endpoint URL
 * advertised by the server in the first SSE `endpoint` frame.
 */
export type SSETransportConfig = {
  type: 'sse';
  url: string;
  headers?: Readonly<Record<string, string>>;
};

/**
 * Current MCP remote transport (2025-03-26 spec). A single URL handles
 * both directions: client POSTs a JSON-RPC message and the response
 * is either a single JSON body OR a `text/event-stream` with one or
 * more JSON-RPC frames (the matching response + any notifications the
 * server wants to piggyback).
 */
export type StreamableHTTPTransportConfig = {
  type: 'http-streamable';
  url: string;
  headers?: Readonly<Record<string, string>>;
};

export type MCPTransportConfig =
  | StdioTransportConfig
  | HTTPTransportConfig
  | SSETransportConfig
  | StreamableHTTPTransportConfig;

/** User-facing config (from `agent.yaml` or plugin manifest in slice 6). */
export interface MCPServerConfig {
  /** Short id; namespaces tools as `mcp__<name>__<tool>`. */
  name: string;
  transport: MCPTransportConfig;
  /** Pinned protocol version (e.g. `"2024-11-05"`). */
  protocolVersion: string;
}

/**
 * A single resource entry returned by `resources/read`. MCP allows a
 * resource response to span multiple segments (text + binary mixed),
 * each tagged with its own MIME type.
 */
export interface MCPResourceContents {
  uri: string;
  mimeType?: string;
  /** Present when the segment is utf-8 text. */
  text?: string;
  /** Present when the segment is binary; base64-encoded per MCP spec. */
  blob?: string;
}

export interface MCPClient {
  /** Run handshake. Idempotent. */
  initialize(): Promise<MCPServerInfo>;
  /** Cached after first call; refreshed on `notifications/tools/list_changed`. */
  listTools(): Promise<readonly MCPTool[]>;
  callTool(name: string, input: unknown, signal?: AbortSignal): Promise<MCPToolResult>;
  /**
   * Read a resource by URI via the MCP `resources/read` method. Used by
   * `@<server>:<uri>` references in skill / REPL prompts — the runtime
   * fetches the resource at send-time and inlines the text into the
   * model input.
   *
   * @since 0.5.0-slice.2e
   */
  readResource(uri: string, signal?: AbortSignal): Promise<readonly MCPResourceContents[]>;
  /** Graceful close + best-effort process teardown. Idempotent. */
  shutdown(): Promise<void>;
  readonly status: MCPClientStatus;
  readonly serverInfo: MCPServerInfo | undefined;
  /** Subscribe to tool-list changes. Returns unsubscribe fn. */
  onToolsChanged(handler: () => void): () => void;
}

export class MCPClientUnavailableError extends Error {
  readonly code = 'EMCPUNAVAIL';
  constructor(serverName: string, status: MCPClientStatus) {
    super(`MCP server "${serverName}" is unavailable (status: ${status})`);
    this.name = 'MCPClientUnavailableError';
  }
}

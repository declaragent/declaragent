import { toolExtension } from '../extension/tool-extension.js';
import type { Extension, ExtensionSource } from '../extension/types.js';
import type { Tool, ToolContext, ToolEvent } from '../types/tool.js';
import { JSONRPCError } from './jsonrpc.js';
import {
  type MCPClient,
  MCPClientUnavailableError,
  type MCPTool,
  type MCPToolResult,
} from './types.js';

export interface CreateMCPToolOptions {
  /** Short server id used to namespace the tool name. */
  serverName: string;
  /** Live MCP client to forward `tools/call` through. */
  client: MCPClient;
  /** Tool definition reported by the server's `tools/list`. */
  mcpTool: MCPTool;
}

/**
 * Wrap an MCP tool advertisement as a core `Tool`. The full name is
 * `mcp__<server>__<tool>` so multiple MCP servers can coexist without
 * collisions. Schema is passed through verbatim.
 *
 * Permission keying: per Phase-2 plan §13.1 lean (a), the key is the
 * empty string — the tool name itself is the permission identity. Users
 * write rules like `mcp__github__create_pr:*` (or `mcp__github__*:*` to
 * allow a whole server). Per-input gating is deferred until the protocol
 * supports a server-declared `permissionKeyPath`.
 */
export function createMCPTool(options: CreateMCPToolOptions): Tool {
  const { serverName, client, mcpTool } = options;
  const fullName = mcpToolName(serverName, mcpTool.name);
  return {
    name: fullName,
    description: mcpTool.description ?? '',
    inputSchema: mcpTool.inputSchema,
    permissionKey: () => '',
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      try {
        const result = await client.callTool(mcpTool.name, input ?? {}, ctx.abortSignal);
        if (result.isError === true) {
          yield {
            type: 'error',
            error: {
              code: 'EMCPTOOLERR',
              message: extractText(result) || `${fullName}: tool reported an error`,
            },
          };
          return;
        }
        yield { type: 'result', output: extractOutput(result) };
      } catch (err) {
        yield { type: 'error', error: errorFromException(fullName, err) };
      }
    },
  };
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Wrap every tool currently advertised by a server as an `Extension<'tool'>`,
 * ready for `ExtensionRegistry.register()`. Caller supplies the source
 * (`plugin`, `user`, etc.) so audit trails are accurate.
 *
 * The list is captured at call time. Slice 6's plugin loader will re-call
 * this on `notifications/tools/list_changed` (subscribe via
 * `client.onToolsChanged`).
 */
export async function listMCPToolExtensions(options: {
  serverName: string;
  client: MCPClient;
  source: ExtensionSource;
}): Promise<Extension<'tool'>[]> {
  const tools = await options.client.listTools();
  return tools.map((mcpTool) =>
    toolExtension(
      createMCPTool({ serverName: options.serverName, client: options.client, mcpTool }),
      options.source,
    ),
  );
}

function extractText(result: MCPToolResult): string {
  return result.content
    .filter(
      (c): c is Extract<MCPToolResult['content'][number], { type: 'text' }> => c.type === 'text',
    )
    .map((c) => c.text)
    .join('\n');
}

/**
 * Normalize the MCP result for the engine. Text-only results return a
 * plain string (matches what built-in tools yield). Mixed/structured
 * content returns the raw `content[]` so the model sees image/resource
 * entries verbatim.
 */
function extractOutput(result: MCPToolResult): unknown {
  const allText = result.content.every((c) => c.type === 'text');
  if (allText) return extractText(result);
  return result.content;
}

function errorFromException(toolName: string, err: unknown): { code: string; message: string } {
  if (err instanceof MCPClientUnavailableError) {
    return { code: 'EMCPUNAVAIL', message: err.message };
  }
  if (err instanceof JSONRPCError) {
    return { code: 'EMCPRPC', message: `${toolName}: ${err.message}` };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { code: 'EABORT', message: `${toolName}: aborted` };
  }
  if (err instanceof Error) {
    return { code: 'EMCPCALL', message: `${toolName}: ${err.message}` };
  }
  return { code: 'EMCPCALL', message: `${toolName}: ${String(err)}` };
}

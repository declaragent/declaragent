import type { PluginMCPServerSpec } from '@declaragent/core';
import { type MCPConfigStore, createMCPConfigStore } from './mcp-config.js';
import { mcpConfigPath } from './paths.js';

export interface MCPCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: MCPCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

interface MCPCliOptions {
  io?: MCPCliIO;
  store?: MCPConfigStore;
}

function getStore(options: MCPCliOptions): MCPConfigStore {
  return options.store ?? createMCPConfigStore(mcpConfigPath());
}

export interface MCPAddArgs {
  name: string;
  command: string;
  args?: readonly string[];
  protocolVersion?: string;
  env?: Readonly<Record<string, string>>;
}

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/**
 * `declaragent mcp add <name> --command <cmd> [--args a,b,c]`
 *
 * Slice 7 ships flag-based add only. The plan calls for an interactive
 * Ink picker for stdio/http; that lands in slice 8 alongside the consent
 * UI which has its own Ink polish pass.
 */
export async function mcpAdd(args: MCPAddArgs, options: MCPCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const store = getStore(options);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(args.name)) {
    io.err(`✗ invalid name "${args.name}" — must be alphanumeric, '-', '_'\n`);
    return 1;
  }
  const spec: PluginMCPServerSpec = {
    name: args.name,
    transport: {
      type: 'stdio',
      command: args.command,
      ...(args.args && args.args.length > 0 ? { args: [...args.args] } : {}),
      ...(args.env ? { env: { ...args.env } } : {}),
    },
    protocolVersion: args.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
  };
  await store.add(spec);
  io.out(`✓ added MCP server "${args.name}"\n`);
  io.out(`  command: ${args.command}${args.args?.length ? ` ${args.args.join(' ')}` : ''}\n`);
  io.out(`  protocol: ${spec.protocolVersion}\n`);
  return 0;
}

/** `declaragent mcp list` — shows configured servers (status is "configured" — live status requires a running REPL). */
export async function mcpList(options: MCPCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const store = getStore(options);
  const servers = await store.list();
  if (servers.length === 0) {
    io.out('no MCP servers configured.\n');
    return 0;
  }
  io.out(`MCP servers (${servers.length}):\n`);
  for (const s of servers) {
    io.out(`  ${s.name}  [${s.transport.type}]\n`);
    if (s.transport.type === 'stdio') {
      const argList = s.transport.args?.length ? ` ${s.transport.args.join(' ')}` : '';
      io.out(`    command: ${s.transport.command}${argList}\n`);
    } else {
      io.out(`    url: ${s.transport.url}\n`);
    }
    io.out(`    protocol: ${s.protocolVersion}\n`);
  }
  return 0;
}

/** `declaragent mcp remove <name>` */
export async function mcpRemove(name: string, options: MCPCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const store = getStore(options);
  const removed = await store.remove(name);
  if (!removed) {
    io.err(`✗ MCP server "${name}" not configured\n`);
    return 1;
  }
  io.out(`✓ removed ${name}\n`);
  return 0;
}

import type { PluginMCPServerSpec } from '@declaragent/core';
import { type MCPConfigStore, createMCPConfigStore } from './mcp-config.js';
import { type MCPConsentStore, createMCPConsentStore } from './mcp-consent.js';
import { type MCPOAuthTokenStore, createMCPOAuthTokenStore, runMCPOAuthFlow } from './mcp-oauth.js';
import { type MCPScope, loadScopedMCPServers } from './mcp-runtime.js';
import {
  mcpConfigPath,
  mcpConsentPath,
  mcpLocalConfigPath,
  mcpProjectConfigPath,
  mcpTokensPath,
} from './paths.js';

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
  /** Scope selector for the operation. Defaults to `user`. */
  scope?: MCPScope;
  /** Agent dir to anchor project/local scope writes. Defaults to cwd. */
  cwd?: string;
  consentStore?: MCPConsentStore;
  oauthStore?: MCPOAuthTokenStore;
}

function resolveStorePath(scope: MCPScope, cwd: string): string {
  if (scope === 'user') return mcpConfigPath();
  if (scope === 'project') return mcpProjectConfigPath(cwd);
  return mcpLocalConfigPath(cwd);
}

function getStore(options: MCPCliOptions): MCPConfigStore {
  if (options.store) return options.store;
  const scope = options.scope ?? 'user';
  const cwd = options.cwd ?? process.cwd();
  return createMCPConfigStore(resolveStorePath(scope, cwd));
}

function getConsentStore(options: MCPCliOptions): MCPConsentStore {
  return options.consentStore ?? createMCPConsentStore(mcpConsentPath());
}

function getOAuthStore(options: MCPCliOptions): MCPOAuthTokenStore {
  return options.oauthStore ?? createMCPOAuthTokenStore(mcpTokensPath());
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
  const scope = options.scope ?? 'user';
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
  // Running `mcp add` means the user is opting in to this server.
  // Auto-record consent so `up` doesn't re-prompt for a command the
  // user literally just typed.
  await getConsentStore(options).approve(args.name);
  io.out(`✓ added MCP server "${args.name}" [scope: ${scope}]\n`);
  io.out(`  command: ${args.command}${args.args?.length ? ` ${args.args.join(' ')}` : ''}\n`);
  io.out(`  protocol: ${spec.protocolVersion}\n`);
  return 0;
}

/**
 * `declaragent mcp approve <name>` — explicitly record consent for a
 * server whose config was added by someone else (e.g. a `.mcp.json`
 * pulled in via git). Needed when the user boots with `-d` + has MCP
 * servers that weren't yet consented; the detached child can't prompt.
 */
export async function mcpApprove(name: string, options: MCPCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  await getConsentStore(options).approve(name);
  io.out(`✓ MCP server "${name}" approved\n`);
  return 0;
}

/** `declaragent mcp revoke <name>` — opposite of approve. */
export async function mcpRevoke(name: string, options: MCPCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const removed = await getConsentStore(options).revoke(name);
  if (!removed) {
    io.err(`✗ MCP server "${name}" was not approved\n`);
    return 1;
  }
  io.out(`✓ MCP server "${name}" approval revoked\n`);
  return 0;
}

/**
 * `declaragent mcp login <name>` — run the OAuth PKCE flow against a
 * remote MCP server the user has configured. Token is persisted under
 * `~/.declaragent/mcp-oauth.json` (mode 0600) and automatically picked
 * up by `declaragent up` the next time the server is spawned.
 *
 * Resolves the server's config by walking the three scopes (user /
 * project / local) — so the verb works whether the config lives in
 * `~/.declaragent/mcp-servers.json` or the scaffold's `.mcp.json`.
 *
 * @since 0.5.0-slice.2d
 */
export async function mcpLogin(name: string, options: MCPCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const oauthStore = getOAuthStore(options);
  const cwd = options.cwd ?? process.cwd();
  const servers = await loadScopedMCPServers({ agentDir: cwd });
  const match = servers.find((s) => s.spec.name === name);
  if (!match) {
    io.err(
      `✗ no MCP server named "${name}" configured in any scope. Run \`declaragent mcp list\` to see what's available or add one with \`mcp add\`.\n`,
    );
    return 1;
  }
  if (match.spec.transport.type === 'stdio') {
    io.err(
      `✗ server "${name}" uses the stdio transport — OAuth is only meaningful for remote transports (http, sse, http-streamable).\n`,
    );
    return 1;
  }
  const url = match.spec.transport.url;
  io.out(`▸ logging in to MCP server "${name}" at ${url}\n`);
  try {
    const token = await runMCPOAuthFlow({
      resourceUrl: url,
      onUrl: (authUrl) => {
        io.out(`  opening browser: ${authUrl}\n`);
      },
    });
    await oauthStore.save(name, token);
    io.out(`✓ logged in to "${name}" — token stored\n`);
    if (token.scope) io.out(`  scope: ${token.scope}\n`);
    if (token.refresh_token) io.out('  refresh_token saved — future refreshes will be silent\n');
    return 0;
  } catch (err) {
    io.err(`✗ login failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** `declaragent mcp logout <name>` — delete stored OAuth credentials. */
export async function mcpLogout(name: string, options: MCPCliOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO;
  const removed = await getOAuthStore(options).remove(name);
  if (!removed) {
    io.err(`✗ no OAuth token stored for "${name}"\n`);
    return 1;
  }
  io.out(`✓ removed OAuth token for "${name}"\n`);
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

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(root = homedir()): string {
  const dir = join(root, '.declaragent');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionsDbPath(): string {
  return join(configDir(), 'sessions.db');
}

export function memoryFilePath(cwd = process.cwd()): string {
  return join(cwd, 'CLAUDE.md');
}

export function openRouterModelsCachePath(): string {
  return join(configDir(), 'openrouter-models.json');
}

export function historyFilePath(): string {
  return join(configDir(), 'history.jsonl');
}

/** Phase-2 paths. Each takes an optional override for tests. */
export function pluginStorePath(dir = configDir()): string {
  return join(dir, 'plugins.json');
}

export function mcpConfigPath(dir = configDir()): string {
  return join(dir, 'mcp-servers.json');
}

export function mcpConsentPath(dir = configDir()): string {
  return join(dir, 'mcp-consent.json');
}

/** Project-scope MCP config, git-tracked alongside `agent.yaml`. */
export function mcpProjectConfigPath(agentDir: string): string {
  return join(agentDir, '.mcp.json');
}

/** Local-scope MCP config, per-dev overrides (gitignored). */
export function mcpLocalConfigPath(agentDir: string): string {
  return join(agentDir, '.declaragent', 'mcp.local.json');
}

export function userSkillsDir(dir = configDir()): string {
  return join(dir, 'skills');
}

export function teamSkillsDir(cwd = process.cwd()): string {
  return join(cwd, '.declaragent', 'skills');
}

/** Phase-6 / Phase-7 paths (tenants, secrets, audit). */
export function tenantsConfigPath(dir = configDir()): string {
  return join(dir, 'tenants.yaml');
}

export function secretsConfigPath(dir = configDir()): string {
  return join(dir, 'secrets.yaml');
}

export function auditDbPath(dir = configDir()): string {
  return join(dir, 'audit.db');
}

/** Phase-3 paths (daemon, event sources). Each takes an optional override for tests. */
export function daemonSocketPath(dir = configDir()): string {
  return join(dir, 'daemon.sock');
}

export function daemonTokenPath(dir = configDir()): string {
  return join(dir, 'daemon.token');
}

export function daemonPidPath(dir = configDir()): string {
  return join(dir, 'daemon.pid');
}

export function eventSourcesConfigPath(dir = configDir()): string {
  return join(dir, 'event-sources.json');
}

/** Phase-5 paths. */
export function channelsConfigPath(dir = configDir()): string {
  return join(dir, 'channels.json');
}

export function whatsappTemplatesDir(dir = configDir()): string {
  const target = join(dir, 'whatsapp-templates');
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  return target;
}

export function whatsappTemplatesCachePath(channelId: string, dir = configDir()): string {
  return join(whatsappTemplatesDir(dir), `${channelId}.json`);
}

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.js';
import { getPreset, listPresets } from './providers-registry.js';

export interface ProviderCreds {
  apiKey?: string;
  /** Bearer token for OAuth flows. */
  authToken?: string;
  /** Override the preset's baseURL. */
  baseURL?: string;
  /** Last-used model for this provider. */
  model?: string;
}

export interface AuthConfig {
  /** Currently active provider id (must exist in `providers`). */
  active?: string;
  /** Per-provider credential map keyed by preset id. */
  providers?: Record<string, ProviderCreds>;
}

export type CredentialSource = 'env-var' | 'config' | 'preset-default'; // local provider with no key needed

export interface ResolvedCredentials {
  providerId: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  source: CredentialSource;
  envVar?: string;
}

export function configPath(dir = configDir()): string {
  return join(dir, 'config.json');
}

interface RawConfig {
  active?: string;
  providers?: Record<string, ProviderCreds>;
  // Legacy (pre-registry) fields. Migrated on load.
  anthropic?: ProviderCreds;
  openrouter?: ProviderCreds;
  apiKey?: string;
  authToken?: string;
}

function migrate(raw: RawConfig): AuthConfig {
  const providers: Record<string, ProviderCreds> = { ...(raw.providers ?? {}) };
  if (raw.anthropic && !providers.anthropic) providers.anthropic = raw.anthropic;
  if (raw.openrouter && !providers.openrouter) providers.openrouter = raw.openrouter;
  // Older flat schema: top-level apiKey/authToken meant Anthropic.
  if (!providers.anthropic && (raw.apiKey || raw.authToken)) {
    providers.anthropic = {
      ...(raw.apiKey !== undefined && { apiKey: raw.apiKey }),
      ...(raw.authToken !== undefined && { authToken: raw.authToken }),
    };
  }
  const out: AuthConfig = {};
  if (raw.active) out.active = raw.active;
  if (Object.keys(providers).length > 0) out.providers = providers;
  return out;
}

export function loadConfig(path = configPath()): AuthConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return migrate(JSON.parse(raw) as RawConfig);
  } catch {
    return null;
  }
}

export function saveConfig(config: AuthConfig, path = configPath()): void {
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore on filesystems without chmod (Windows)
  }
}

export function setProviderCreds(
  providerId: string,
  creds: ProviderCreds,
  path = configPath(),
): AuthConfig {
  const current = loadConfig(path) ?? {};
  const providers = { ...(current.providers ?? {}) };
  providers[providerId] = { ...providers[providerId], ...creds };
  const next: AuthConfig = { ...current, active: providerId, providers };
  saveConfig(next, path);
  return next;
}

export function rememberModel(providerId: string, model: string, path = configPath()): void {
  const current = loadConfig(path);
  if (!current?.providers?.[providerId]) return;
  const next: AuthConfig = {
    ...current,
    providers: {
      ...current.providers,
      [providerId]: { ...current.providers[providerId], model },
    },
  };
  saveConfig(next, path);
}

export function clearConfig(path = configPath()): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Find which provider should be used and return its credentials.
 * Precedence:
 *   1. Env var of the explicitly active provider (so the user can shadow saved creds).
 *   2. Config of the active provider.
 *   3. Env var of any preset with one set (first match in registry order).
 *   4. Config of any provider in the providers map (first match).
 *   5. Local providers (env-only auth) with their default baseURL.
 */
export function resolveCredentials(
  env: Record<string, string | undefined> = process.env,
  config: AuthConfig | null = loadConfig(),
): ResolvedCredentials | null {
  const presets = listPresets();
  const activeId = config?.active;

  // 1. Active provider's env var takes precedence over its saved config.
  if (activeId) {
    const preset = getPreset(activeId);
    if (preset?.envVar && env[preset.envVar]) {
      return buildEnvCreds(activeId, env[preset.envVar] ?? '', preset.envVar, preset.baseURL);
    }
    const stored = config?.providers?.[activeId];
    if (stored && (stored.apiKey || stored.authToken)) {
      return buildConfigCreds(activeId, stored, preset?.baseURL);
    }
    if (preset?.authMethod === 'env-only') {
      return {
        providerId: activeId,
        apiKey: env[preset.envVar ?? ''] ?? '',
        ...(preset.baseURL !== undefined && { baseURL: preset.baseURL }),
        source: 'preset-default',
        ...(preset.envVar !== undefined && { envVar: preset.envVar }),
      };
    }
  }

  // 2. Any env var that's set, in registry order.
  for (const preset of presets) {
    if (preset.envVar && env[preset.envVar]) {
      return buildEnvCreds(preset.id, env[preset.envVar] ?? '', preset.envVar, preset.baseURL);
    }
  }

  // 3. Any saved config in the providers map, in registry order.
  for (const preset of presets) {
    const stored = config?.providers?.[preset.id];
    if (stored && (stored.apiKey || stored.authToken)) {
      return buildConfigCreds(preset.id, stored, preset.baseURL);
    }
  }

  return null;
}

function buildEnvCreds(
  providerId: string,
  value: string,
  envVar: string,
  baseURL?: string,
): ResolvedCredentials {
  const out: ResolvedCredentials = {
    providerId,
    source: 'env-var',
    envVar,
    apiKey: value,
    authToken: value,
  };
  if (baseURL !== undefined) out.baseURL = baseURL;
  return out;
}

function buildConfigCreds(
  providerId: string,
  stored: ProviderCreds,
  presetBaseURL?: string,
): ResolvedCredentials {
  const out: ResolvedCredentials = {
    providerId,
    source: 'config',
  };
  if (stored.apiKey !== undefined) {
    out.apiKey = stored.apiKey;
    out.authToken = stored.apiKey;
  }
  if (stored.authToken !== undefined) out.authToken = stored.authToken;
  const baseURL = stored.baseURL ?? presetBaseURL;
  if (baseURL !== undefined) out.baseURL = baseURL;
  return out;
}

export function maskCredential(value: string): string {
  if (value.length <= 8) return '…';
  let prefix = value.slice(0, 4);
  if (value.startsWith('sk-ant-')) prefix = 'sk-ant-';
  else if (value.startsWith('sk-or-')) prefix = 'sk-or-';
  else if (value.startsWith('sk-')) prefix = 'sk-';
  const suffix = value.slice(-4);
  return `${prefix}…${suffix}`;
}

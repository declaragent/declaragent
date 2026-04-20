import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuthConfig,
  clearConfig,
  configPath,
  loadConfig,
  maskCredential,
  rememberModel,
  resolveCredentials,
  saveConfig,
  setProviderCreds,
} from './auth.js';

describe('auth config I/O', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-auth-'));
    path = configPath(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('loadConfig returns null when missing', () => {
    expect(loadConfig(path)).toBeNull();
  });

  test('saveConfig writes JSON and chmods 0600', () => {
    saveConfig({ active: 'anthropic', providers: { anthropic: { apiKey: 'sk-ant-test' } } }, path);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.active).toBe('anthropic');
    expect(raw.providers.anthropic.apiKey).toBe('sk-ant-test');
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test('migrates legacy flat anthropic/openrouter keys into providers map', () => {
    writeFileSync(
      path,
      JSON.stringify({ anthropic: { apiKey: 'a' }, openrouter: { apiKey: 'o' } }),
    );
    const cfg = loadConfig(path);
    expect(cfg?.providers?.anthropic?.apiKey).toBe('a');
    expect(cfg?.providers?.openrouter?.apiKey).toBe('o');
  });

  test('migrates oldest flat apiKey/authToken into providers.anthropic', () => {
    writeFileSync(path, JSON.stringify({ apiKey: 'legacy', authToken: 'tok' }));
    const cfg = loadConfig(path);
    expect(cfg?.providers?.anthropic).toEqual({ apiKey: 'legacy', authToken: 'tok' });
  });

  test('round-trips namespaced config', () => {
    const cfg: AuthConfig = {
      active: 'openai',
      providers: {
        openai: { apiKey: 'sk-openai' },
        groq: { apiKey: 'gsk_groq' },
      },
    };
    saveConfig(cfg, path);
    expect(loadConfig(path)).toEqual(cfg);
  });

  test('clearConfig removes the file', () => {
    saveConfig({ providers: { anthropic: { apiKey: 'x' } } }, path);
    expect(clearConfig(path)).toBe(true);
    expect(loadConfig(path)).toBeNull();
    expect(clearConfig(path)).toBe(false);
  });

  test('setProviderCreds adds and marks active without losing other providers', () => {
    saveConfig(
      {
        active: 'anthropic',
        providers: { anthropic: { apiKey: 'a' } },
      },
      path,
    );
    setProviderCreds('groq', { apiKey: 'gsk_groq' }, path);
    const cfg = loadConfig(path);
    expect(cfg?.active).toBe('groq');
    expect(cfg?.providers?.anthropic?.apiKey).toBe('a');
    expect(cfg?.providers?.groq?.apiKey).toBe('gsk_groq');
  });

  test('rememberModel writes per-provider model preference', () => {
    saveConfig({ active: 'openai', providers: { openai: { apiKey: 'k' } } }, path);
    rememberModel('openai', 'gpt-4o', path);
    expect(loadConfig(path)?.providers?.openai?.model).toBe('gpt-4o');
  });
});

describe('resolveCredentials precedence', () => {
  test('active provider env var wins over its config', () => {
    const out = resolveCredentials(
      { ANTHROPIC_API_KEY: 'env-key' },
      {
        active: 'anthropic',
        providers: { anthropic: { apiKey: 'cfg' } },
      },
    );
    expect(out?.providerId).toBe('anthropic');
    expect(out?.apiKey).toBe('env-key');
    expect(out?.source).toBe('env-var');
  });

  test('active provider config used when no env var set', () => {
    const out = resolveCredentials(
      {},
      {
        active: 'openrouter',
        providers: { openrouter: { apiKey: 'sk-or-cfg' } },
      },
    );
    expect(out?.providerId).toBe('openrouter');
    expect(out?.apiKey).toBe('sk-or-cfg');
    expect(out?.source).toBe('config');
    expect(out?.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  test('falls back to any env var when no active provider', () => {
    const out = resolveCredentials({ GROQ_API_KEY: 'gsk_x' }, null);
    expect(out?.providerId).toBe('groq');
    expect(out?.source).toBe('env-var');
  });

  test('falls back to any saved provider config when no env vars', () => {
    const out = resolveCredentials({}, { providers: { openai: { apiKey: 'sk-x' } } });
    expect(out?.providerId).toBe('openai');
  });

  test('returns null when nothing is available', () => {
    expect(resolveCredentials({}, null)).toBeNull();
    expect(resolveCredentials({}, {})).toBeNull();
  });

  test('local provider (env-only) resolves with empty key when active', () => {
    const out = resolveCredentials({}, { active: 'ollama', providers: { ollama: {} } });
    expect(out?.providerId).toBe('ollama');
    expect(out?.baseURL).toBe('http://localhost:11434/v1');
    expect(out?.source).toBe('preset-default');
  });
});

describe('maskCredential', () => {
  test('keeps prefix and last 4 for ant keys', () => {
    expect(maskCredential('sk-ant-api03-aBcDeFgHiJkLmNop')).toBe('sk-ant-…mNop');
  });

  test('keeps prefix and last 4 for openrouter keys', () => {
    expect(maskCredential('sk-or-v1-aaaaaaaaaaaaaaaaaaaa')).toBe('sk-or-…aaaa');
  });

  test('handles generic sk- keys', () => {
    expect(maskCredential('sk-aaaaaaaaaaaaaaaaaaaa')).toBe('sk-…aaaa');
  });

  test('falls back to first-4/last-4 for non-prefixed strings', () => {
    expect(maskCredential('abcdefghijklmnop')).toBe('abcd…mnop');
  });

  test('short values are fully redacted', () => {
    expect(maskCredential('short')).toBe('…');
  });
});

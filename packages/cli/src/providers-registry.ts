/**
 * Provider registry. Each preset declares how to authenticate against and
 * route to a specific LLM backend. The CLI uses these to drive the
 * `auth login <provider>` flow and to instantiate the right `LLMProvider`
 * impl in the engine.
 *
 * Most modern LLM endpoints speak OpenAI Chat Completions, so the bulk of
 * presets share a single provider implementation.
 */

export type ProviderKind = 'anthropic' | 'openai-compat';

export type AuthMethod =
  | 'api-key' // paste flow, or --api-key on CLI
  | 'browser-pkce' // OAuth-style; only OpenRouter today
  | 'env-only' // local providers; no key needed (or env var only)
  | 'managed-env'; // managed by env vars (e.g. AWS); CLI doesn't store

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Base URL for openai-compat providers. Ignored for anthropic. */
  baseURL?: string;
  /** Env var the user might already have set. */
  envVar?: string;
  /** Suggested default model for the picker. */
  defaultModel?: string;
  authMethod: AuthMethod;
  /** Where to grab a key — shown in the auth flow. */
  keyURL?: string;
  /** Extra HTTP headers for openai-compat (e.g., OpenRouter attribution). */
  headers?: Record<string, string>;
  /** Mark cloud providers vs local. Drives picker grouping. */
  hosting: 'cloud' | 'local';
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic — Claude (native API)',
    kind: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-4-6',
    authMethod: 'api-key',
    keyURL: 'https://console.anthropic.com/settings/keys',
    hosting: 'cloud',
  },
  {
    id: 'openai',
    label: 'OpenAI — GPT-4o, o1, etc.',
    kind: 'openai-compat',
    baseURL: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    authMethod: 'api-key',
    keyURL: 'https://platform.openai.com/api-keys',
    hosting: 'cloud',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter — 200+ models, any provider',
    kind: 'openai-compat',
    baseURL: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    defaultModel: 'openai/gpt-4o-mini',
    authMethod: 'browser-pkce',
    keyURL: 'https://openrouter.ai/keys',
    hosting: 'cloud',
  },
  {
    id: 'groq',
    label: 'Groq — fast Llama / Mixtral / Gemma',
    kind: 'openai-compat',
    baseURL: 'https://api.groq.com/openai/v1',
    envVar: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    authMethod: 'api-key',
    keyURL: 'https://console.groq.com/keys',
    hosting: 'cloud',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compat',
    baseURL: 'https://api.deepseek.com/v1',
    envVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    authMethod: 'api-key',
    keyURL: 'https://platform.deepseek.com/api_keys',
    hosting: 'cloud',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'openai-compat',
    baseURL: 'https://api.together.xyz/v1',
    envVar: 'TOGETHER_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    authMethod: 'api-key',
    keyURL: 'https://api.together.xyz/settings/api-keys',
    hosting: 'cloud',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    kind: 'openai-compat',
    baseURL: 'https://api.mistral.ai/v1',
    envVar: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-large-latest',
    authMethod: 'api-key',
    keyURL: 'https://console.mistral.ai/api-keys',
    hosting: 'cloud',
  },
  {
    id: 'xai',
    label: 'xAI — Grok',
    kind: 'openai-compat',
    baseURL: 'https://api.x.ai/v1',
    envVar: 'XAI_API_KEY',
    defaultModel: 'grok-2-latest',
    authMethod: 'api-key',
    keyURL: 'https://console.x.ai/',
    hosting: 'cloud',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compat',
    baseURL: 'http://localhost:11434/v1',
    envVar: 'OLLAMA_API_KEY',
    defaultModel: 'llama3.2',
    authMethod: 'env-only',
    keyURL: 'https://ollama.com/download',
    hosting: 'local',
  },
  {
    id: 'lm-studio',
    label: 'LM Studio (local)',
    kind: 'openai-compat',
    baseURL: 'http://localhost:1234/v1',
    envVar: 'LMSTUDIO_API_KEY',
    defaultModel: 'local-model',
    authMethod: 'env-only',
    keyURL: 'https://lmstudio.ai/',
    hosting: 'local',
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp server (local)',
    kind: 'openai-compat',
    baseURL: 'http://localhost:8080/v1',
    envVar: 'LLAMACPP_API_KEY',
    defaultModel: 'local-model',
    authMethod: 'env-only',
    keyURL: 'https://github.com/ggerganov/llama.cpp',
    hosting: 'local',
  },
];

const PRESETS_BY_ID = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): ProviderPreset | undefined {
  return PRESETS_BY_ID.get(id);
}

export function listPresets(): ProviderPreset[] {
  return PROVIDER_PRESETS;
}

export function listPresetIds(): string[] {
  return PROVIDER_PRESETS.map((p) => p.id);
}

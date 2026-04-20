export interface KnownModel {
  id: string;
  label: string;
}

/**
 * Curated short list per provider, used as a fallback when no live model
 * endpoint is available. Most providers don't need an entry here — the
 * `/model` picker falls back to fetching `<baseURL>/models` for openai-compat
 * targets. Anthropic doesn't have an open list endpoint, so it's seeded here.
 */
export const KNOWN_MODELS: Record<string, KnownModel[]> = {
  anthropic: [
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 — most capable' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fastest' },
  ],
  openrouter: [
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini — cheap, fast' },
    { id: 'openai/gpt-4o', label: 'GPT-4o — strong general' },
    { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
    { id: 'google/gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash' },
  ],
};

export const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-opus-4-6',
  openrouter: 'openai/gpt-4o-mini',
};

export function defaultModelFor(providerId: string): string {
  return DEFAULT_MODEL[providerId] ?? 'claude-opus-4-6';
}

export function knownModelsFor(providerId: string): KnownModel[] {
  return KNOWN_MODELS[providerId] ?? [];
}

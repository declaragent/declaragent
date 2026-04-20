import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openRouterModelsCachePath } from './paths.js';

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

interface ModelsCache {
  fetchedAt: number;
  models: OpenRouterModel[];
}

function readCache(path: string): ModelsCache | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ModelsCache;
  } catch {
    return null;
  }
}

function writeCache(path: string, data: ModelsCache): void {
  try {
    writeFileSync(path, JSON.stringify(data), 'utf8');
  } catch {
    // non-fatal: cache write failure shouldn't break the flow
  }
}

export interface FetchOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  cachePath?: string;
  ttlMs?: number;
}

export interface FetchResult {
  models: OpenRouterModel[];
  /** 'live' if fetched now, 'cache' if served from cache. */
  source: 'live' | 'cache' | 'stale-fallback';
}

/**
 * Fetch OpenRouter's model list with on-disk caching. Falls back to a stale
 * cache on fetch failure so `/model` keeps working offline.
 */
export async function fetchOpenRouterModels(options: FetchOptions = {}): Promise<FetchResult> {
  const path = options.cachePath ?? openRouterModelsCachePath();
  const ttl = options.ttlMs ?? MODELS_CACHE_TTL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cached = readCache(path);

  if (!options.force && cached && Date.now() - cached.fetchedAt < ttl) {
    return { models: cached.models, source: 'cache' };
  }

  try {
    const response = await fetchImpl(OPENROUTER_MODELS_URL);
    if (!response.ok) {
      if (cached) return { models: cached.models, source: 'stale-fallback' };
      throw new Error(`OpenRouter models fetch failed (${response.status})`);
    }
    const body = (await response.json()) as { data?: OpenRouterModel[] };
    const models = body.data ?? [];
    writeCache(path, { fetchedAt: Date.now(), models });
    return { models, source: 'live' };
  } catch (err) {
    if (cached) return { models: cached.models, source: 'stale-fallback' };
    throw err;
  }
}

/** Keep only models whose id starts with `anthropic/` — those work through our Anthropic-compat path. */
export function filterAnthropicCompatible(models: OpenRouterModel[]): OpenRouterModel[] {
  return models.filter((m) => m.id.startsWith('anthropic/'));
}

/** Short, human-readable summary of a model for the /model picker. */
export function summarizeModel(model: OpenRouterModel): string {
  const parts: string[] = [];
  if (model.context_length) {
    parts.push(`${Math.round(model.context_length / 1000)}K ctx`);
  }
  if (model.pricing?.prompt) {
    const prompt = Number.parseFloat(model.pricing.prompt);
    if (Number.isFinite(prompt) && prompt > 0) {
      parts.push(`$${(prompt * 1_000_000).toFixed(2)}/M in`);
    }
  }
  return parts.join('  ');
}

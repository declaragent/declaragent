import type { LLMProvider } from '../types/llm.js';
import { type OpenAICompatConfig, createOpenAICompatProvider } from './openai-compat.js';
import type { RetryConfig } from './retry.js';

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_MAX_TOKENS = 4_096;

export interface OpenRouterProviderConfig {
  apiKey: string;
  baseURL?: string;
  /** App attribution headers (OpenRouter convention). */
  referrer?: string;
  title?: string;
  retry?: Partial<RetryConfig>;
  fetchImpl?: typeof fetch;
}

/**
 * Thin wrapper that pre-configures the generic OpenAI-compat provider with
 * OpenRouter's defaults and attribution headers. Kept as a separate export
 * because OpenRouter is the most-tested target and the headers are conventional.
 */
export function createOpenRouterProvider(config: OpenRouterProviderConfig): LLMProvider {
  const headers: Record<string, string> = {};
  if (config.referrer) headers['HTTP-Referer'] = config.referrer;
  if (config.title) headers['X-Title'] = config.title;
  const compat: OpenAICompatConfig = {
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? DEFAULT_OPENROUTER_BASE_URL,
  };
  if (Object.keys(headers).length > 0) compat.headers = headers;
  if (config.retry) compat.retry = config.retry;
  if (config.fetchImpl) compat.fetchImpl = config.fetchImpl;
  return createOpenAICompatProvider(compat);
}

// Re-export translation helpers for tests that imported them by name.
export { fromOpenAIResponse, toOpenAIMessages, toOpenAITools } from './openai-compat.js';

/**
 * Resolve a `LLMProvider` from the user's auth config.
 *
 * Extracted from `app.tsx` (where the same conditional shipped
 * inline) so multiple CLI entry points can produce a provider from
 * the same credentials:
 *
 *   - `declaragent` (REPL, builder persona) — via `app.tsx`
 *   - `declaragent run <dir>` — via `run-agent-cli.ts`
 *   - `declaragent fleet run` — via `fleet-run.ts` (Phase A.2)
 *
 * The logic here is a pure function of credentials + the provider
 * registry preset. No side effects.
 *
 * @since 0.3.6
 */

import {
  type LLMProvider,
  createAnthropicProvider,
  createOpenAICompatProvider,
} from '@declaragent/core';
import { DECLARAGENT_REFERRER, DECLARAGENT_TITLE } from './openrouter-oauth.js';
import { type ProviderPreset, getPreset } from './providers-registry.js';

export interface ResolvedCredentials {
  readonly providerId: string;
  readonly apiKey?: string;
  readonly authToken?: string;
  readonly baseURL?: string;
  readonly source?: string;
}

/**
 * Thrown when credentials don't map to any known provider preset and
 * the anthropic fallback would lose important user intent. Today we
 * silently fall back to anthropic — this error is exported for
 * future stricter modes.
 */
export class UnknownProviderError extends Error {
  constructor(providerId: string) {
    super(`unknown provider "${providerId}" — no preset registered`);
    this.name = 'UnknownProviderError';
  }
}

export interface CreateProviderOptions {
  /** Credentials from `resolveCredentials()`. May be undefined if auth missing. */
  creds: ResolvedCredentials | null | undefined;
  /** Override the preset — useful for tests. Production callers let us look it up. */
  preset?: ProviderPreset | undefined;
}

/**
 * Produce an `LLMProvider` from the resolved auth credentials.
 *
 * The function mirrors the conditional that lived inline in
 * `app.tsx`. Anthropic and openai-compat are the two branches the
 * registry cares about today; unknown presets silently fall back to
 * anthropic (historical behaviour — plenty of installs have
 * `providerId: 'anthropic'` in their config without a formal
 * preset entry).
 */
export function createProviderFromCreds(options: CreateProviderOptions): LLMProvider {
  const creds = options.creds ?? undefined;
  const providerId = creds?.providerId ?? 'anthropic';
  const preset = options.preset ?? getPreset(providerId);

  if (preset?.kind === 'anthropic') {
    return createAnthropicProvider({
      ...(creds?.authToken !== undefined && { authToken: creds.authToken }),
      ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
    });
  }

  if (preset?.kind === 'openai-compat') {
    const apiKey = creds?.apiKey ?? creds?.authToken ?? '';
    const baseURL = creds?.baseURL ?? preset.baseURL ?? '';
    const headers: Record<string, string> = { ...(preset.headers ?? {}) };
    if (preset.id === 'openrouter') {
      // OpenRouter convention — send attribution headers so
      // declaragent sessions show up under the right referrer in
      // the OR dashboard.
      headers['HTTP-Referer'] = DECLARAGENT_REFERRER;
      headers['X-Title'] = DECLARAGENT_TITLE;
    }
    return createOpenAICompatProvider({
      apiKey,
      baseURL,
      ...(Object.keys(headers).length > 0 && { headers }),
    });
  }

  // Unknown preset — historical fallback is anthropic-with-whatever-creds.
  // Preserve it so existing configs don't break on version bump.
  return createAnthropicProvider({
    ...(creds?.authToken !== undefined && { authToken: creds.authToken }),
    ...(creds?.apiKey !== undefined && { apiKey: creds.apiKey }),
  });
}

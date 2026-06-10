import type { TokenUsage } from '../types/messages.js';

/**
 * USD per 1M tokens. Static price book; replaced with live data in Phase 6.
 * Unknown models contribute zero cost (the ledger still tracks tokens) — but
 * callers can pass `onUnknownModel` to detect that, since a silently-$0 model
 * makes a dollar-denominated spend cap (WS8) a no-op.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-4-8': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  // Referenced as the `up` / `fleet run` default model (up-cli.ts, fleet-run.ts);
  // must be priced or the default path silently costs $0.
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08 },
  'claude-haiku-4-5': { input: 0.8, output: 4, cacheRead: 0.08 },
};

/** True if {@link PRICE_TABLE} has an entry for `model`. */
export function hasPriceFor(model: string | undefined): boolean {
  return model !== undefined && model in PRICE_TABLE;
}

export interface EstimateCostOptions {
  /**
   * Invoked when `model` is set but absent from {@link PRICE_TABLE}. Lets the
   * caller emit a warning / increment an `unpriced_model` counter instead of
   * silently treating the turn as free.
   */
  onUnknownModel?: (model: string) => void;
}

export function estimateCostUSD(
  model: string | undefined,
  usage: TokenUsage,
  options?: EstimateCostOptions,
): number {
  if (!model) return 0;
  const price = PRICE_TABLE[model];
  if (!price) {
    options?.onUnknownModel?.(model);
    return 0;
  }
  const million = 1_000_000;
  const inCost = (usage.inputTokens / million) * price.input;
  const outCost = (usage.outputTokens / million) * price.output;
  const cacheCost =
    usage.cacheReadTokens && price.cacheRead
      ? (usage.cacheReadTokens / million) * price.cacheRead
      : 0;
  return inCost + outCost + cacheCost;
}

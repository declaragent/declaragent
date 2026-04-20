import type { TokenUsage } from '../types/messages.js';

/**
 * USD per 1M tokens. Static price book; replaced with live data in Phase 6.
 * Unknown models contribute zero cost (the ledger still tracks tokens).
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
}

export const PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08 },
};

export function estimateCostUSD(model: string | undefined, usage: TokenUsage): number {
  if (!model) return 0;
  const price = PRICE_TABLE[model];
  if (!price) return 0;
  const million = 1_000_000;
  const inCost = (usage.inputTokens / million) * price.input;
  const outCost = (usage.outputTokens / million) * price.output;
  const cacheCost =
    usage.cacheReadTokens && price.cacheRead
      ? (usage.cacheReadTokens / million) * price.cacheRead
      : 0;
  return inCost + outCost + cacheCost;
}

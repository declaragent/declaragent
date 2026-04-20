import { describe, expect, test } from 'bun:test';
import { estimateCostUSD } from './pricing.js';

describe('estimateCostUSD', () => {
  test('returns 0 for unknown model', () => {
    expect(estimateCostUSD('made-up', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0);
  });

  test('returns 0 when model is undefined', () => {
    expect(estimateCostUSD(undefined, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0);
  });

  test('opus pricing math', () => {
    // 1M input @ $15 + 1M output @ $75 = $90
    const cost = estimateCostUSD('claude-opus-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(90);
  });

  test('cache read tokens use the cacheRead rate', () => {
    // 1M cache reads @ $1.5 = $1.5
    const cost = estimateCostUSD('claude-opus-4-6', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.5);
  });
});

import { describe, expect, test } from 'bun:test';
import { PRICE_TABLE, estimateCostUSD, hasPriceFor } from './pricing.js';

describe('estimateCostUSD', () => {
  test('returns 0 for unknown model', () => {
    expect(estimateCostUSD('made-up', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0);
  });

  test('invokes onUnknownModel for an unpriced model (not a silent $0)', () => {
    const seen: string[] = [];
    estimateCostUSD(
      'made-up',
      { inputTokens: 1_000_000, outputTokens: 0 },
      { onUnknownModel: (m) => seen.push(m) },
    );
    expect(seen).toEqual(['made-up']);
  });

  test('does not invoke onUnknownModel for a priced model', () => {
    const seen: string[] = [];
    estimateCostUSD(
      'claude-opus-4-6',
      { inputTokens: 1, outputTokens: 1 },
      { onUnknownModel: (m) => seen.push(m) },
    );
    expect(seen).toEqual([]);
  });

  test('the default up / fleet-run model is priced (no silent $0 on the default path)', () => {
    // up-cli.ts + fleet-run.ts default to claude-sonnet-4-5.
    expect(hasPriceFor('claude-sonnet-4-5')).toBe(true);
    expect(PRICE_TABLE['claude-sonnet-4-5']).toBeDefined();
    const cost = estimateCostUSD('claude-sonnet-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeGreaterThan(0);
  });

  test('hasPriceFor is false for unknown / undefined', () => {
    expect(hasPriceFor('nope')).toBe(false);
    expect(hasPriceFor(undefined)).toBe(false);
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

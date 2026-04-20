import { describe, expect, test } from 'bun:test';
import { RetriesExhaustedError, computeBackoffMs, defaultIsRetryable, withRetry } from './retry.js';

describe('defaultIsRetryable', () => {
  test('429 retries', () => {
    expect(defaultIsRetryable({ status: 429 })).toBe(true);
  });

  test('5xx retries', () => {
    expect(defaultIsRetryable({ status: 500 })).toBe(true);
    expect(defaultIsRetryable({ statusCode: 503 })).toBe(true);
  });

  test('4xx (non-429) does not retry', () => {
    expect(defaultIsRetryable({ status: 400 })).toBe(false);
    expect(defaultIsRetryable({ status: 404 })).toBe(false);
  });

  test('AbortError does not retry', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(defaultIsRetryable(err)).toBe(false);
  });

  test('errors without a status are treated as network and retry', () => {
    expect(defaultIsRetryable(new Error('connection reset'))).toBe(true);
  });
});

describe('computeBackoffMs', () => {
  test('grows exponentially before the cap', () => {
    const cfg = { baseDelayMs: 100, maxDelayMs: 10_000 };
    // Full jitter: result is in [0, exponential).
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const delay = computeBackoffMs(attempt, cfg);
      const cap = Math.min(100 * 2 ** attempt, 10_000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(cap);
    }
  });

  test('respects maxDelayMs cap', () => {
    const cfg = { baseDelayMs: 1_000, maxDelayMs: 5_000 };
    for (let i = 0; i < 50; i += 1) {
      const delay = computeBackoffMs(20, cfg);
      expect(delay).toBeLessThan(5_000);
    }
  });
});

describe('withRetry', () => {
  test('returns success on first attempt', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries on retryable error then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw { status: 503 };
        return 'ok';
      },
      { baseDelayMs: 1, maxDelayMs: 10 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('does not retry non-retryable error', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw { status: 400 };
      }),
    ).rejects.toEqual({ status: 400 });
    expect(calls).toBe(1);
  });

  test('throws RetriesExhaustedError after maxRetries', async () => {
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls += 1;
        throw { status: 500 };
      },
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 },
    );
    await expect(promise).rejects.toBeInstanceOf(RetriesExhaustedError);
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  test('aborts before next attempt when signal fires', async () => {
    const ac = new AbortController();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls += 1;
        if (calls === 1) ac.abort();
        throw { status: 503 };
      },
      { baseDelayMs: 50, maxDelayMs: 100 },
      ac.signal,
    );
    await expect(promise).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});

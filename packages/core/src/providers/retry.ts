export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (err: unknown) => boolean;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  isRetryable: defaultIsRetryable,
};

/**
 * Default predicate: retry 429s, 5xx, network errors. Not 4xx, not aborts.
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;
  const status = extractStatus(err);
  if (status === undefined) {
    // Network error (no status). Retry.
    return true;
  }
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  return undefined;
}

function jitterMs(baseMs: number): number {
  // Full jitter: random in [0, baseMs).
  return Math.floor(Math.random() * baseMs);
}

/**
 * Compute the next delay for attempt N (0-indexed).
 * Exponential growth from `baseDelayMs`, capped at `maxDelayMs`, plus full jitter.
 */
export function computeBackoffMs(
  attempt: number,
  config: Pick<RetryConfig, 'baseDelayMs' | 'maxDelayMs'>,
): number {
  const exponential = config.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, config.maxDelayMs);
  return jitterMs(capped);
}

export class RetriesExhaustedError extends Error {
  constructor(
    readonly lastError: unknown,
    readonly attempts: number,
  ) {
    super(
      `Retries exhausted after ${attempts} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.name = 'RetriesExhaustedError';
  }
}

export async function withRetry<T>(
  op: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  signal?: AbortSignal,
): Promise<T> {
  const merged: RetryConfig = { ...DEFAULT_RETRY, ...config };
  let lastError: unknown;
  for (let attempt = 0; attempt <= merged.maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Aborted');
    }
    try {
      return await op();
    } catch (err) {
      lastError = err;
      // Non-retryable errors propagate as-is. Only the
      // "out of attempts after retrying retryable errors" case wraps.
      if (!merged.isRetryable(err)) throw err;
      if (attempt === merged.maxRetries) break;
      const delay = computeBackoffMs(attempt, merged);
      await sleep(delay, signal);
    }
  }
  throw new RetriesExhaustedError(lastError, merged.maxRetries + 1);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    function cleanup() {
      signal?.removeEventListener('abort', onAbort);
    }
  });
}

/**
 * Shared provider rate-limit wrap, used by both `declaragent up` and
 * `declaragent fleet run` so every runtime that constructs a provider
 * gets the same token bucket + env-var escape hatches:
 *
 *   - `DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE=1` bypasses the wrap
 *     entirely. Useful for load tests + offline backfills.
 *   - `DECLARAGENT_PROVIDER_RATE_LIMIT_RPS=<n>` overrides the preset's
 *     default. Floating-point values accepted.
 *
 * Extracted from `up-cli.ts` (backlog: docs-truth Wave 1 — the docs'
 * "token bucket wraps every provider" claim only held for `up`).
 *
 * @since 0.6.0-slice.4 (in `up`); shared module + fleet-run wiring 0.7.6
 */
import { defaultRateForProvider, withProviderRateLimit } from '@declaragent/core';
import type { LLMProvider } from '@declaragent/core';

export interface ProviderRateLimitIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export function wrapProviderWithRateLimit(opts: {
  provider: LLMProvider;
  providerId: string;
  io: ProviderRateLimitIO;
  /** Observe throttle waits (e.g. bump Prometheus counters). */
  onWait?: (waitMs: number) => void;
  /** Env bag override for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}): LLMProvider {
  const env = opts.env ?? process.env;
  if (env.DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE === '1') {
    opts.io.out('  rate-limit: disabled via DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE\n');
    return opts.provider;
  }
  const override = env.DECLARAGENT_PROVIDER_RATE_LIMIT_RPS;
  let rate: number;
  if (override !== undefined && override !== '') {
    const parsed = Number.parseFloat(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      rate = parsed;
    } else {
      opts.io.err(
        `⚠ DECLARAGENT_PROVIDER_RATE_LIMIT_RPS="${override}" is not a positive number; using default.\n`,
      );
      rate = defaultRateForProvider(opts.providerId);
    }
  } else {
    rate = defaultRateForProvider(opts.providerId);
  }
  opts.io.out(
    `  rate-limit: ${rate} rps (provider=${opts.providerId}; env DECLARAGENT_PROVIDER_RATE_LIMIT_RPS overrides, DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE=1 opts out)\n`,
  );
  const onWait = opts.onWait;
  return withProviderRateLimit(opts.provider, {
    ratePerSec: rate,
    ...(onWait === undefined ? {} : { onWait }),
  });
}

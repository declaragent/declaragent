import type { Logger } from '@declaragent/core';
import type { ChaosTargetRuntime } from '../types.js';

/**
 * Compose multiple partial {@link ChaosTargetRuntime} fragments into a
 * single runtime. Each fault ships a focused fragment (one method);
 * the driver consumes the composed whole.
 *
 * Later fragments override earlier ones when a method appears twice —
 * this lets tests wrap a real fault with a spy without having to
 * rewrite the underlying implementation.
 */
export function composeRuntimes(
  logger: Logger | undefined,
  ...fragments: readonly Partial<ChaosTargetRuntime>[]
): ChaosTargetRuntime {
  const merged: ChaosTargetRuntime = logger ? { logger } : {};
  for (const fragment of fragments) {
    Object.assign(merged, fragment);
  }
  return merged;
}

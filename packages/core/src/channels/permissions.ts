import type { GateConfig } from '../permission/gate.js';
import { globMatches } from '../permission/glob.js';
import type { PermissionRule } from '../types/permission.js';
import type { ChannelPermissionsConfig, ChannelPrincipal, ChannelUserOverride } from './types.js';

/**
 * Resolve a `PermissionGate` config for a given channel principal.
 *
 * Resolution order (hardest wins first):
 *   1. Explicit `deny` rules always beat anything — channel base denies
 *      plus the matched override's denies are unioned.
 *   2. Matched override's `allow` replaces the channel base `allow`.
 *      Rationale: most override use cases are "this admin gets broader
 *      tools" or "this bot user loses everything"; replacement is the
 *      simpler mental model and matches the Phase-5 plan §8.
 *   3. No match → channel base rules pass through unchanged.
 *
 * User-override matching walks entries in **longest pattern first**
 * order so the more specific pattern (`U0ADMIN*`) wins over the looser
 * one (`U0*`) for the same principal. Ties are broken by config order.
 *
 * The returned `GateConfig` is the exact shape `createPermissionGate`
 * consumes, so callers can do:
 *
 * ```ts
 * const gateConfig = resolveForChannel(principal, channel.permissions);
 * const scoped = createPermissionGate(gateConfig);
 * ```
 */
export function resolveForChannel(
  principal: ChannelPrincipal | undefined,
  config: ChannelPermissionsConfig | undefined,
): GateConfig {
  if (!config) {
    return { mode: 'default', rules: [] };
  }
  const override = principal ? findOverride(principal, config.userOverrides) : undefined;

  const mode = override?.mode ?? config.mode;

  const denyPatterns = new Set<string>();
  for (const p of config.deny ?? []) denyPatterns.add(p);
  for (const p of override?.deny ?? []) denyPatterns.add(p);

  // Override's allow replaces base allow when present; otherwise base allow stays.
  const allowPatterns: readonly string[] = override?.allow ?? config.allow ?? [];

  const rules: PermissionRule[] = [
    ...Array.from(denyPatterns, (pattern) => ({ pattern, decision: 'deny' as const })),
    ...allowPatterns.map((pattern) => ({ pattern, decision: 'allow' as const })),
  ];

  return { mode, rules };
}

/**
 * Test-visible helper. Returns the matched override or `undefined`.
 * Exposed so callers that want to audit which override was applied can
 * attribute it by pattern + mode.
 */
export function findOverride(
  principal: ChannelPrincipal,
  overrides: readonly ChannelUserOverride[] | undefined,
): ChannelUserOverride | undefined {
  if (!overrides || overrides.length === 0) return undefined;
  // Sort by descending pattern length so longer (more specific) patterns
  // win — stable sort preserves source order within equal lengths.
  const indexed = overrides.map((override, index) => ({ override, index }));
  indexed.sort((a, b) => {
    const byLen = b.override.platformUserIdPattern.length - a.override.platformUserIdPattern.length;
    return byLen !== 0 ? byLen : a.index - b.index;
  });
  for (const { override } of indexed) {
    if (globMatches(override.platformUserIdPattern, principal.platformUserId)) {
      return override;
    }
  }
  return undefined;
}

import { globMatches } from '../permission/glob.js';
import type {
  AllowListEnrollerConfig,
  AllowListEnrollerEntry,
  ChannelEnroller,
  ChannelPrincipal,
} from './types.js';

/**
 * Slice-1 stub resolver. Matches a principal against a static allow-list
 * config. Glob syntax comes from the shared permission glob (`*` =
 * non-separator run, `**` = any run). Non-match → `undefined`, which the
 * downstream permission gate interprets as "anonymous, channel-level
 * rules only".
 *
 * The full OAuth-style enrollment flow (DM → auth link → agent-user
 * mapping) is a Phase-5.x concern and ships alongside the managed
 * control plane.
 */
export function createAllowListEnroller(config: AllowListEnrollerConfig): ChannelEnroller {
  return {
    async resolve(principal: ChannelPrincipal): Promise<string | undefined> {
      return matchEntry(principal, config.entries)?.agentUserId;
    },
  };
}

/**
 * Synchronous variant; useful for tests and for callers that want to
 * avoid the promise layer. Exposed separately rather than overloading the
 * `ChannelEnroller` contract, which stays async-friendly for future
 * network-backed resolvers.
 */
export function matchAllowList(
  principal: ChannelPrincipal,
  config: AllowListEnrollerConfig,
): string | undefined {
  return matchEntry(principal, config.entries)?.agentUserId;
}

function matchEntry(
  principal: ChannelPrincipal,
  entries: readonly AllowListEnrollerEntry[],
): AllowListEnrollerEntry | undefined {
  for (const entry of entries) {
    if (entry.channelId !== undefined && entry.channelId !== principal.channelId) continue;
    if (!globMatches(entry.platformUserIdPattern, principal.platformUserId)) continue;
    return entry;
  }
  return undefined;
}

import type {
  BaseChannelOutboundConfig,
  DeliveryConfig,
  LimitsConfig,
  RoutingConfig,
} from '@declaragent/core';

/**
 * How to handle a send into an archived thread. Default: `unarchive` —
 * the adapter PATCHes the thread to `archived: false` before sending. If
 * the unarchive fails (e.g. archive-locked), fall back per-policy:
 *   - `unarchive`  → try unarchive, on failure reply in the parent
 *                    channel with a cross-link (same as `parent-reply`).
 *   - `parent-reply` → skip the unarchive attempt; reply in parent
 *                    directly.
 *   - `drop`       → do not send; the adapter throws.
 */
export type ArchivedThreadPolicy = 'unarchive' | 'parent-reply' | 'drop';

/**
 * Named Discord gateway intent bits. The adapter maps the declared set
 * to the bitfield Discord expects. `MessageContent`, `GuildPresences`,
 * and `GuildMembers` are privileged and require explicit opt-in via
 * `transport.privileged: true` — the startup gate rejects configs that
 * list them otherwise.
 *
 * Reference:
 * https://discord.com/developers/docs/topics/gateway#list-of-intents.
 */
export type DiscordIntentName =
  | 'Guilds'
  | 'GuildMembers'
  | 'GuildModeration'
  | 'GuildEmojisAndStickers'
  | 'GuildIntegrations'
  | 'GuildWebhooks'
  | 'GuildInvites'
  | 'GuildVoiceStates'
  | 'GuildPresences'
  | 'GuildMessages'
  | 'GuildMessageReactions'
  | 'GuildMessageTyping'
  | 'DirectMessages'
  | 'DirectMessageReactions'
  | 'DirectMessageTyping'
  | 'MessageContent'
  | 'GuildScheduledEvents'
  | 'AutoModerationConfiguration'
  | 'AutoModerationExecution';

export const DISCORD_INTENT_BITS: Readonly<Record<DiscordIntentName, number>> = {
  Guilds: 1 << 0,
  GuildMembers: 1 << 1,
  GuildModeration: 1 << 2,
  GuildEmojisAndStickers: 1 << 3,
  GuildIntegrations: 1 << 4,
  GuildWebhooks: 1 << 5,
  GuildInvites: 1 << 6,
  GuildVoiceStates: 1 << 7,
  GuildPresences: 1 << 8,
  GuildMessages: 1 << 9,
  GuildMessageReactions: 1 << 10,
  GuildMessageTyping: 1 << 11,
  DirectMessages: 1 << 12,
  DirectMessageReactions: 1 << 13,
  DirectMessageTyping: 1 << 14,
  MessageContent: 1 << 15,
  GuildScheduledEvents: 1 << 16,
  AutoModerationConfiguration: 1 << 20,
  AutoModerationExecution: 1 << 21,
};

export const PRIVILEGED_INTENTS: readonly DiscordIntentName[] = [
  'MessageContent',
  'GuildPresences',
  'GuildMembers',
];

export interface DiscordSlashCommandConfig {
  name: string;
  description: string;
}

export interface DiscordTransportConfig {
  botToken: string;
  applicationId: string;
  intents: readonly DiscordIntentName[];
  /**
   * Required when `intents` includes any of `MessageContent`,
   * `GuildPresences`, `GuildMembers`. Discord operator must have enabled
   * these in the Developer Portal first.
   */
  privileged?: boolean;
  /** Optional shard id. Used when running multiple processes. */
  shardId?: number;
  /** Total shard count. Default 1. */
  shardCount?: number;
  /**
   * Phase 6 slice 4 addition. Application's Ed25519 public key from the
   * Discord Developer Portal, hex-encoded (64 hex chars = 32 bytes).
   * Required whenever `handleWebhook` is used — Discord signs every
   * interaction webhook and unsigned bodies MUST be rejected. Absent
   * when webhook mode is not in use (Gateway-only deployments).
   */
  publicKey?: string;
}

export interface DiscordChannelConfig {
  id: string;
  transport: DiscordTransportConfig;
  /** Default `unarchive`. */
  archivedThreadPolicy?: ArchivedThreadPolicy;
  /**
   * Global slash commands to register at startup. The adapter dedupes
   * by content hash via the `conversationStore` (if provided) so repeat
   * starts skip the PUT call.
   */
  slashCommands?: readonly DiscordSlashCommandConfig[];
  routing: RoutingConfig;
  delivery: DeliveryConfig;
  limits: LimitsConfig;
  outbound?: BaseChannelOutboundConfig;
  idempotency?: { ttlMs?: number; maxEntries?: number };
}

export function assertDiscordConfig(cfg: unknown): asserts cfg is DiscordChannelConfig {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('discord config must be an object');
  }
  const c = cfg as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error('discord.id must be a non-empty string');
  }
  const t = c.transport as Record<string, unknown> | undefined;
  if (!t || typeof t !== 'object') {
    throw new Error(`discord[${c.id}].transport is required`);
  }
  if (typeof t.botToken !== 'string' || t.botToken.length === 0) {
    throw new Error(`discord[${c.id}].transport.botToken is required`);
  }
  if (typeof t.applicationId !== 'string' || t.applicationId.length === 0) {
    throw new Error(`discord[${c.id}].transport.applicationId is required`);
  }
  if (t.publicKey !== undefined) {
    if (typeof t.publicKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(t.publicKey)) {
      throw new Error(
        `discord[${c.id}].transport.publicKey must be 64 hex characters (32-byte Ed25519 public key)`,
      );
    }
  }
  if (!Array.isArray(t.intents)) {
    throw new Error(`discord[${c.id}].transport.intents must be an array`);
  }
  const intents = t.intents as unknown[];
  for (const intent of intents) {
    if (typeof intent !== 'string' || !(intent in DISCORD_INTENT_BITS)) {
      throw new Error(
        `discord[${c.id}].transport.intents contains unknown entry: ${String(intent)}`,
      );
    }
  }
  const wantsPrivileged = (intents as DiscordIntentName[]).some((i) =>
    PRIVILEGED_INTENTS.includes(i),
  );
  if (wantsPrivileged && t.privileged !== true) {
    throw new Error(
      `discord[${c.id}].transport.intents requests privileged intents (${PRIVILEGED_INTENTS.join(', ')}) but transport.privileged is not true. Opt in explicitly after enabling them in the Discord Developer Portal.`,
    );
  }
  if (c.archivedThreadPolicy !== undefined) {
    const p = c.archivedThreadPolicy;
    if (p !== 'unarchive' && p !== 'parent-reply' && p !== 'drop') {
      throw new Error(
        `discord[${c.id}].archivedThreadPolicy must be "unarchive" | "parent-reply" | "drop"`,
      );
    }
  }
  if (c.slashCommands !== undefined) {
    if (!Array.isArray(c.slashCommands)) {
      throw new Error(`discord[${c.id}].slashCommands must be an array`);
    }
    for (const cmd of c.slashCommands as unknown[]) {
      const sc = cmd as Record<string, unknown> | null;
      if (!sc || typeof sc !== 'object') {
        throw new Error(`discord[${c.id}].slashCommands entries must be objects`);
      }
      if (typeof sc.name !== 'string' || sc.name.length === 0) {
        throw new Error(`discord[${c.id}].slashCommands[].name is required`);
      }
      if (typeof sc.description !== 'string' || sc.description.length === 0) {
        throw new Error(`discord[${c.id}].slashCommands[].description is required`);
      }
    }
  }
  if (!c.routing) throw new Error(`discord[${c.id}].routing is required`);
  if (!c.delivery) throw new Error(`discord[${c.id}].delivery is required`);
  if (!c.limits) throw new Error(`discord[${c.id}].limits is required`);
}

/** Compute the Gateway intents bitfield from the declared name list. */
export function computeIntentsBitfield(intents: readonly DiscordIntentName[]): number {
  let bits = 0;
  for (const intent of intents) {
    bits |= DISCORD_INTENT_BITS[intent];
  }
  return bits;
}

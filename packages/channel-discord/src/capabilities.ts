import type { ChannelCapabilities } from '@declaragent/core';

/**
 * Discord API capabilities. See Phase-5 plan §5.2 for the per-block
 * degradation matrix. Voice *channels* (GUILD_STAGE_VOICE / voice rooms)
 * are off; voice *messages* are exposed via the file-upload path. Max
 * message length is 2000 characters for non-Nitro bots; attachments
 * cap at 25MB unless the server is boosted (out of scope for v0.9).
 */
export const DISCORD_CAPABILITIES: ChannelCapabilities = {
  supportsThreads: true,
  supportsReactions: true,
  supportsTypingIndicator: true,
  supportsFileUpload: true,
  supportsVoice: true,
  supportsButtons: true,
  supportsEditMessage: true,
  supportsDeleteMessage: true,
  supportsPresence: true,
  supportsSlashCommands: true,
  supportsDMs: true,
  supportsGroupChats: true,
  supportsVoiceChannels: false,
  maxMessageLength: 2000,
  maxAttachmentBytes: 25 * 1024 * 1024,
};

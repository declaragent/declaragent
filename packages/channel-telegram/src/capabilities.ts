import type { ChannelCapabilities } from '@declaragent/core';

/**
 * Telegram Bot API capabilities (as of Bot API 7.x). Topics-as-threads in
 * supergroups exist but are omitted from v0.9; see the Phase-5 plan §5.1
 * for rationale. Reactions require Bot API 7.0.
 */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  supportsThreads: false,
  supportsReactions: true,
  supportsTypingIndicator: true,
  supportsFileUpload: true,
  supportsVoice: true,
  supportsButtons: true,
  supportsEditMessage: true,
  supportsDeleteMessage: true,
  supportsPresence: false,
  supportsSlashCommands: true,
  supportsDMs: true,
  supportsGroupChats: true,
  supportsVoiceChannels: false,
  maxMessageLength: 4096,
  maxAttachmentBytes: 50 * 1024 * 1024,
};

import type { ChannelCapabilities } from '@declaragent/core';

/**
 * WhatsApp Cloud API capabilities per Phase-5 plan §5.4. Highlights:
 *  - Reply-buttons ≤3, list rows ≤10 (enforced upstream in `renderWhatsApp`).
 *  - No typing indicator, no edit/delete, no threads.
 *  - `requiresTemplateForOutbound`: true, `conversationWindowMs`: 24h.
 *  - DMs only — the Cloud API has no native group-chat concept exposed.
 */
export const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  supportsThreads: false,
  supportsReactions: true,
  supportsTypingIndicator: false,
  supportsFileUpload: true,
  supportsVoice: true,
  supportsButtons: true,
  supportsEditMessage: false,
  supportsDeleteMessage: false,
  supportsPresence: false,
  supportsSlashCommands: false,
  supportsDMs: true,
  supportsGroupChats: false,
  supportsVoiceChannels: false,
  maxMessageLength: 4096,
  maxAttachmentBytes: 100 * 1024 * 1024,
  requiresTemplateForOutbound: true,
  conversationWindowMs: 24 * 60 * 60 * 1000,
};

import type { ChannelCapabilities } from '@declaragent/core';

/**
 * Slack Web/Events API capabilities (2025). Key differences vs. Telegram:
 *
 * - No bot typing indicator (Slack deprecated the legacy `typing` event
 *   for bots; `users.setPresence` doesn't apply). `setTyping` is a
 *   no-op here and the capability reflects that.
 * - Block Kit is the rich format — buttons, headers, sections, dividers,
 *   context, images, action rows.
 * - `text` field is still required alongside `blocks` for notifications
 *   + search (enforced by the renderer + `instance.doSend`).
 * - File upload via the v2 external-upload flow; per-file cap is 1GB
 *   (workspace plan dependent — 1GB is the Enterprise Grid max).
 * - `maxMessageLength` is Slack's per-message limit for the `text` field.
 *   Individual `section` blocks cap at 3000; Block Kit limits are enforced
 *   by the core renderer.
 */
export const SLACK_CAPABILITIES: ChannelCapabilities = {
  supportsThreads: true,
  supportsReactions: true,
  supportsTypingIndicator: false,
  supportsFileUpload: true,
  supportsVoice: false,
  supportsButtons: true,
  supportsEditMessage: true,
  supportsDeleteMessage: true,
  supportsPresence: true,
  supportsSlashCommands: true,
  supportsDMs: true,
  supportsGroupChats: true,
  supportsVoiceChannels: false,
  maxMessageLength: 40_000,
  maxAttachmentBytes: 1024 * 1024 * 1024,
};

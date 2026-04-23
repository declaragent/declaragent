import type { Button, ChannelMessageContent, RichBlock } from '../types.js';
import { capabilitiesAwareRender } from './capabilities-degrade.js';
import { escapeMarkdownV2 } from './escape-markdown-v2.js';
import { blockToFallbackText } from './fallback.js';
import type { RendererContext } from './types.js';

/** Inline-keyboard button shape accepted by Telegram's Bot API. */
export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramSendTextPayload {
  kind: 'text';
  text: string;
  parse_mode: 'MarkdownV2';
  reply_markup?: { inline_keyboard: TelegramInlineButton[][] };
}

export interface TelegramSendDocumentPayload {
  kind: 'file';
  document: { url?: string; path?: string };
  caption?: string;
  parse_mode?: 'MarkdownV2';
}

export interface TelegramSendVoicePayload {
  kind: 'voice';
  voice: { url?: string; path?: string };
  duration?: number;
}

/**
 * Telegram's Bot API doesn't have first-class "templates"; renderers that
 * receive a template content pass the name + params through so the adapter
 * can decide whether to synthesize a text body or reject.
 */
export interface TelegramTemplatePayload {
  kind: 'template';
  name: string;
  params: Readonly<Record<string, string>>;
  language?: string;
}

export type TelegramPayload =
  | TelegramSendTextPayload
  | TelegramSendDocumentPayload
  | TelegramSendVoicePayload
  | TelegramTemplatePayload;

/**
 * Render unified `ChannelMessageContent` to a Telegram Bot API payload. The
 * adapter (slice 5) hands the returned struct to `sendMessage` /
 * `sendDocument` / `sendVoice` with the destination chat_id appended.
 *
 * Degradation: button-rows and images stay when the caller declared them
 * supported; otherwise `capabilitiesAwareRender` has already converted
 * them to text before we arrive here.
 */
export function renderTelegram(
  content: ChannelMessageContent,
  ctx: RendererContext,
): TelegramPayload {
  const degraded = capabilitiesAwareRender(content, ctx.capabilities);
  switch (degraded.kind) {
    case 'text':
      return {
        kind: 'text',
        text: escapeMarkdownV2(degraded.text),
        parse_mode: 'MarkdownV2',
      };
    case 'rich':
      return renderRich(degraded.blocks);
    case 'template':
      return {
        kind: 'template',
        name: degraded.name,
        params: degraded.params,
        ...(degraded.language !== undefined && { language: degraded.language }),
      };
    case 'file': {
      const payload: TelegramSendDocumentPayload = {
        kind: 'file',
        document: {},
      };
      if (degraded.file.url !== undefined) payload.document.url = degraded.file.url;
      if (degraded.file.path !== undefined) payload.document.path = degraded.file.path;
      if (degraded.caption !== undefined) {
        payload.caption = escapeMarkdownV2(degraded.caption);
        payload.parse_mode = 'MarkdownV2';
      }
      return payload;
    }
    case 'voice': {
      const payload: TelegramSendVoicePayload = { kind: 'voice', voice: {} };
      if (degraded.audio.url !== undefined) payload.voice.url = degraded.audio.url;
      if (degraded.audio.path !== undefined) payload.voice.path = degraded.audio.path;
      if (degraded.durationSec !== undefined) payload.duration = degraded.durationSec;
      return payload;
    }
  }
}

function renderRich(blocks: readonly RichBlock[]): TelegramSendTextPayload {
  const textParts: string[] = [];
  const keyboardRows: TelegramInlineButton[][] = [];

  for (const block of blocks) {
    if (block.kind === 'button-row') {
      keyboardRows.push(block.buttons.map(buttonToTelegram));
      continue;
    }
    textParts.push(renderBlockToMarkdown(block));
  }

  const payload: TelegramSendTextPayload = {
    kind: 'text',
    text: textParts.join('\n\n'),
    parse_mode: 'MarkdownV2',
  };
  if (keyboardRows.length > 0) {
    payload.reply_markup = { inline_keyboard: keyboardRows };
  }
  return payload;
}

function renderBlockToMarkdown(block: Exclude<RichBlock, { kind: 'button-row' }>): string {
  switch (block.kind) {
    case 'heading':
      return `*${escapeMarkdownV2(block.text)}*`;
    case 'paragraph':
      return escapeMarkdownV2(block.text);
    case 'code':
      // escapeMarkdownV2 preserves fences internally.
      return block.lang
        ? `\`\`\`${escapeMarkdownV2(block.lang)}\n${block.text}\n\`\`\``
        : `\`\`\`\n${block.text}\n\`\`\``;
    case 'bulleted-list':
      return block.items.map((item) => `• ${escapeMarkdownV2(item)}`).join('\n');
    case 'divider':
      return '—';
    case 'image':
      // Inline images in text mode degrade to a link + alt.
      return escapeMarkdownV2(blockToFallbackText(block));
    case 'context':
      return `_${escapeMarkdownV2(block.text)}_`;
  }
}

function buttonToTelegram(btn: Button): TelegramInlineButton {
  const out: TelegramInlineButton = { text: btn.label };
  if (btn.url !== undefined) out.url = btn.url;
  else out.callback_data = btn.id;
  return out;
}

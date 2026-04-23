import type { Button, ChannelMessageContent, RichBlock } from '../types.js';
import { capabilitiesAwareRender } from './capabilities-degrade.js';
import { blockToFallbackText } from './fallback.js';
import type { RendererContext } from './types.js';

// ── Meta Cloud API shapes (minimal subset we emit) ────────────────────────

export interface WhatsAppTextPayload {
  kind: 'text';
  body: string;
}

export interface WhatsAppInteractiveReplyButton {
  type: 'reply';
  reply: { id: string; title: string };
}

export interface WhatsAppInteractiveButton {
  type: 'button';
  body: { text: string };
  footer?: { text: string };
  action: { buttons: WhatsAppInteractiveReplyButton[] };
}

export interface WhatsAppListSectionRow {
  id: string;
  title: string;
  description?: string;
}

export interface WhatsAppInteractiveList {
  type: 'list';
  body: { text: string };
  footer?: { text: string };
  action: { button: string; sections: { rows: WhatsAppListSectionRow[] }[] };
}

export interface WhatsAppInteractivePayload {
  kind: 'interactive';
  interactive: WhatsAppInteractiveButton | WhatsAppInteractiveList;
}

export interface WhatsAppTemplatePayload {
  kind: 'template';
  name: string;
  language: string;
  params: Readonly<Record<string, string>>;
}

export interface WhatsAppMediaPayload {
  kind: 'media';
  media_type: 'document' | 'image' | 'audio' | 'video';
  source: { url?: string; path?: string };
  caption?: string;
}

export type WhatsAppPayload =
  | WhatsAppTextPayload
  | WhatsAppInteractivePayload
  | WhatsAppTemplatePayload
  | WhatsAppMediaPayload;

const MAX_REPLY_BUTTONS = 3;
const MAX_LIST_ROWS = 10;
const MAX_BUTTON_TITLE = 20; // Meta's cap on reply-button title length
const MAX_LIST_ROW_TITLE = 24;
const MAX_BODY = 1024;
const MAX_FOOTER = 60;
const DEFAULT_LIST_BUTTON_LABEL = 'Choose';
const DEFAULT_TEMPLATE_LANGUAGE = 'en_US';

/**
 * Render unified content to a WhatsApp Cloud API payload.
 *
 * Key degradations:
 *   - 0–3 buttons → interactive reply-button message.
 *   - 4–10 buttons → interactive list message.
 *   - 11+ buttons → collapses to numbered plain text (Cloud API won't
 *     accept more than 10 list rows anyway).
 *   - `code` blocks lose monospace (WhatsApp has no code formatting).
 *   - `image` blocks become a media payload with the image URL; further
 *     blocks in the same content collapse to fallback text captions.
 */
export function renderWhatsApp(
  content: ChannelMessageContent,
  ctx: RendererContext,
): WhatsAppPayload {
  const degraded = capabilitiesAwareRender(content, ctx.capabilities);
  switch (degraded.kind) {
    case 'text':
      return { kind: 'text', body: truncate(degraded.text, MAX_BODY) };
    case 'rich':
      return renderRich(degraded.blocks);
    case 'template':
      return {
        kind: 'template',
        name: degraded.name,
        language: degraded.language ?? DEFAULT_TEMPLATE_LANGUAGE,
        params: degraded.params,
      };
    case 'file': {
      const mediaType = inferMediaType(degraded.file.mimeType);
      const payload: WhatsAppMediaPayload = {
        kind: 'media',
        media_type: mediaType,
        source: {},
      };
      if (degraded.file.url !== undefined) payload.source.url = degraded.file.url;
      if (degraded.file.path !== undefined) payload.source.path = degraded.file.path;
      if (degraded.caption !== undefined) payload.caption = degraded.caption;
      return payload;
    }
    case 'voice': {
      const payload: WhatsAppMediaPayload = {
        kind: 'media',
        media_type: 'audio',
        source: {},
      };
      if (degraded.audio.url !== undefined) payload.source.url = degraded.audio.url;
      if (degraded.audio.path !== undefined) payload.source.path = degraded.audio.path;
      return payload;
    }
  }
}

function renderRich(blocks: readonly RichBlock[]): WhatsAppPayload {
  const textParts: string[] = [];
  const contextParts: string[] = [];
  let buttons: Button[] = [];
  let imageUrl: string | null = null;
  const imageCaptionSource: string | null = null;

  for (const block of blocks) {
    if (block.kind === 'button-row') {
      buttons = buttons.concat(block.buttons);
      continue;
    }
    switch (block.kind) {
      case 'heading':
        textParts.push(`*${block.text}*`);
        break;
      case 'paragraph':
        textParts.push(block.text);
        break;
      case 'code':
        // WhatsApp has no monospace; deliver plain.
        textParts.push(block.text);
        break;
      case 'bulleted-list':
        textParts.push(block.items.map((item) => `• ${item}`).join('\n'));
        break;
      case 'divider':
        textParts.push('—');
        break;
      case 'image':
        if (imageUrl === null) imageUrl = block.url;
        else textParts.push(blockToFallbackText(block));
        break;
      case 'context':
        contextParts.push(block.text);
        break;
    }
  }

  const bodyText = textParts.join('\n\n');
  const footerText = contextParts.length > 0 ? contextParts.join(' · ') : null;

  if (imageUrl !== null) {
    void imageCaptionSource;
    const payload: WhatsAppMediaPayload = {
      kind: 'media',
      media_type: 'image',
      source: { url: imageUrl },
    };
    if (bodyText.length > 0) payload.caption = truncate(bodyText, MAX_BODY);
    return payload;
  }

  if (buttons.length === 0) {
    const body = bodyText.length > 0 ? bodyText : (footerText ?? '');
    return { kind: 'text', body: truncate(body, MAX_BODY) };
  }

  if (buttons.length <= MAX_REPLY_BUTTONS) {
    const interactive: WhatsAppInteractiveButton = {
      type: 'button',
      body: { text: truncate(bodyText || ' ', MAX_BODY) },
      action: {
        buttons: buttons.map((btn) => ({
          type: 'reply',
          reply: { id: btn.id, title: truncate(btn.label, MAX_BUTTON_TITLE) },
        })),
      },
    };
    if (footerText !== null) {
      interactive.footer = { text: truncate(footerText, MAX_FOOTER) };
    }
    return { kind: 'interactive', interactive };
  }

  // 4+ buttons → list message. List caps rows at 10.
  const rows = buttons.slice(0, MAX_LIST_ROWS).map((btn) => {
    const row: WhatsAppListSectionRow = {
      id: btn.id,
      title: truncate(btn.label, MAX_LIST_ROW_TITLE),
    };
    return row;
  });
  if (buttons.length > MAX_LIST_ROWS) {
    // Anything past 10 goes to the body as numbered fallback text.
    const extras = buttons.slice(MAX_LIST_ROWS);
    const extraText = extras.map((b, i) => `(${MAX_LIST_ROWS + i + 1}) ${b.label}`).join('\n');
    textParts.push(extraText);
  }
  const interactive: WhatsAppInteractiveList = {
    type: 'list',
    body: { text: truncate(textParts.join('\n\n') || ' ', MAX_BODY) },
    action: { button: DEFAULT_LIST_BUTTON_LABEL, sections: [{ rows }] },
  };
  if (footerText !== null) {
    interactive.footer = { text: truncate(footerText, MAX_FOOTER) };
  }
  return { kind: 'interactive', interactive };
}

function inferMediaType(mime: string | undefined): WhatsAppMediaPayload['media_type'] {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

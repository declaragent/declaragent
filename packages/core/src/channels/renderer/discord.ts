import type { Button, MessageContent, RichBlock } from '../types.js';
import { capabilitiesAwareRender } from './capabilities-degrade.js';
import { blockToFallbackText } from './fallback.js';
import type { RendererContext } from './types.js';

/**
 * Minimal embed shape — mirrors the fields discord.js's `EmbedBuilder`
 * produces. Adapter-side code may convert to the typed EmbedBuilder if
 * it prefers.
 */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text: string };
  image?: { url: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface DiscordButton {
  type: 2; // Button
  style: 1 | 2 | 3 | 4 | 5; // primary / secondary / success / danger / link
  label: string;
  custom_id?: string;
  url?: string;
}

export interface DiscordActionRow {
  type: 1; // ActionRow
  components: DiscordButton[];
}

export interface DiscordFilePart {
  name: string;
  url?: string;
  path?: string;
}

export interface DiscordSendTextPayload {
  kind: 'text';
  content: string;
}

export interface DiscordSendRichPayload {
  kind: 'rich';
  content?: string;
  embeds: DiscordEmbed[];
  components: DiscordActionRow[];
}

export interface DiscordSendFilePayload {
  kind: 'file';
  files: DiscordFilePart[];
  content?: string;
}

export interface DiscordSendVoicePayload {
  kind: 'voice';
  files: DiscordFilePart[];
}

export interface DiscordTemplatePayload {
  kind: 'template';
  name: string;
  params: Readonly<Record<string, string>>;
  language?: string;
}

export type DiscordPayload =
  | DiscordSendTextPayload
  | DiscordSendRichPayload
  | DiscordSendFilePayload
  | DiscordSendVoicePayload
  | DiscordTemplatePayload;

/** Max buttons per ActionRow. More than 5 splits into adjacent rows. */
const MAX_BUTTONS_PER_ROW = 5;

export function renderDiscord(content: MessageContent, ctx: RendererContext): DiscordPayload {
  const degraded = capabilitiesAwareRender(content, ctx.capabilities);
  switch (degraded.kind) {
    case 'text':
      return { kind: 'text', content: degraded.text };
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
      const part: DiscordFilePart = { name: degraded.file.name ?? 'file' };
      if (degraded.file.url !== undefined) part.url = degraded.file.url;
      if (degraded.file.path !== undefined) part.path = degraded.file.path;
      const payload: DiscordSendFilePayload = { kind: 'file', files: [part] };
      if (degraded.caption !== undefined) payload.content = degraded.caption;
      return payload;
    }
    case 'voice': {
      const part: DiscordFilePart = { name: degraded.audio.name ?? 'voice' };
      if (degraded.audio.url !== undefined) part.url = degraded.audio.url;
      if (degraded.audio.path !== undefined) part.path = degraded.audio.path;
      return { kind: 'voice', files: [part] };
    }
  }
}

function renderRich(blocks: readonly RichBlock[]): DiscordSendRichPayload {
  const embedBlocks: DiscordEmbed = {};
  const descriptionParts: string[] = [];
  const extraContent: string[] = [];
  const rows: DiscordActionRow[] = [];

  for (const block of blocks) {
    if (block.kind === 'button-row') {
      rows.push(...splitButtonsIntoRows(block.buttons));
      continue;
    }
    switch (block.kind) {
      case 'heading':
        if (embedBlocks.title === undefined) embedBlocks.title = block.text;
        else descriptionParts.push(`**${block.text}**`);
        break;
      case 'paragraph':
        descriptionParts.push(block.text);
        break;
      case 'code':
        descriptionParts.push(
          block.lang
            ? `\`\`\`${block.lang}\n${block.text}\n\`\`\``
            : `\`\`\`\n${block.text}\n\`\`\``,
        );
        break;
      case 'bulleted-list':
        descriptionParts.push(block.items.map((item) => `• ${item}`).join('\n'));
        break;
      case 'divider':
        descriptionParts.push('—');
        break;
      case 'image':
        if (embedBlocks.image === undefined) embedBlocks.image = { url: block.url };
        else extraContent.push(blockToFallbackText(block));
        break;
      case 'context':
        embedBlocks.footer = { text: block.text };
        break;
    }
  }

  if (descriptionParts.length > 0) {
    embedBlocks.description = descriptionParts.join('\n\n');
  }

  const payload: DiscordSendRichPayload = {
    kind: 'rich',
    embeds: Object.keys(embedBlocks).length > 0 ? [embedBlocks] : [],
    components: rows,
  };
  if (extraContent.length > 0) payload.content = extraContent.join('\n');
  return payload;
}

function splitButtonsIntoRows(buttons: readonly Button[]): DiscordActionRow[] {
  const rows: DiscordActionRow[] = [];
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push({
      type: 1,
      components: buttons.slice(i, i + MAX_BUTTONS_PER_ROW).map(buttonToDiscord),
    });
  }
  return rows;
}

function buttonToDiscord(btn: Button): DiscordButton {
  const out: DiscordButton = {
    type: 2,
    style: discordStyle(btn),
    label: btn.label,
  };
  if (btn.url !== undefined) out.url = btn.url;
  else out.custom_id = btn.id;
  return out;
}

function discordStyle(btn: Button): DiscordButton['style'] {
  if (btn.url !== undefined) return 5; // link
  switch (btn.style) {
    case 'primary':
      return 1;
    case 'danger':
      return 4;
    default:
      return 2;
  }
}

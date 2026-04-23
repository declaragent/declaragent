import type { Button, ChannelMessageContent, RichBlock } from '../types.js';
import { validateBlockKit } from './block-kit-validator.js';
import { capabilitiesAwareRender } from './capabilities-degrade.js';
import { blockToFallbackText } from './fallback.js';
import type { RendererContext } from './types.js';

// ── Block Kit types (minimal subset we emit) ──────────────────────────────

export interface SlackHeaderBlock {
  type: 'header';
  text: { type: 'plain_text'; text: string };
}
export interface SlackSectionBlock {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
}
export interface SlackDividerBlock {
  type: 'divider';
}
export interface SlackActionsBlock {
  type: 'actions';
  elements: SlackButtonElement[];
}
export interface SlackButtonElement {
  type: 'button';
  text: { type: 'plain_text'; text: string };
  action_id: string;
  style?: 'primary' | 'danger';
  url?: string;
}
export interface SlackContextBlock {
  type: 'context';
  elements: { type: 'mrkdwn'; text: string }[];
}
export interface SlackImageBlock {
  type: 'image';
  image_url: string;
  alt_text: string;
}

export type SlackBlock =
  | SlackHeaderBlock
  | SlackSectionBlock
  | SlackDividerBlock
  | SlackActionsBlock
  | SlackContextBlock
  | SlackImageBlock;

// ── Payloads ──────────────────────────────────────────────────────────────

export interface SlackFilePart {
  name: string;
  url?: string;
  path?: string;
}

export interface SlackSendTextPayload {
  kind: 'text';
  text: string;
  blocks?: never;
}

export interface SlackSendRichPayload {
  kind: 'rich';
  /** Always-included plain-text summary for notifications + search. */
  text: string;
  blocks: SlackBlock[];
}

export interface SlackSendFilePayload {
  kind: 'file';
  text: string;
  files: SlackFilePart[];
}

export interface SlackSendVoicePayload {
  kind: 'voice';
  text: string;
  files: SlackFilePart[];
}

export interface SlackTemplatePayload {
  kind: 'template';
  name: string;
  params: Readonly<Record<string, string>>;
  language?: string;
}

export type SlackPayload =
  | SlackSendTextPayload
  | SlackSendRichPayload
  | SlackSendFilePayload
  | SlackSendVoicePayload
  | SlackTemplatePayload;

const SECTION_TEXT_CAP = 3000;
const BUTTON_LABEL_CAP = 75;
const ACTION_ID_CAP = 255;
const ACTIONS_CAP = 5;

/**
 * Render to a Slack Block Kit payload. The returned `text` field is
 * always set — Slack uses it for mobile notifications and search, even
 * when `blocks` are present.
 *
 * The output is validated via `validateBlockKit` so a shape problem
 * surfaces here (with a path pointer) rather than as Slack's terse 400.
 */
export function renderSlack(content: ChannelMessageContent, ctx: RendererContext): SlackPayload {
  const degraded = capabilitiesAwareRender(content, ctx.capabilities);
  switch (degraded.kind) {
    case 'text':
      return { kind: 'text', text: degraded.text };
    case 'rich': {
      const { text, blocks } = renderRich(degraded.blocks);
      validateBlockKit(blocks as unknown[]);
      return { kind: 'rich', text, blocks };
    }
    case 'template':
      return {
        kind: 'template',
        name: degraded.name,
        params: degraded.params,
        ...(degraded.language !== undefined && { language: degraded.language }),
      };
    case 'file': {
      const part: SlackFilePart = { name: degraded.file.name ?? 'file' };
      if (degraded.file.url !== undefined) part.url = degraded.file.url;
      if (degraded.file.path !== undefined) part.path = degraded.file.path;
      return { kind: 'file', text: degraded.caption ?? part.name, files: [part] };
    }
    case 'voice': {
      const part: SlackFilePart = { name: degraded.audio.name ?? 'voice' };
      if (degraded.audio.url !== undefined) part.url = degraded.audio.url;
      if (degraded.audio.path !== undefined) part.path = degraded.audio.path;
      return { kind: 'voice', text: 'voice message', files: [part] };
    }
  }
}

function renderRich(blocks: readonly RichBlock[]): { text: string; blocks: SlackBlock[] } {
  const out: SlackBlock[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.kind === 'button-row') {
      const elements = block.buttons
        .slice(0, ACTIONS_CAP)
        .map(buttonToSlack)
        .filter((e): e is SlackButtonElement => e !== null);
      if (elements.length > 0) {
        out.push({ type: 'actions', elements });
        textParts.push(block.buttons.map((b) => b.label).join(' / '));
      }
      continue;
    }
    switch (block.kind) {
      case 'heading':
        out.push({
          type: 'header',
          text: { type: 'plain_text', text: block.text.slice(0, 150) },
        });
        textParts.push(block.text);
        break;
      case 'paragraph':
        out.push({
          type: 'section',
          text: { type: 'mrkdwn', text: block.text.slice(0, SECTION_TEXT_CAP) },
        });
        textParts.push(block.text);
        break;
      case 'code': {
        const body = block.lang
          ? `\`\`\`${block.lang}\n${block.text}\n\`\`\``
          : `\`\`\`\n${block.text}\n\`\`\``;
        out.push({
          type: 'section',
          text: { type: 'mrkdwn', text: body.slice(0, SECTION_TEXT_CAP) },
        });
        textParts.push(block.text);
        break;
      }
      case 'bulleted-list': {
        const body = block.items.map((item) => `• ${item}`).join('\n');
        out.push({
          type: 'section',
          text: { type: 'mrkdwn', text: body.slice(0, SECTION_TEXT_CAP) },
        });
        textParts.push(block.items.join(', '));
        break;
      }
      case 'divider':
        out.push({ type: 'divider' });
        break;
      case 'image':
        out.push({
          type: 'image',
          image_url: block.url,
          alt_text: block.alt ?? '',
        });
        textParts.push(blockToFallbackText(block));
        break;
      case 'context':
        out.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: block.text }],
        });
        textParts.push(block.text);
        break;
    }
  }

  return {
    text: textParts.join(' ').slice(0, 40_000),
    blocks: out,
  };
}

function buttonToSlack(btn: Button): SlackButtonElement | null {
  if (btn.label.length === 0) return null;
  const out: SlackButtonElement = {
    type: 'button',
    text: { type: 'plain_text', text: btn.label.slice(0, BUTTON_LABEL_CAP) },
    action_id: btn.id.slice(0, ACTION_ID_CAP),
  };
  if (btn.style === 'primary' || btn.style === 'danger') out.style = btn.style;
  if (btn.url !== undefined) out.url = btn.url;
  return out;
}

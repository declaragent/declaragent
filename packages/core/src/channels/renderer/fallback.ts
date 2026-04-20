import type { RichBlock } from '../types.js';

/**
 * Render one rich block to plain text — used both as a fallback for
 * platforms that can't render a block kind natively (e.g. WhatsApp with a
 * `code` block gets the text verbatim) and as the building block of the
 * "degraded tail" appended when capabilities force us to drop structure.
 */
export function blockToFallbackText(block: RichBlock): string {
  switch (block.kind) {
    case 'heading':
      return `*${block.text}*`;
    case 'paragraph':
      return block.text;
    case 'code':
      // Keep the fenced form so downstream splitting still spots the fence.
      return block.lang
        ? `\`\`\`${block.lang}\n${block.text}\n\`\`\``
        : `\`\`\`\n${block.text}\n\`\`\``;
    case 'bulleted-list':
      return block.items.map((item) => `• ${item}`).join('\n');
    case 'button-row': {
      // Degraded buttons render as a numbered list the human can reply to.
      return block.buttons
        .map((b, i) => `(${i + 1}) ${b.label}${b.url ? ` — ${b.url}` : ''}`)
        .join('\n');
    }
    case 'divider':
      return '—';
    case 'image':
      return block.alt ? `[image: ${block.alt}] ${block.url}` : `[image] ${block.url}`;
    case 'context':
      return `_${block.text}_`;
  }
}

/**
 * Render a whole array of blocks to plain text. Used by capability
 * degradation when every block is unsupported.
 */
export function blocksToFallbackText(blocks: readonly RichBlock[]): string {
  return blocks.map(blockToFallbackText).join('\n\n');
}

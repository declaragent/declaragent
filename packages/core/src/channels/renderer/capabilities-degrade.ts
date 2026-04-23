import type { ChannelCapabilities, ChannelMessageContent, RichBlock } from '../types.js';
import { blockToFallbackText } from './fallback.js';

/**
 * Decide whether a block is renderable given a channel's capabilities.
 * Block kinds that don't require a specific capability (paragraph,
 * heading, code, divider, context, bulleted-list) are always supported.
 */
function isBlockSupported(block: RichBlock, caps: ChannelCapabilities): boolean {
  switch (block.kind) {
    case 'button-row':
      return caps.supportsButtons;
    case 'image':
      return caps.supportsFileUpload;
    default:
      return true;
  }
}

/**
 * Capability-aware degradation pass. Every `RichBlock` is either kept
 * as-is (if the channel supports it) or converted to plain text that
 * tails the remaining blocks. When every block degrades, the result
 * collapses to a `text` content with all fallback text joined.
 *
 * Non-rich content kinds (`text`, `template`, `file`, `voice`) pass
 * through unchanged — they have their own capability handling inside
 * each platform renderer.
 *
 * The render decision is local to the block; ordering is preserved.
 * Slice 4 scope: blocks become a fallback text paragraph at the end of
 * the supported blocks. Slice 13 may add fancier strategies.
 */
export function capabilitiesAwareRender(
  content: ChannelMessageContent,
  caps: ChannelCapabilities,
): ChannelMessageContent {
  if (content.kind !== 'rich') return content;

  const supported: RichBlock[] = [];
  const fallback: string[] = [];
  for (const block of content.blocks) {
    if (isBlockSupported(block, caps)) supported.push(block);
    else fallback.push(blockToFallbackText(block));
  }

  if (supported.length === 0) {
    return { kind: 'text', text: fallback.join('\n\n'), format: 'markdown' };
  }
  if (fallback.length > 0) {
    supported.push({ kind: 'paragraph', text: fallback.join('\n\n') });
  }
  return { kind: 'rich', blocks: supported };
}

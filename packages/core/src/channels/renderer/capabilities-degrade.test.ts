import { describe, expect, test } from 'bun:test';
import type { ChannelCapabilities, ChannelMessageContent } from '../types.js';
import { capabilitiesAwareRender } from './capabilities-degrade.js';
import { blockToFallbackText, blocksToFallbackText } from './fallback.js';

function caps(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    supportsThreads: false,
    supportsReactions: false,
    supportsTypingIndicator: false,
    supportsFileUpload: false,
    supportsVoice: false,
    supportsButtons: false,
    supportsEditMessage: false,
    supportsDeleteMessage: false,
    supportsPresence: false,
    supportsSlashCommands: false,
    supportsDMs: true,
    supportsGroupChats: false,
    supportsVoiceChannels: false,
    maxMessageLength: 4096,
    maxAttachmentBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

describe('blockToFallbackText', () => {
  test('heading emphasises with markdown bold', () => {
    expect(blockToFallbackText({ kind: 'heading', text: 'Order 42' })).toBe('*Order 42*');
  });

  test('code preserves the fence and language tag', () => {
    const out = blockToFallbackText({ kind: 'code', text: 'const x = 1;', lang: 'ts' });
    expect(out).toContain('```ts');
    expect(out).toContain('const x = 1;');
    expect(out.endsWith('```')).toBe(true);
  });

  test('bulleted-list renders each item on its own line', () => {
    const out = blockToFallbackText({ kind: 'bulleted-list', items: ['a', 'b', 'c'] });
    expect(out).toBe('• a\n• b\n• c');
  });

  test('button-row degrades to numbered list with optional URL', () => {
    const out = blockToFallbackText({
      kind: 'button-row',
      buttons: [
        { id: 'yes', label: 'Yes' },
        { id: 'link', label: 'Docs', url: 'https://docs' },
      ],
    });
    expect(out).toBe('(1) Yes\n(2) Docs — https://docs');
  });

  test('image falls back with alt text when present', () => {
    expect(blockToFallbackText({ kind: 'image', url: 'https://i/1.png', alt: 'cat' })).toBe(
      '[image: cat] https://i/1.png',
    );
    expect(blockToFallbackText({ kind: 'image', url: 'https://i/2.png' })).toBe(
      '[image] https://i/2.png',
    );
  });

  test('divider + context render reasonably', () => {
    expect(blockToFallbackText({ kind: 'divider' })).toBe('—');
    expect(blockToFallbackText({ kind: 'context', text: 'fine print' })).toBe('_fine print_');
  });

  test('blocksToFallbackText joins with a paragraph gap', () => {
    const out = blocksToFallbackText([
      { kind: 'heading', text: 'H' },
      { kind: 'paragraph', text: 'body' },
    ]);
    expect(out).toBe('*H*\n\nbody');
  });
});

describe('capabilitiesAwareRender', () => {
  test('passes plain text through unchanged', () => {
    const content: ChannelMessageContent = { kind: 'text', text: 'hi', format: 'markdown' };
    expect(capabilitiesAwareRender(content, caps())).toEqual(content);
  });

  test('keeps all supported blocks when caps allow', () => {
    const content: ChannelMessageContent = {
      kind: 'rich',
      blocks: [
        { kind: 'heading', text: 'H' },
        { kind: 'paragraph', text: 'p' },
        { kind: 'button-row', buttons: [{ id: 'a', label: 'A' }] },
      ],
    };
    const out = capabilitiesAwareRender(content, caps({ supportsButtons: true }));
    expect(out.kind).toBe('rich');
    if (out.kind === 'rich') expect(out.blocks).toHaveLength(3);
  });

  test('drops button-row when channel lacks button support, appends fallback text', () => {
    const content: ChannelMessageContent = {
      kind: 'rich',
      blocks: [
        { kind: 'paragraph', text: 'Pick one:' },
        {
          kind: 'button-row',
          buttons: [
            { id: 'y', label: 'Yes' },
            { id: 'n', label: 'No' },
          ],
        },
      ],
    };
    const out = capabilitiesAwareRender(content, caps({ supportsButtons: false }));
    expect(out.kind).toBe('rich');
    if (out.kind === 'rich') {
      expect(out.blocks).toHaveLength(2);
      const last = out.blocks[out.blocks.length - 1];
      expect(last?.kind).toBe('paragraph');
      if (last?.kind === 'paragraph') {
        expect(last.text).toContain('(1) Yes');
        expect(last.text).toContain('(2) No');
      }
    }
  });

  test('collapses to text when every block is unsupported', () => {
    const content: ChannelMessageContent = {
      kind: 'rich',
      blocks: [
        { kind: 'button-row', buttons: [{ id: 'a', label: 'A' }] },
        { kind: 'image', url: 'https://i' },
      ],
    };
    const out = capabilitiesAwareRender(
      content,
      caps({ supportsButtons: false, supportsFileUpload: false }),
    );
    expect(out.kind).toBe('text');
    if (out.kind === 'text') {
      expect(out.text).toContain('(1) A');
      expect(out.text).toContain('[image]');
    }
  });

  test('image kept when file upload is supported', () => {
    const content: ChannelMessageContent = {
      kind: 'rich',
      blocks: [{ kind: 'image', url: 'https://i' }],
    };
    const out = capabilitiesAwareRender(content, caps({ supportsFileUpload: true }));
    expect(out.kind).toBe('rich');
    if (out.kind === 'rich') expect(out.blocks[0]?.kind).toBe('image');
  });

  test('non-rich kinds pass through', () => {
    const template: ChannelMessageContent = {
      kind: 'template',
      name: 't1',
      params: { a: '1' },
    };
    expect(capabilitiesAwareRender(template, caps())).toBe(template);
    const file: ChannelMessageContent = { kind: 'file', file: { id: 'f', name: 'f.txt' } };
    expect(capabilitiesAwareRender(file, caps())).toBe(file);
  });
});

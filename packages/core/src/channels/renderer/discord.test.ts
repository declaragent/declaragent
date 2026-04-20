import { describe, expect, test } from 'bun:test';
import type { ChannelCapabilities } from '../types.js';
import { renderDiscord } from './discord.js';

function caps(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    supportsThreads: true,
    supportsReactions: true,
    supportsTypingIndicator: true,
    supportsFileUpload: true,
    supportsVoice: true,
    supportsButtons: true,
    supportsEditMessage: true,
    supportsDeleteMessage: true,
    supportsPresence: true,
    supportsSlashCommands: true,
    supportsDMs: true,
    supportsGroupChats: true,
    supportsVoiceChannels: true,
    maxMessageLength: 2000,
    maxAttachmentBytes: 25 * 1024 * 1024,
    ...overrides,
  };
}

describe('renderDiscord', () => {
  test('renders plain text to { content }', () => {
    const out = renderDiscord({ kind: 'text', text: 'hi' }, { capabilities: caps() });
    expect(out.kind).toBe('text');
    if (out.kind === 'text') expect(out.content).toBe('hi');
  });

  test('builds an embed with title + description + footer', () => {
    const out = renderDiscord(
      {
        kind: 'rich',
        blocks: [
          { kind: 'heading', text: 'Order' },
          { kind: 'paragraph', text: 'shipped' },
          { kind: 'context', text: 'tracking #42' },
        ],
      },
      { capabilities: caps() },
    );
    expect(out.kind).toBe('rich');
    if (out.kind !== 'rich') return;
    const embed = out.embeds[0];
    expect(embed?.title).toBe('Order');
    expect(embed?.description).toContain('shipped');
    expect(embed?.footer?.text).toBe('tracking #42');
  });

  test('button-row becomes an ActionRow with correct custom_id/url splits', () => {
    const out = renderDiscord(
      {
        kind: 'rich',
        blocks: [
          {
            kind: 'button-row',
            buttons: [
              { id: 'go', label: 'Go', style: 'primary' },
              { id: 'link', label: 'Docs', url: 'https://docs' },
              { id: 'cancel', label: 'Cancel', style: 'danger' },
            ],
          },
        ],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'rich') throw new Error('expected rich payload');
    const row = out.components[0];
    expect(row?.components).toHaveLength(3);
    const [go, link, cancel] = row?.components ?? [];
    expect(go?.custom_id).toBe('go');
    expect(go?.style).toBe(1); // primary
    expect(link?.url).toBe('https://docs');
    expect(link?.style).toBe(5); // link
    expect(cancel?.style).toBe(4); // danger
  });

  test('splits >5 buttons into multiple ActionRows', () => {
    const buttons = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, label: `B${i}` }));
    const out = renderDiscord(
      { kind: 'rich', blocks: [{ kind: 'button-row', buttons }] },
      { capabilities: caps() },
    );
    if (out.kind !== 'rich') throw new Error('expected rich');
    expect(out.components).toHaveLength(2);
    expect(out.components[0]?.components).toHaveLength(5);
    expect(out.components[1]?.components).toHaveLength(2);
  });

  test('image becomes embed.image when first encountered', () => {
    const out = renderDiscord(
      {
        kind: 'rich',
        blocks: [
          { kind: 'heading', text: 'pics' },
          { kind: 'image', url: 'https://i/1' },
          { kind: 'image', url: 'https://i/2' },
        ],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'rich') throw new Error('expected rich');
    expect(out.embeds[0]?.image?.url).toBe('https://i/1');
    expect(out.content).toContain('https://i/2');
  });

  test('file payloads carry a DiscordFilePart', () => {
    const out = renderDiscord(
      {
        kind: 'file',
        file: { id: 'f', name: 'report.md', path: '/tmp/r.md' },
        caption: 'see attached',
      },
      { capabilities: caps() },
    );
    expect(out.kind).toBe('file');
    if (out.kind !== 'file') return;
    expect(out.files[0]?.path).toBe('/tmp/r.md');
    expect(out.content).toBe('see attached');
  });

  test('voice becomes a files payload', () => {
    const out = renderDiscord(
      { kind: 'voice', audio: { id: 'a', path: '/tmp/a.mp3', name: 'a.mp3' } },
      { capabilities: caps() },
    );
    expect(out.kind).toBe('voice');
    if (out.kind === 'voice') expect(out.files[0]?.name).toBe('a.mp3');
  });
});

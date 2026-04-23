import { describe, expect, test } from 'bun:test';
import type { ChannelCapabilities, ChannelMessageContent } from '../types.js';
import { renderTelegram } from './telegram.js';

function caps(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    supportsThreads: false,
    supportsReactions: true,
    supportsTypingIndicator: true,
    supportsFileUpload: true,
    supportsVoice: true,
    supportsButtons: true,
    supportsEditMessage: true,
    supportsDeleteMessage: true,
    supportsPresence: false,
    supportsSlashCommands: true,
    supportsDMs: true,
    supportsGroupChats: true,
    supportsVoiceChannels: false,
    maxMessageLength: 4096,
    maxAttachmentBytes: 50 * 1024 * 1024,
    ...overrides,
  };
}

describe('renderTelegram', () => {
  test('escapes plain text as MarkdownV2', () => {
    const out = renderTelegram({ kind: 'text', text: 'hi. world!' }, { capabilities: caps() });
    expect(out.kind).toBe('text');
    if (out.kind === 'text') {
      expect(out.parse_mode).toBe('MarkdownV2');
      expect(out.text).toContain('\\.');
      expect(out.text).toContain('\\!');
    }
  });

  test('renders a rich message with heading + paragraph + button row', () => {
    const content: ChannelMessageContent = {
      kind: 'rich',
      blocks: [
        { kind: 'heading', text: 'Order' },
        { kind: 'paragraph', text: 'Status: shipped.' },
        {
          kind: 'button-row',
          buttons: [
            { id: 'track', label: 'Track' },
            { id: 'cancel', label: 'Cancel', style: 'danger' },
          ],
        },
      ],
    };
    const out = renderTelegram(content, { capabilities: caps() });
    expect(out.kind).toBe('text');
    if (out.kind !== 'text') return;
    expect(out.text).toContain('*Order*');
    expect(out.text).toContain('Status: shipped');
    expect(out.reply_markup?.inline_keyboard).toHaveLength(1);
    const row = out.reply_markup?.inline_keyboard[0];
    expect(row?.[0]).toEqual({ text: 'Track', callback_data: 'track' });
    expect(row?.[1]?.callback_data).toBe('cancel');
  });

  test('link buttons use `url`, callback buttons use `callback_data`', () => {
    const out = renderTelegram(
      {
        kind: 'rich',
        blocks: [
          {
            kind: 'button-row',
            buttons: [
              { id: 'link', label: 'Docs', url: 'https://docs' },
              { id: 'cb', label: 'Tap' },
            ],
          },
        ],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'text') throw new Error('expected text payload');
    const row = out.reply_markup?.inline_keyboard[0];
    expect(row?.[0]).toEqual({ text: 'Docs', url: 'https://docs' });
    expect(row?.[1]?.callback_data).toBe('cb');
    expect(row?.[1]?.url).toBeUndefined();
  });

  test('drops buttons when capability is off (capabilitiesAwareRender collapses)', () => {
    const out = renderTelegram(
      {
        kind: 'rich',
        blocks: [
          { kind: 'paragraph', text: 'pick:' },
          { kind: 'button-row', buttons: [{ id: 'a', label: 'A' }] },
        ],
      },
      { capabilities: caps({ supportsButtons: false }) },
    );
    if (out.kind !== 'text') throw new Error('expected text');
    expect(out.reply_markup).toBeUndefined();
    expect(out.text).toContain('\\(1\\) A');
  });

  test('preserves fenced code inside rich renders', () => {
    const out = renderTelegram(
      {
        kind: 'rich',
        blocks: [{ kind: 'code', text: 'x.y.z', lang: 'ts' }],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'text') throw new Error('expected text');
    expect(out.text).toContain('```ts');
    expect(out.text).toContain('x.y.z');
  });

  test('file payloads include caption with MarkdownV2 escape', () => {
    const out = renderTelegram(
      {
        kind: 'file',
        file: { id: 'f', name: 'n.pdf', path: '/tmp/n.pdf' },
        caption: 'Here. Now.',
      },
      { capabilities: caps() },
    );
    expect(out.kind).toBe('file');
    if (out.kind !== 'file') return;
    expect(out.document.path).toBe('/tmp/n.pdf');
    expect(out.caption).toContain('\\.');
    expect(out.parse_mode).toBe('MarkdownV2');
  });

  test('voice payloads forward path + duration', () => {
    const out = renderTelegram(
      {
        kind: 'voice',
        audio: { id: 'a', path: '/tmp/a.ogg' },
        durationSec: 3,
      },
      { capabilities: caps() },
    );
    expect(out.kind).toBe('voice');
    if (out.kind !== 'voice') return;
    expect(out.voice.path).toBe('/tmp/a.ogg');
    expect(out.duration).toBe(3);
  });
});

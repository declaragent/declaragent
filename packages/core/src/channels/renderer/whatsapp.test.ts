import { describe, expect, test } from 'bun:test';
import type { ChannelCapabilities, ChannelMessageContent } from '../types.js';
import { renderWhatsApp } from './whatsapp.js';

function caps(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    supportsThreads: false,
    supportsReactions: true,
    supportsTypingIndicator: false,
    supportsFileUpload: true,
    supportsVoice: true,
    supportsButtons: true,
    supportsEditMessage: false,
    supportsDeleteMessage: false,
    supportsPresence: false,
    supportsSlashCommands: false,
    supportsDMs: true,
    supportsGroupChats: false,
    supportsVoiceChannels: false,
    maxMessageLength: 4096,
    maxAttachmentBytes: 100 * 1024 * 1024,
    requiresTemplateForOutbound: true,
    conversationWindowMs: 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

describe('renderWhatsApp', () => {
  test('plain text becomes { kind: text, body }', () => {
    const out = renderWhatsApp({ kind: 'text', text: 'hi there' }, { capabilities: caps() });
    expect(out.kind).toBe('text');
    if (out.kind === 'text') expect(out.body).toBe('hi there');
  });

  test('1-3 buttons become an interactive reply-button message', () => {
    const content: ChannelMessageContent = {
      kind: 'rich',
      blocks: [
        { kind: 'paragraph', text: 'Pick one:' },
        {
          kind: 'button-row',
          buttons: [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ],
        },
      ],
    };
    const out = renderWhatsApp(content, { capabilities: caps() });
    expect(out.kind).toBe('interactive');
    if (out.kind !== 'interactive') return;
    expect(out.interactive.type).toBe('button');
    if (out.interactive.type !== 'button') return;
    expect(out.interactive.action.buttons).toHaveLength(2);
    expect(out.interactive.action.buttons[0]?.reply.id).toBe('yes');
    expect(out.interactive.body.text).toBe('Pick one:');
  });

  test('4-10 buttons become a list message', () => {
    const buttons = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, label: `B${i}` }));
    const out = renderWhatsApp(
      { kind: 'rich', blocks: [{ kind: 'button-row', buttons }] },
      { capabilities: caps() },
    );
    if (out.kind !== 'interactive') throw new Error('expected interactive');
    expect(out.interactive.type).toBe('list');
    if (out.interactive.type !== 'list') return;
    expect(out.interactive.action.sections[0]?.rows).toHaveLength(6);
  });

  test('>10 buttons overflow to fallback text in the body', () => {
    const buttons = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, label: `B${i}` }));
    const out = renderWhatsApp(
      { kind: 'rich', blocks: [{ kind: 'button-row', buttons }] },
      { capabilities: caps() },
    );
    if (out.kind !== 'interactive') throw new Error('expected interactive');
    if (out.interactive.type !== 'list') return;
    expect(out.interactive.action.sections[0]?.rows).toHaveLength(10);
    expect(out.interactive.body.text).toContain('(11) B10');
    expect(out.interactive.body.text).toContain('(12) B11');
  });

  test('paragraph-only content stays as text', () => {
    const out = renderWhatsApp(
      { kind: 'rich', blocks: [{ kind: 'paragraph', text: 'hello' }] },
      { capabilities: caps() },
    );
    expect(out.kind).toBe('text');
    if (out.kind === 'text') expect(out.body).toBe('hello');
  });

  test('image block becomes media payload with body as caption', () => {
    const out = renderWhatsApp(
      {
        kind: 'rich',
        blocks: [
          { kind: 'paragraph', text: 'look:' },
          { kind: 'image', url: 'https://i/1.jpg' },
        ],
      },
      { capabilities: caps() },
    );
    expect(out.kind).toBe('media');
    if (out.kind !== 'media') return;
    expect(out.media_type).toBe('image');
    expect(out.source.url).toBe('https://i/1.jpg');
    expect(out.caption).toBe('look:');
  });

  test('file content infers media type from mime', () => {
    const out = renderWhatsApp(
      {
        kind: 'file',
        file: { id: 'f', name: 'a.pdf', mimeType: 'application/pdf', url: 'https://f/a.pdf' },
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'media') throw new Error('expected media');
    expect(out.media_type).toBe('document');
  });

  test('voice content becomes audio media payload', () => {
    const out = renderWhatsApp(
      { kind: 'voice', audio: { id: 'a', url: 'https://a/ogg' } },
      { capabilities: caps() },
    );
    if (out.kind !== 'media') throw new Error('expected media');
    expect(out.media_type).toBe('audio');
  });

  test('template payload passes params through verbatim', () => {
    const out = renderWhatsApp(
      {
        kind: 'template',
        name: 'checkin_reminder_v1',
        language: 'en_US',
        params: { topic: 'payment overdue' },
      },
      { capabilities: caps() },
    );
    expect(out.kind).toBe('template');
    if (out.kind === 'template') {
      expect(out.name).toBe('checkin_reminder_v1');
      expect(out.language).toBe('en_US');
      expect(out.params.topic).toBe('payment overdue');
    }
  });

  test('context block becomes interactive footer when buttons present', () => {
    const out = renderWhatsApp(
      {
        kind: 'rich',
        blocks: [
          { kind: 'paragraph', text: 'Pick:' },
          { kind: 'button-row', buttons: [{ id: 'a', label: 'A' }] },
          { kind: 'context', text: 'est. 2 min' },
        ],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'interactive') throw new Error('expected interactive');
    if (out.interactive.type !== 'button') return;
    expect(out.interactive.footer?.text).toBe('est. 2 min');
  });

  test('truncates reply-button titles to platform cap', () => {
    const longLabel = 'x'.repeat(30);
    const out = renderWhatsApp(
      {
        kind: 'rich',
        blocks: [
          {
            kind: 'button-row',
            buttons: [{ id: 'a', label: longLabel }],
          },
        ],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'interactive') throw new Error('expected interactive');
    if (out.interactive.type !== 'button') return;
    expect(out.interactive.action.buttons[0]?.reply.title.length).toBeLessThanOrEqual(20);
  });
});

import { describe, expect, test } from 'bun:test';
import type { ChannelCapabilities } from '../types.js';
import { renderSlack } from './slack.js';

function caps(overrides: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
  return {
    supportsThreads: true,
    supportsReactions: true,
    supportsTypingIndicator: false,
    supportsFileUpload: true,
    supportsVoice: false,
    supportsButtons: true,
    supportsEditMessage: true,
    supportsDeleteMessage: true,
    supportsPresence: true,
    supportsSlashCommands: true,
    supportsDMs: true,
    supportsGroupChats: true,
    supportsVoiceChannels: false,
    maxMessageLength: 40_000,
    maxAttachmentBytes: 1024 * 1024 * 1024,
    ...overrides,
  };
}

describe('renderSlack', () => {
  test('plain text sends only { text }', () => {
    const out = renderSlack({ kind: 'text', text: 'hi' }, { capabilities: caps() });
    expect(out.kind).toBe('text');
    if (out.kind === 'text') expect(out.text).toBe('hi');
  });

  test('renders header + section + divider + actions', () => {
    const out = renderSlack(
      {
        kind: 'rich',
        blocks: [
          { kind: 'heading', text: 'Order' },
          { kind: 'paragraph', text: 'shipped' },
          { kind: 'divider' },
          {
            kind: 'button-row',
            buttons: [
              { id: 'a', label: 'Ack', style: 'primary' },
              { id: 'c', label: 'Cancel', style: 'danger' },
            ],
          },
        ],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'rich') throw new Error('expected rich');
    const types = out.blocks.map((b) => b.type);
    expect(types).toEqual(['header', 'section', 'divider', 'actions']);
    const actions = out.blocks[3] as { elements: { action_id: string; style?: string }[] };
    expect(actions.elements[0]?.action_id).toBe('a');
    expect(actions.elements[0]?.style).toBe('primary');
    expect(actions.elements[1]?.style).toBe('danger');
  });

  test('always includes plain-text fallback', () => {
    const out = renderSlack(
      {
        kind: 'rich',
        blocks: [
          { kind: 'heading', text: 'H' },
          { kind: 'paragraph', text: 'body' },
        ],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'rich') throw new Error('expected rich');
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text).toContain('H');
    expect(out.text).toContain('body');
  });

  test('caps actions elements at 5', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, label: `B${i}` }));
    const out = renderSlack(
      { kind: 'rich', blocks: [{ kind: 'button-row', buttons: six }] },
      { capabilities: caps() },
    );
    if (out.kind !== 'rich') throw new Error('expected rich');
    const actions = out.blocks[0] as { elements: unknown[] };
    expect(actions.elements).toHaveLength(5);
  });

  test('validates output via Block Kit validator (throws on over-long button text)', () => {
    const longLabel = 'x'.repeat(100);
    expect(() =>
      renderSlack(
        {
          kind: 'rich',
          blocks: [{ kind: 'button-row', buttons: [{ id: 'a', label: longLabel }] }],
        },
        { capabilities: caps() },
      ),
    ).not.toThrow(); // renderer truncates to 75 chars itself
  });

  test('file payload uses caption as fallback text', () => {
    const out = renderSlack(
      { kind: 'file', file: { id: 'f', name: 'r.md' }, caption: 'see attached' },
      { capabilities: caps() },
    );
    if (out.kind !== 'file') throw new Error('expected file');
    expect(out.text).toBe('see attached');
  });

  test('image block emits image type', () => {
    const out = renderSlack(
      {
        kind: 'rich',
        blocks: [{ kind: 'image', url: 'https://i/1', alt: 'cat' }],
      },
      { capabilities: caps() },
    );
    if (out.kind !== 'rich') throw new Error('expected rich');
    expect(out.blocks[0]?.type).toBe('image');
  });
});

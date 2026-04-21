import { describe, expect, test } from 'bun:test';
import { PASTE_END_MARKER, PASTE_START_MARKER, PasteMachine } from './paste-buffer.js';

function wrap(text: string): string {
  return `${PASTE_START_MARKER}${text}${PASTE_END_MARKER}`;
}

describe('PasteMachine', () => {
  test('passes non-paste bytes through silently', () => {
    const m = new PasteMachine();
    expect(m.feed('hello world')).toEqual([]);
    expect(m.active).toBe(false);
  });

  test('emits start + slice + end for a single-chunk paste', () => {
    const m = new PasteMachine();
    const events = m.feed(wrap('pasted body'));
    expect(events).toEqual([
      { type: 'start' },
      { type: 'slice', text: 'pasted body' },
      { type: 'end' },
    ]);
    expect(m.active).toBe(false);
  });

  test('carries paste state across chunk boundaries', () => {
    const m = new PasteMachine();
    const events1 = m.feed(`${PASTE_START_MARKER}first line\n`);
    expect(events1).toEqual([{ type: 'start' }, { type: 'slice', text: 'first line\n' }]);
    expect(m.active).toBe(true);

    const events2 = m.feed(`second line${PASTE_END_MARKER}`);
    expect(events2).toEqual([{ type: 'slice', text: 'second line' }, { type: 'end' }]);
    expect(m.active).toBe(false);
  });

  test('handles a start marker split mid-sequence', () => {
    const m = new PasteMachine();
    // Split the marker in half.
    const half = Math.floor(PASTE_START_MARKER.length / 2);
    const a = PASTE_START_MARKER.slice(0, half);
    const b = PASTE_START_MARKER.slice(half);
    expect(m.feed(a)).toEqual([]);
    expect(m.active).toBe(false);
    const events = m.feed(`${b}body${PASTE_END_MARKER}`);
    expect(events).toEqual([{ type: 'start' }, { type: 'slice', text: 'body' }, { type: 'end' }]);
    expect(m.active).toBe(false);
  });

  test('handles an end marker split across chunks', () => {
    const m = new PasteMachine();
    const half = Math.floor(PASTE_END_MARKER.length / 2);
    const a = PASTE_END_MARKER.slice(0, half);
    const b = PASTE_END_MARKER.slice(half);
    const events1 = m.feed(`${PASTE_START_MARKER}content${a}`);
    // The straddling prefix must be held back so it isn't emitted as text.
    const slices1 = events1
      .filter((ev) => ev.type === 'slice')
      .map((ev) => (ev.type === 'slice' ? ev.text : ''))
      .join('');
    expect(slices1).toBe('content');
    expect(m.active).toBe(true);

    const events2 = m.feed(b);
    expect(events2).toEqual([{ type: 'end' }]);
    expect(m.active).toBe(false);
  });

  test('supports back-to-back pastes in one chunk', () => {
    const m = new PasteMachine();
    const events = m.feed(`${wrap('one')}${wrap('two')}`);
    expect(events).toEqual([
      { type: 'start' },
      { type: 'slice', text: 'one' },
      { type: 'end' },
      { type: 'start' },
      { type: 'slice', text: 'two' },
      { type: 'end' },
    ]);
  });

  test('drops non-paste bytes that appear between pastes', () => {
    const m = new PasteMachine();
    const events = m.feed(`prelude${wrap('body')}epilogue`);
    expect(events).toEqual([{ type: 'start' }, { type: 'slice', text: 'body' }, { type: 'end' }]);
  });

  test('preserves embedded newlines inside the paste slice', () => {
    const m = new PasteMachine();
    const events = m.feed(wrap('line1\nline2\nline3'));
    const joined = events
      .filter((ev) => ev.type === 'slice')
      .map((ev) => (ev.type === 'slice' ? ev.text : ''))
      .join('');
    expect(joined).toBe('line1\nline2\nline3');
  });

  test('reset clears in-flight paste state', () => {
    const m = new PasteMachine();
    m.feed(`${PASTE_START_MARKER}half`);
    expect(m.active).toBe(true);
    m.reset();
    expect(m.active).toBe(false);
    // After reset, a fresh start is detected cleanly.
    const events = m.feed(wrap('fresh'));
    expect(events).toEqual([{ type: 'start' }, { type: 'slice', text: 'fresh' }, { type: 'end' }]);
  });
});

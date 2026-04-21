import { describe, expect, test } from 'bun:test';
import { SSEFrameParser } from './sse-parser.js';

function feed(parser: SSEFrameParser, s: string): ReturnType<SSEFrameParser['push']> {
  return parser.push(new TextEncoder().encode(s));
}

describe('SSEFrameParser', () => {
  test('single frame with data + event type', () => {
    const p = new SSEFrameParser();
    const out = feed(p, 'event: message\ndata: hello\n\n');
    expect(out).toEqual([{ event: 'message', data: 'hello', id: undefined }]);
  });

  test('multi-line data joined with \\n', () => {
    const p = new SSEFrameParser();
    const out = feed(p, 'data: line1\ndata: line2\ndata: line3\n\n');
    expect(out[0]?.data).toBe('line1\nline2\nline3');
  });

  test('handles CRLF line endings', () => {
    const p = new SSEFrameParser();
    const out = feed(p, 'event: ping\r\ndata: {}\r\n\r\n');
    expect(out).toEqual([{ event: 'ping', data: '{}', id: undefined }]);
  });

  test('chunked input assembles across pushes', () => {
    const p = new SSEFrameParser();
    expect(feed(p, 'event: mes')).toEqual([]);
    expect(feed(p, 'sage\n')).toEqual([]);
    expect(feed(p, 'data: partial')).toEqual([]);
    const out = feed(p, '\n\n');
    expect(out[0]?.data).toBe('partial');
  });

  test('lines beginning with `:` are comments and skipped', () => {
    const p = new SSEFrameParser();
    const out = feed(p, ': heartbeat\n: another\ndata: real\n\n');
    expect(out).toEqual([{ event: '', data: 'real', id: undefined }]);
  });

  test('id field persists across frames (sticky last-event-id)', () => {
    const p = new SSEFrameParser();
    const first = feed(p, 'id: abc\nevent: one\ndata: 1\n\n');
    expect(first[0]?.id).toBe('abc');
    // Second frame does NOT re-send id; parser retains the last one.
    const second = feed(p, 'event: two\ndata: 2\n\n');
    expect(second[0]?.id).toBe('abc');
  });

  test('two frames in one push', () => {
    const p = new SSEFrameParser();
    const out = feed(p, 'data: a\n\ndata: b\n\n');
    expect(out.map((f) => f.data)).toEqual(['a', 'b']);
  });

  test('strips exactly one leading space from value', () => {
    const p = new SSEFrameParser();
    const out = feed(p, 'data:  two-spaces\n\n');
    // First space is the separator-space; second survives.
    expect(out[0]?.data).toBe(' two-spaces');
  });

  test('flush emits a trailing frame without a terminating blank line', () => {
    const p = new SSEFrameParser();
    const out = feed(p, 'data: hanging\n');
    expect(out).toEqual([]);
    const final = p.flush();
    expect(final?.data).toBe('hanging');
  });
});

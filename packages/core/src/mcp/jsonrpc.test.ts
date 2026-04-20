import { describe, expect, test } from 'bun:test';
import {
  JSONRPCError,
  LineBuffer,
  TransportClosedError,
  createPairedConnections,
  encodeMessage,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  parseMessage,
} from './jsonrpc.js';

describe('jsonrpc encode/decode', () => {
  test('encodeMessage emits newline-terminated JSON', () => {
    const buf = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const text = new TextDecoder().decode(buf);
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  test('parseMessage rejects non-2.0 messages', () => {
    expect(() => parseMessage('{"jsonrpc":"1.0","id":1,"method":"x"}')).toThrow(
      /unsupported JSON-RPC version/,
    );
  });

  test('type guards distinguish requests, responses, notifications', () => {
    const req = { jsonrpc: '2.0', id: 1, method: 'x' };
    const resp = { jsonrpc: '2.0', id: 1, result: {} };
    const errResp = { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'oops' } };
    const note = { jsonrpc: '2.0', method: 'x' };
    expect(isJSONRPCRequest(req)).toBe(true);
    expect(isJSONRPCResponse(resp)).toBe(true);
    expect(isJSONRPCResponse(errResp)).toBe(true);
    expect(isJSONRPCErrorResponse(errResp as never)).toBe(true);
    expect(isJSONRPCErrorResponse(resp as never)).toBe(false);
    expect(isJSONRPCNotification(note)).toBe(true);
    expect(isJSONRPCNotification(req)).toBe(false);
  });
});

describe('LineBuffer', () => {
  test('emits complete lines and holds partial trailing data', () => {
    const buf = new LineBuffer();
    expect(buf.push('hello\nwor')).toEqual(['hello']);
    expect(buf.push('ld\nfoo\nbar')).toEqual(['world', 'foo']);
    expect(buf.flush()).toBe('bar');
    expect(buf.flush()).toBeNull();
  });

  test('drops empty lines and strips trailing CR', () => {
    const buf = new LineBuffer();
    expect(buf.push('a\r\n\r\nb\n')).toEqual(['a', 'b']);
  });

  test('decodes Uint8Array chunks across boundaries', () => {
    const buf = new LineBuffer();
    const enc = new TextEncoder();
    expect(buf.push(enc.encode('{"jsonrpc":"2.0","id":1,'))).toEqual([]);
    expect(buf.push(enc.encode('"method":"ping"}\n'))).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    ]);
  });
});

describe('JSONRPCConnection over paired in-memory transports', () => {
  test('notifications dispatch to subscribers on the receiving end', async () => {
    const { client, server } = createPairedConnections();
    const received: Array<[string, unknown]> = [];
    client.onNotification((method, params) => {
      received.push([method, params]);
    });
    await server.notify('hello', { ok: true });
    // Allow the client read loop to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toEqual([['hello', { ok: true }]]);
    await client.close();
    await server.close();
  });

  test('outstanding requests reject with TransportClosedError when the peer closes', async () => {
    const { client, server } = createPairedConnections();
    const promise = client.request('never-answered');
    await server.close();
    await expect(promise).rejects.toBeInstanceOf(TransportClosedError);
    await client.close();
  });

  test('AbortSignal cancels a pending request', async () => {
    const { client, server } = createPairedConnections();
    const ac = new AbortController();
    const promise = client.request('never', undefined, ac.signal);
    ac.abort(new Error('user-cancelled'));
    await expect(promise).rejects.toThrow('user-cancelled');
    await client.close();
    await server.close();
  });

  test('JSONRPCError carries the error code and message', () => {
    const err = new JSONRPCError({ code: -32601, message: 'method not found' });
    expect(err.code).toBe(-32601);
    expect(err.message).toContain('method not found');
  });
});

/**
 * Multi-host SSE follow tests.
 *
 * Slice 6a of `docs/CONTROL_PLANE_PLAN.md` — `fleet logs -f` wiring.
 * Covers the three scenarios from the sprint 5 spec:
 *   1. Two hosts producing chunks → interleaving + host-prefix tagging.
 *   2. One host disconnects mid-stream → others continue, disconnected
 *      reconnects with backoff.
 *   3. `stop()` closes all connections cleanly, tailer loops exit.
 */

import { describe, expect, test } from 'bun:test';
import type { FleetHost } from '@declaragent/core';
import { type MultiHostLogEvent, tailLogsMultiHost } from './fleet-logs-stream.js';

// ── Mock SSE response helpers ──────────────────────────────────────────

/**
 * Create a `Response` whose body is a `ReadableStream<Uint8Array>` the
 * test drives by calling `push(frame)`. Calling `close()` ends the
 * stream cleanly; `error(msg)` simulates a mid-stream disconnect.
 */
function makeStreamedResponse(): {
  response: Response;
  push: (frame: string) => void;
  close: () => void;
  error: (message: string) => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  return {
    response,
    push(frame: string) {
      controller?.enqueue(encoder.encode(frame));
    },
    close() {
      try {
        controller?.close();
      } catch {
        // already closed
      }
    },
    error(message: string) {
      try {
        controller?.error(new Error(message));
      } catch {
        // already closed
      }
    },
  };
}

function logFrame(payload: Record<string, unknown>): string {
  return `event: log\ndata: ${JSON.stringify(payload)}\n\n`;
}

// A fetch impl backed by a queue of mock responses, indexed by host url.
// Supports re-queuing multiple responses per host to exercise reconnect.
function makeFetchStub(
  queues: Record<
    string,
    Array<
      () => {
        response: Response;
        push?: (f: string) => void;
        close?: () => void;
        error?: (m: string) => void;
      }
    >
  >,
): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const hostBase = new URL(url).origin;
    const queue = queues[hostBase];
    if (!queue || queue.length === 0) {
      return new Response('not found', { status: 404 });
    }
    const next = queue.shift();
    if (!next) return new Response('not found', { status: 404 });
    const made = next();
    // Honour abort so stop() cleans up
    const signal = init?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        made.close?.();
      });
    }
    return made.response;
  };
  return impl as unknown as typeof fetch;
}

describe('tailLogsMultiHost', () => {
  test('interleaves chunks from two hosts with host-prefix tags', async () => {
    const a = makeStreamedResponse();
    const b = makeStreamedResponse();
    const fetchImpl = makeFetchStub({
      'http://host-a:9464': [() => ({ response: a.response, close: a.close })],
      'http://host-b:9464': [() => ({ response: b.response, close: b.close })],
    });
    const events: MultiHostLogEvent[] = [];
    const handle = tailLogsMultiHost({
      hosts: [
        { name: 'a', url: 'http://host-a:9464' },
        { name: 'b', url: 'http://host-b:9464' },
      ],
      fetchImpl,
      onEvent: (e) => events.push(e),
    });

    // Wait for both connections to establish (two 'connected' system events).
    await waitUntil(() => {
      const connected = events.filter((e) => e.kind === 'system' && e.event.kind === 'connected');
      return connected.length >= 2;
    });

    // Interleave pushes from each host.
    a.push(logFrame({ ts: 100, agentId: 'agent-a', message: 'hello from a' }));
    b.push(logFrame({ ts: 110, agentId: 'agent-b', message: 'hello from b' }));
    a.push(logFrame({ ts: 120, agentId: 'agent-a', message: 'second a' }));

    await waitUntil(() => events.filter((e) => e.kind === 'log').length >= 3);

    const logs = events.filter(
      (e): e is Extract<MultiHostLogEvent, { kind: 'log' }> => e.kind === 'log',
    );
    const hosts = logs.map((l) => l.line.host);
    expect(hosts).toContain('a');
    expect(hosts).toContain('b');
    // Each log event is tagged with its host + agent.
    const aLines = logs.filter((l) => l.line.host === 'a');
    expect(aLines.length).toBeGreaterThanOrEqual(2);
    expect(aLines[0]?.line.agentId).toBe('agent-a');
    expect(aLines[0]?.line.text).toBe('hello from a');
    const bLines = logs.filter((l) => l.line.host === 'b');
    expect(bLines.length).toBeGreaterThanOrEqual(1);
    expect(bLines[0]?.line.text).toBe('hello from b');

    await handle.stop();
  });

  test('one host disconnects mid-stream → others keep streaming, disconnected reconnects', async () => {
    const a1 = makeStreamedResponse();
    const a2 = makeStreamedResponse();
    const b = makeStreamedResponse();
    const fetchImpl = makeFetchStub({
      'http://host-a:9464': [
        () => ({ response: a1.response, close: a1.close, error: a1.error }),
        () => ({ response: a2.response, close: a2.close }),
      ],
      'http://host-b:9464': [() => ({ response: b.response, close: b.close })],
    });

    const events: MultiHostLogEvent[] = [];
    // Drive the fake clock synchronously — setTimer fires immediately
    // so tests don't burn wall-clock on backoff.
    const pendingTimers: Array<() => void> = [];
    const handle = tailLogsMultiHost({
      hosts: [
        { name: 'a', url: 'http://host-a:9464' },
        { name: 'b', url: 'http://host-b:9464' },
      ],
      fetchImpl,
      onEvent: (e) => events.push(e),
      setTimer: (cb) => {
        pendingTimers.push(cb);
        return pendingTimers.length;
      },
      clearTimer: () => {
        /* no-op; tests flush explicitly */
      },
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 100,
    });

    // Wait for both connections.
    await waitUntil(
      () => events.filter((e) => e.kind === 'system' && e.event.kind === 'connected').length >= 2,
    );

    // Send one chunk from each, then disconnect `a`.
    a1.push(logFrame({ ts: 100, agentId: 'agent-a', message: 'before drop' }));
    b.push(logFrame({ ts: 101, agentId: 'agent-b', message: 'b is happy' }));
    await waitUntil(() => events.filter((e) => e.kind === 'log').length >= 2);

    a1.error('network hiccup');

    // Host `a` emits error + reconnecting; host `b` is unaffected.
    await waitUntil(() =>
      events.some(
        (e) => e.kind === 'system' && e.event.host === 'a' && e.event.kind === 'reconnecting',
      ),
    );
    // b had no error/reconnect events
    const bDisruptions = events.filter(
      (e) =>
        e.kind === 'system' &&
        e.event.host === 'b' &&
        (e.event.kind === 'error' ||
          e.event.kind === 'reconnecting' ||
          e.event.kind === 'disconnected'),
    );
    expect(bDisruptions).toEqual([]);

    // Flush the pending reconnect timer to trigger a2.
    const drain = pendingTimers.shift();
    drain?.();

    // After reconnect, a2 is live. b should still be streaming.
    await waitUntil(
      () =>
        events.filter(
          (e) => e.kind === 'system' && e.event.kind === 'connected' && e.event.host === 'a',
        ).length >= 2,
    );
    a2.push(logFrame({ ts: 200, agentId: 'agent-a', message: 'after reconnect' }));
    b.push(logFrame({ ts: 210, agentId: 'agent-b', message: 'still here' }));
    await waitUntil(() => events.filter((e) => e.kind === 'log').length >= 4);

    const texts = events
      .filter((e): e is Extract<MultiHostLogEvent, { kind: 'log' }> => e.kind === 'log')
      .map((e) => e.line.text);
    expect(texts).toContain('after reconnect');
    expect(texts).toContain('still here');

    await handle.stop();
    // Drain any dangling reconnect timers so background loops exit.
    while (pendingTimers.length > 0) {
      const t = pendingTimers.shift();
      t?.();
    }
    await handle.done;
  });

  test('stop() cancels all active streams cleanly', async () => {
    const a = makeStreamedResponse();
    const b = makeStreamedResponse();
    const fetchImpl = makeFetchStub({
      'http://host-a:9464': [() => ({ response: a.response, close: a.close })],
      'http://host-b:9464': [() => ({ response: b.response, close: b.close })],
    });
    const events: MultiHostLogEvent[] = [];
    const handle = tailLogsMultiHost({
      hosts: [
        { name: 'a', url: 'http://host-a:9464' },
        { name: 'b', url: 'http://host-b:9464' },
      ],
      fetchImpl,
      onEvent: (e) => events.push(e),
    });

    await waitUntil(
      () => events.filter((e) => e.kind === 'system' && e.event.kind === 'connected').length >= 2,
    );
    await handle.stop();
    // `done` resolves after stop() completes.
    await handle.done;
    // Idempotent — second stop() is a no-op.
    await handle.stop();
  });

  test('host-prefix tagging composes with existing agent-level log format', async () => {
    const a = makeStreamedResponse();
    const fetchImpl = makeFetchStub({
      'http://host-a:9464': [() => ({ response: a.response, close: a.close })],
    });
    const events: MultiHostLogEvent[] = [];
    const hosts: FleetHost[] = [{ name: 'prod-us-east-1', url: 'http://host-a:9464' }];
    const handle = tailLogsMultiHost({
      hosts,
      fetchImpl,
      onEvent: (e) => events.push(e),
    });
    await waitUntil(() => events.some((e) => e.kind === 'system' && e.event.kind === 'connected'));
    a.push(logFrame({ ts: 1, agentId: 'concierge', level: 'info', event: 'webhook.received' }));
    await waitUntil(() => events.some((e) => e.kind === 'log'));
    const log = events.find(
      (e): e is Extract<MultiHostLogEvent, { kind: 'log' }> => e.kind === 'log',
    );
    expect(log).toBeDefined();
    expect(log?.line.host).toBe('prod-us-east-1');
    expect(log?.line.agentId).toBe('concierge');
    // Raw payload round-trips for the renderer.
    expect(log?.line.data?.event).toBe('webhook.received');
    await handle.stop();
  });

  test('bearer auth header is sent on the SSE request', async () => {
    const a = makeStreamedResponse();
    let seenAuth: string | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string>)?.authorization;
      const signal = init?.signal;
      signal?.addEventListener('abort', () => a.close());
      return a.response;
    }) as unknown as typeof fetch;
    const handle = tailLogsMultiHost({
      hosts: [{ name: 'a', url: 'http://host-a:9464', auth: { bearer: 'env:TOK' } }],
      fetchImpl,
      env: { TOK: 'abc' },
      onEvent: () => {
        /* ignore */
      },
    });
    // Give the fetch a chance to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(seenAuth).toBe('Bearer abc');
    await handle.stop();
  });
});

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

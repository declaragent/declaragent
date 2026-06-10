import { describe, expect, test } from 'bun:test';
import { createSocketModeTransport } from './client.js';

/** Flush pending microtasks/timers so an async `getUrl()` resolves + the socket constructs. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Minimal fake WebSocket: records sends, lets the test drive lifecycle events.
 * Tracks instances so a reconnect test can assert a NEW socket was opened.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(cb);
  }
  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, ev?: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

function makeTransport(overrides: Partial<Parameters<typeof createSocketModeTransport>[0]> = {}) {
  FakeWebSocket.instances = [];
  let urlCalls = 0;
  const pendingTimers: Array<() => void> = [];
  const transport = createSocketModeTransport({
    getUrl: async () => {
      urlCalls += 1;
      return `wss://fake/${urlCalls}`;
    },
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    // Capture the reconnect timer so the test controls when it fires.
    setTimeoutFn: ((cb: () => void) => {
      pendingTimers.push(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as never,
    clearTimeoutFn: () => {},
    ...overrides,
  });
  return {
    transport,
    urlCalls: () => urlCalls,
    firePendingTimer: () => pendingTimers.shift()?.(),
    pendingTimerCount: () => pendingTimers.length,
  };
}

describe('createSocketModeTransport reconnect (WS11)', () => {
  test('connect resolves on open and connected() is true', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect();
    await flush();
    FakeWebSocket.instances[0]?.emit('open');
    await connectPromise;
    expect(h.transport.connected()).toBe(true);
  });

  test('an unexpected close schedules a reconnect that opens a NEW socket', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect();
    await flush();
    FakeWebSocket.instances[0]?.emit('open');
    await connectPromise;
    expect(h.urlCalls()).toBe(1);

    // Slack recycles the connection → close fires.
    FakeWebSocket.instances[0]?.emit('close');
    expect(h.transport.connected()).toBe(false);
    expect(h.pendingTimerCount()).toBe(1); // reconnect scheduled

    // Fire the backoff timer → a new socket is opened.
    h.firePendingTimer();
    await flush();
    expect(h.urlCalls()).toBe(2);
    expect(FakeWebSocket.instances.length).toBe(2);
    FakeWebSocket.instances[1]?.emit('open');
    expect(h.transport.connected()).toBe(true);
    await h.transport.close();
  });

  test('intentional close() stops reconnect (no new socket after close)', async () => {
    const h = makeTransport();
    const connectPromise = h.transport.connect();
    await flush();
    FakeWebSocket.instances[0]?.emit('open');
    await connectPromise;

    await h.transport.close();
    // A close event after intentional close must NOT schedule a reconnect.
    FakeWebSocket.instances[0]?.emit('close');
    expect(h.pendingTimerCount()).toBe(0);
    expect(h.transport.connected()).toBe(false);
  });

  test('acks envelope_id frames + forwards to the handler', async () => {
    const h = makeTransport();
    const frames: unknown[] = [];
    h.transport.onEvent((f) => {
      frames.push(f);
    });
    const cp = h.transport.connect();
    await flush();
    FakeWebSocket.instances[0]?.emit('open');
    await cp;
    const sock = FakeWebSocket.instances[0];
    sock?.emit('message', { data: JSON.stringify({ envelope_id: 'e1', type: 'events_api' }) });
    await Promise.resolve();
    // Acked on the socket.
    expect(sock?.sent.some((s) => s.includes('e1'))).toBe(true);
    expect(frames).toHaveLength(1);
    await h.transport.close();
  });
});

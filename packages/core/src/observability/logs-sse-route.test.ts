import { describe, expect, it } from 'bun:test';
import type { ControlPlaneRoute } from './control-plane-server.js';
import type { LogTailLine, LogTailer } from './log-tail.js';
import { logsRoute } from './logs-sse-route.js';

/**
 * Narrow the `ControlPlaneRoute.fetch` return to a non-undefined
 * `Response`. The route factory always returns a response; the
 * optional marker on the contract exists for routes that may
 * decline and fall through, which `/logs` never does.
 */
async function fetchLogs(route: ControlPlaneRoute, req: Request): Promise<Response> {
  const res = await route.fetch(req);
  if (!res) throw new Error('logs route unexpectedly declined the request');
  return res;
}

// ── Fake tailer ────────────────────────────────────────────────────────────

/**
 * In-memory tailer stub. Tests call `push()` to enqueue a line;
 * the SSE route's `for await` consumes them and emits frames.
 */
function makeFakeTailer(): {
  tailer: LogTailer;
  push: (line: LogTailLine) => void;
  close: () => Promise<void>;
} {
  const queue: LogTailLine[] = [];
  const waiters: Array<(result: IteratorResult<LogTailLine>) => void> = [];
  let closed = false;
  const push = (line: LogTailLine): void => {
    if (closed) return;
    const w = waiters.shift();
    if (w) w({ value: line, done: false });
    else queue.push(line);
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      w?.({ value: undefined as unknown as LogTailLine, done: true });
    }
  };
  const tailer: LogTailer = {
    [Symbol.asyncIterator](): AsyncIterator<LogTailLine> {
      return {
        next(): Promise<IteratorResult<LogTailLine>> {
          if (queue.length > 0) {
            const value = queue.shift() as LogTailLine;
            return Promise.resolve({ value, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as LogTailLine, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<IteratorResult<LogTailLine>> {
          void close();
          return Promise.resolve({ value: undefined as unknown as LogTailLine, done: true });
        },
      };
    },
    destroy: close,
    get closed() {
      return closed;
    },
  };
  return { tailer, push, close };
}

/**
 * Read `n` SSE frames (delimited by `\n\n`) from a Response body.
 * Returns an empty string for any frame the reader couldn't pull
 * before `timeoutMs`.
 */
async function readFrames(res: Response, n: number, timeoutMs = 1000): Promise<string[]> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('response has no body');
  const decoder = new TextDecoder();
  let buf = '';
  const out: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (out.length < n && Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), Math.max(20, deadline - Date.now())).unref?.();
      }),
    ]);
    if (race === 'timeout') break;
    if (race.done) break;
    buf += decoder.decode(race.value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx !== -1 && out.length < n) {
      out.push(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      idx = buf.indexOf('\n\n');
    }
  }
  try {
    await reader.cancel();
  } catch {
    // already closed
  }
  return out;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('logsRoute', () => {
  it('emits SSE frames with event: log and JSON data body', async () => {
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({ paths: [{ path: '/tmp/a.log', agentId: 'a' }] }),
      tailerFactory: () => fake.tailer,
      heartbeatMs: 10_000,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs?agent=a'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    fake.push({ agentId: 'a', path: '/tmp/a.log', line: '{"level":"info","msg":"hi"}' });

    const frames = await readFrames(res, 2);
    // First frame is the `: stream-open` sentinel.
    expect(frames[0]).toBe(': stream-open');
    expect(frames[1]).toContain('event: log');
    const payload = frames[1]?.split('data: ')[1] ?? '';
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hi');
    // Line didn't carry agent/agentId, so the route injected agentId.
    expect(parsed.agentId).toBe('a');

    await fake.close();
  });

  it('preserves agentId from the log line if already present', async () => {
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({ paths: [{ path: '/tmp/a.log', agentId: 'a' }] }),
      tailerFactory: () => fake.tailer,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs'));
    fake.push({
      agentId: 'a',
      path: '/tmp/a.log',
      line: '{"agent":"upstream-name","msg":"x"}',
    });
    const frames = await readFrames(res, 2);
    const data = frames[1]?.split('data: ')[1] ?? '';
    const parsed = JSON.parse(data) as Record<string, unknown>;
    expect(parsed.agent).toBe('upstream-name');
    expect(parsed.agentId).toBeUndefined();
    await fake.close();
  });

  it('wraps non-JSON log lines as { agentId, raw }', async () => {
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({ paths: [{ path: '/tmp/a.log', agentId: 'a' }] }),
      tailerFactory: () => fake.tailer,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs'));
    fake.push({ agentId: 'a', path: '/tmp/a.log', line: 'plain text line' });
    const frames = await readFrames(res, 2);
    const data = frames[1]?.split('data: ')[1] ?? '';
    const parsed = JSON.parse(data) as Record<string, unknown>;
    expect(parsed.raw).toBe('plain text line');
    expect(parsed.agentId).toBe('a');
    await fake.close();
  });

  it('returns 400 with {error} when resolvePaths returns null', async () => {
    const route = logsRoute({
      resolvePaths: () => null,
      tailerFactory: () => {
        throw new Error('should not be called');
      },
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs?agent=bogus'));
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('unknown agent');
    expect(body.error).toContain('bogus');
  });

  it('returns 405 for non-GET', async () => {
    const route = logsRoute({
      resolvePaths: () => ({ paths: [] }),
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs', { method: 'POST' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('emits heartbeat comment frames at the configured interval', async () => {
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({ paths: [{ path: '/tmp/a.log', agentId: 'a' }] }),
      tailerFactory: () => fake.tailer,
      heartbeatMs: 30,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs'));
    const frames = await readFrames(res, 3, 500);
    // Frame 0 is `: stream-open`; next heartbeat frames match `: keep-alive`.
    expect(frames[0]).toBe(': stream-open');
    // At least one subsequent `: keep-alive` should land within 500ms.
    const hadKeepAlive = frames.slice(1).some((f) => f === ': keep-alive');
    expect(hadKeepAlive).toBe(true);
    await fake.close();
  });

  it('drops buffered frames and emits system:dropped when back-pressure limit hits', async () => {
    // Simulate a stalled consumer by never reading the stream. The
    // route can't know the consumer is stalled from the server side
    // alone — the stream controller accepts frames as long as the
    // internal strategy allows. To exercise the drop path
    // deterministically, we set maxBufferedFrames very low and push
    // many lines while the tailer yields them eagerly.
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({ paths: [{ path: '/tmp/a.log', agentId: 'a' }] }),
      tailerFactory: () => fake.tailer,
      heartbeatMs: 10_000,
      maxBufferedFrames: 2,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs'));
    // Don't start reading until after we've pushed > maxBufferedFrames
    // lines. The internal queue inside the stream controller won't
    // back up if the consumer is active, so we wait before reading.
    for (let i = 0; i < 10; i += 1) {
      fake.push({ agentId: 'a', path: '/tmp/a.log', line: `{"n":${i}}` });
    }
    // Give the for-await loop a beat to enqueue everything.
    await new Promise((r) => setTimeout(r, 30));

    const frames = await readFrames(res, 10, 500);
    // We expect at least one `event: system` frame with a dropped count.
    const systemFrames = frames.filter((f) => f.includes('event: system'));
    const droppedBody = systemFrames
      .map((f) => f.split('data: ')[1] ?? '')
      .map((j) => {
        try {
          return JSON.parse(j) as { system?: string; count?: number };
        } catch {
          return null;
        }
      })
      .find((v) => v !== null && v.system === 'dropped');
    expect(droppedBody).toBeDefined();
    expect((droppedBody as { count: number }).count).toBeGreaterThan(0);

    await fake.close();
  });

  it('destroys the tailer when the stream is cancelled (client disconnect)', async () => {
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({ paths: [{ path: '/tmp/a.log', agentId: 'a' }] }),
      tailerFactory: () => fake.tailer,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs'));
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    await reader.cancel();
    // Cancel should cascade into tailer.destroy.
    const deadline = Date.now() + 500;
    while (!fake.tailer.closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fake.tailer.closed).toBe(true);
  });

  // ── Fan-out cap + ?all=1 (POST_ENTERPRISE_BACKLOG.md #20) ──────────────

  it('returns 413 when resolved paths exceed fanOutLimit on ?all=1', async () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => ({
      path: `/tmp/a${i}.log`,
      agentId: `a${i}`,
    }));
    const route = logsRoute({
      resolvePaths: () => ({ paths: tooMany }),
      tailerFactory: () => {
        throw new Error('should not be called — cap fires first');
      },
      fanOutLimit: 5,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs?all=1'));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; limit: number; requested: number };
    expect(body.limit).toBe(5);
    expect(body.requested).toBe(6);
    expect(body.error).toContain('fan-out');
  });

  it('enforces fanOutLimit on the legacy no-param multiplex too', async () => {
    // Pre-0.7.3 behavior: no `?agent=` → multiplex all. Without the cap
    // a 200-agent `up` host opens 200 tailers on the first scrape. The
    // cap now fires regardless of the trigger.
    const tooMany = Array.from({ length: 3 }, (_, i) => ({
      path: `/tmp/a${i}.log`,
      agentId: `a${i}`,
    }));
    const route = logsRoute({
      resolvePaths: () => ({ paths: tooMany }),
      tailerFactory: () => {
        throw new Error('should not be called');
      },
      fanOutLimit: 2,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs'));
    expect(res.status).toBe(413);
  });

  it('single-agent tail never hits the cap regardless of running agent count', async () => {
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({ paths: [{ path: '/tmp/a.log', agentId: 'a' }] }),
      tailerFactory: () => fake.tailer,
      fanOutLimit: 1,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs?agent=a'));
    expect(res.status).toBe(200);
    await fake.close();
  });

  it('rejects mixing ?all=1 and ?agent=', async () => {
    const route = logsRoute({
      resolvePaths: () => ({ paths: [] }),
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs?all=1&agent=x'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mutually exclusive/);
  });

  it('coalesces per-agent log emissions on ?all=1 within the rate window', async () => {
    // Emit two lines for the same agent very fast; with a 50ms
    // coalesce window the second frame should only arrive after the
    // window has elapsed (not immediately back-to-back).
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({
        paths: [
          { path: '/tmp/a.log', agentId: 'a' },
          { path: '/tmp/b.log', agentId: 'b' },
        ],
      }),
      tailerFactory: () => fake.tailer,
      heartbeatMs: 10_000,
      coalescePerAgentMs: 50,
      fanOutLimit: 10,
    });
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs?all=1'));
    // First line for `a` — goes out immediately (slot.nextAllowedAt = 0).
    fake.push({ agentId: 'a', path: '/tmp/a.log', line: '{"n":1}' });
    // Second line for `a` arrives inside the 50ms window → coalesced.
    fake.push({ agentId: 'a', path: '/tmp/a.log', line: '{"n":2}' });
    const frames = await readFrames(res, 3, 500);
    // frame[0] = `: stream-open`; frame[1] = first log; frame[2] = second (after window).
    const logFrames = frames.filter((f) => f.includes('event: log'));
    expect(logFrames.length).toBeGreaterThanOrEqual(2);
    // Both lines eventually land — coalescing queues, never drops.
    const payloads = logFrames.map((f) => JSON.parse(f.split('data: ')[1] ?? '{}'));
    const ns = payloads.map((p: Record<string, unknown>) => p.n).sort() as number[];
    expect(ns).toEqual([1, 2]);
    await fake.close();
  });

  it('destroys the tailer when request.signal fires abort', async () => {
    const fake = makeFakeTailer();
    const route = logsRoute({
      resolvePaths: () => ({ paths: [{ path: '/tmp/a.log', agentId: 'a' }] }),
      tailerFactory: () => fake.tailer,
    });
    const ac = new AbortController();
    const res = await fetchLogs(route, new Request('http://127.0.0.1/logs', { signal: ac.signal }));
    // Start reading so the stream isn't short-circuited.
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    void reader.read(); // kick the loop
    ac.abort();
    const deadline = Date.now() + 500;
    while (!fake.tailer.closed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fake.tailer.closed).toBe(true);
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  });
});

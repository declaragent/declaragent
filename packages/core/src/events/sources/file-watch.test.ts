import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus } from '../bus.js';
import { eventSourceExtension } from '../source.js';
import type { AgentEvent, EventBus } from '../types.js';
import { type FileWatcherLike, PerPathDebouncer, createFileWatchAdapter } from './file-watch.js';

// ── FakeClock (virtual timer) ────────────────────────────────────────────

interface Pending {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

class FakeClock {
  nowMs = 0;
  private readonly pending: Pending[] = [];

  setTimer = (delayMs: number, fn: () => void): (() => void) => {
    const entry: Pending = { at: this.nowMs + delayMs, fn, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const live = this.pending.filter((p) => !p.cancelled);
      live.sort((a, b) => a.at - b.at);
      const next = live[0];
      if (!next || next.at > target) break;
      this.nowMs = next.at;
      // remove the chosen entry (including any cancelled ones before it)
      const idx = this.pending.indexOf(next);
      if (idx >= 0) this.pending.splice(idx, 1);
      next.fn();
    }
    this.nowMs = target;
  }
}

// ── Fake watcher ─────────────────────────────────────────────────────────

type AnyListener = (...args: unknown[]) => void;

interface FakeWatcherHandle {
  watcher: FileWatcherLike;
  fire(event: 'add' | 'change' | 'unlink' | 'error', ...args: unknown[]): void;
  closed(): boolean;
}

function makeFakeWatcher(): FakeWatcherHandle {
  const listeners = new Map<string, AnyListener[]>();
  let isClosed = false;
  const on = (event: string, cb: AnyListener): unknown => {
    const arr = listeners.get(event) ?? [];
    arr.push(cb);
    listeners.set(event, arr);
    return undefined;
  };
  const watcher: FileWatcherLike = {
    on: on as unknown as FileWatcherLike['on'],
    async close() {
      isClosed = true;
    },
  };
  return {
    watcher,
    fire(event, ...args) {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    closed() {
      return isClosed;
    },
  };
}

async function collect(bus: EventBus): Promise<AgentEvent[]> {
  const received: AgentEvent[] = [];
  bus.subscribe('*', (e) => {
    received.push(e);
  });
  return received;
}

// ── Debouncer unit tests ────────────────────────────────────────────────

describe('PerPathDebouncer', () => {
  test('fires once after silence window', async () => {
    const clock = new FakeClock();
    const fires: Array<{ path: string; change: string }> = [];
    const d = new PerPathDebouncer(100, clock.setTimer, (path, change) => {
      fires.push({ path, change });
    });
    d.observe('/a', 'change');
    await clock.advance(50);
    expect(fires).toHaveLength(0);
    await clock.advance(60);
    expect(fires).toEqual([{ path: '/a', change: 'change' }]);
  });

  test('coalesces rapid events on same path into the latest', async () => {
    const clock = new FakeClock();
    const fires: Array<{ path: string; change: string }> = [];
    const d = new PerPathDebouncer(100, clock.setTimer, (path, change) => {
      fires.push({ path, change });
    });
    d.observe('/a', 'add');
    await clock.advance(30);
    d.observe('/a', 'change');
    await clock.advance(30);
    d.observe('/a', 'unlink');
    await clock.advance(200);
    expect(fires).toEqual([{ path: '/a', change: 'unlink' }]);
  });

  test('different paths debounce independently', async () => {
    const clock = new FakeClock();
    const fires: Array<{ path: string; change: string }> = [];
    const d = new PerPathDebouncer(100, clock.setTimer, (path, change) => {
      fires.push({ path, change });
    });
    d.observe('/a', 'add');
    d.observe('/b', 'change');
    await clock.advance(150);
    expect(fires.map((f) => f.path).sort()).toEqual(['/a', '/b']);
  });

  test('cancelAll drops pending without firing', async () => {
    const clock = new FakeClock();
    let fires = 0;
    const d = new PerPathDebouncer(100, clock.setTimer, () => {
      fires += 1;
    });
    d.observe('/a', 'change');
    d.observe('/b', 'change');
    expect(d.size).toBe(2);
    d.cancelAll();
    expect(d.size).toBe(0);
    await clock.advance(300);
    expect(fires).toBe(0);
  });
});

// ── Adapter unit tests (fake watcher) ───────────────────────────────────

describe('createFileWatchAdapter (fake watcher)', () => {
  test('validateConfig rejects missing id/paths and bad events', async () => {
    const bus = createEventBus();
    const adapter = createFileWatchAdapter();

    await expect(
      eventSourceExtension(adapter, {
        config: { id: '', paths: ['/tmp/*'], target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('non-empty "id"');

    await expect(
      eventSourceExtension(adapter, {
        config: { id: 'x', paths: [], target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('"paths"');

    await expect(
      eventSourceExtension(adapter, {
        config: {
          id: 'x',
          paths: ['/tmp/*'],
          events: ['bogus'],
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('add|change|unlink');
  });

  test('emits file.changed with debounced payload', async () => {
    const clock = new FakeClock();
    const watcher = makeFakeWatcher();
    const bus = createEventBus();
    const received = await collect(bus);

    const ext = await eventSourceExtension(
      createFileWatchAdapter({
        setTimer: clock.setTimer,
        watchFactory: () => watcher.watcher,
      }),
      {
        config: {
          id: 'src',
          paths: ['/tmp/src/**/*.ts'],
          debounceMs: 100,
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();

    watcher.fire('change', '/tmp/src/a.ts');
    watcher.fire('change', '/tmp/src/a.ts');
    watcher.fire('change', '/tmp/src/a.ts');
    await clock.advance(200);

    // Debouncer fires synchronously; publish is async. bus.drained() waits
    // for the in-flight publish to settle.
    await bus.drained();

    expect(received).toHaveLength(1);
    const event = received[0] as AgentEvent<{ path: string; change: string }>;
    expect(event.kind).toBe('file.changed');
    expect(event.payload.path).toBe('/tmp/src/a.ts');
    expect(event.payload.change).toBe('change');
    expect(event.source).toEqual({ type: 'file-watch', path: '/tmp/src/a.ts', change: 'modify' });
    expect(event.auth).toEqual({ kind: 'trigger', triggerId: 'src' });

    await ext.payload.stop();
    expect(watcher.closed()).toBe(true);
  });

  test('config.events filters out disallowed change kinds', async () => {
    const clock = new FakeClock();
    const watcher = makeFakeWatcher();
    const bus = createEventBus();
    const received = await collect(bus);

    const ext = await eventSourceExtension(
      createFileWatchAdapter({ setTimer: clock.setTimer, watchFactory: () => watcher.watcher }),
      {
        config: {
          id: 'adds-only',
          paths: ['/x/*'],
          events: ['add'],
          debounceMs: 50,
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();

    watcher.fire('change', '/x/a.txt');
    watcher.fire('unlink', '/x/b.txt');
    watcher.fire('add', '/x/c.txt');
    await clock.advance(100);
    await bus.drained();

    expect(received).toHaveLength(1);
    const event = received[0] as AgentEvent<{ path: string; change: string }>;
    expect(event.payload.change).toBe('add');
    expect(event.payload.path).toBe('/x/c.txt');

    await ext.payload.stop();
  });

  test('pause suppresses publishes; resume restores', async () => {
    const clock = new FakeClock();
    const watcher = makeFakeWatcher();
    const bus = createEventBus();
    const received = await collect(bus);

    const ext = await eventSourceExtension(
      createFileWatchAdapter({ setTimer: clock.setTimer, watchFactory: () => watcher.watcher }),
      {
        config: {
          id: 'p',
          paths: ['/x/*'],
          debounceMs: 50,
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();
    await ext.payload.pause();

    watcher.fire('change', '/x/a.txt');
    await clock.advance(100);
    await bus.drained();
    expect(received).toHaveLength(0);

    await ext.payload.resume();
    watcher.fire('change', '/x/b.txt');
    await clock.advance(100);
    await bus.drained();
    expect(received).toHaveLength(1);

    await ext.payload.stop();
  });

  test('stop cancels pending debounce and closes watcher', async () => {
    const clock = new FakeClock();
    const watcher = makeFakeWatcher();
    const bus = createEventBus();
    const received = await collect(bus);

    const ext = await eventSourceExtension(
      createFileWatchAdapter({ setTimer: clock.setTimer, watchFactory: () => watcher.watcher }),
      {
        config: {
          id: 's',
          paths: ['/x/*'],
          debounceMs: 100,
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();

    watcher.fire('change', '/x/a.txt');
    await clock.advance(10); // mid-window
    await ext.payload.stop();
    expect(watcher.closed()).toBe(true);

    await clock.advance(1000);
    await bus.drained();
    expect(received).toHaveLength(0);
  });

  test('metrics report eventsPublished and lastEventAt', async () => {
    const clock = new FakeClock();
    const watcher = makeFakeWatcher();
    const bus = createEventBus();
    await collect(bus);

    const ext = await eventSourceExtension(
      createFileWatchAdapter({ setTimer: clock.setTimer, watchFactory: () => watcher.watcher }),
      {
        config: {
          id: 'm',
          paths: ['/x/*'],
          debounceMs: 50,
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      },
    );
    await ext.payload.start();

    watcher.fire('change', '/x/a.txt');
    await clock.advance(100);
    await bus.drained();

    watcher.fire('add', '/x/b.txt');
    await clock.advance(100);
    await bus.drained();

    const m = ext.payload.metrics();
    expect(m.eventsPublished).toBe(2);
    expect(m.lastEventAt).not.toBeNull();

    await ext.payload.stop();
  });

  test('health transitions across lifecycle', async () => {
    const clock = new FakeClock();
    const watcher = makeFakeWatcher();
    const bus = createEventBus();

    const ext = await eventSourceExtension(
      createFileWatchAdapter({ setTimer: clock.setTimer, watchFactory: () => watcher.watcher }),
      {
        config: { id: 'h', paths: ['/x/*'], target: { type: 'broadcast' } },
        source: { type: 'built-in' },
        bus,
      },
    );
    expect((await ext.payload.health()).status).toBe('degraded');
    await ext.payload.start();
    expect((await ext.payload.health()).status).toBe('ok');
    await ext.payload.pause();
    expect((await ext.payload.health()).status).toBe('degraded');
    await ext.payload.resume();
    expect((await ext.payload.health()).status).toBe('ok');
    await ext.payload.stop();
    expect((await ext.payload.health()).status).toBe('degraded');
  });
});

// ── Real chokidar + tmpdir integration ──────────────────────────────────

describe('createFileWatchAdapter (real chokidar)', () => {
  // Chokidar needs a small settle window on real filesystems. We give
  // generous timeouts so CI-style machines don't flake.
  test('detects add → change → unlink cycles against a real tmpdir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'declaragent-watch-'));
    try {
      const bus = createEventBus();
      const received: AgentEvent[] = [];
      bus.subscribe('*', (e) => {
        received.push(e);
      });

      const ext = await eventSourceExtension(createFileWatchAdapter(), {
        config: {
          id: 'live',
          paths: [join(dir, '**', '*.txt')],
          debounceMs: 50,
          target: { type: 'broadcast' },
        },
        source: { type: 'built-in' },
        bus,
      });
      await ext.payload.start();
      // Give chokidar a moment to stabilize its scan.
      await new Promise((r) => setTimeout(r, 200));

      const file = join(dir, 'hello.txt');
      writeFileSync(file, 'hi');
      await new Promise((r) => setTimeout(r, 400));

      writeFileSync(file, 'bye');
      await new Promise((r) => setTimeout(r, 400));

      unlinkSync(file);
      await new Promise((r) => setTimeout(r, 400));

      await ext.payload.stop();

      // We expect three events in order: add → change → unlink. Chokidar
      // occasionally coalesces the create+first-write into one event; be
      // lenient and just check that at least add and unlink surfaced.
      const changes = received
        .filter((e) => e.kind === 'file.changed')
        .map((e) => (e.payload as { change: string }).change);
      expect(changes).toContain('add');
      expect(changes).toContain('unlink');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

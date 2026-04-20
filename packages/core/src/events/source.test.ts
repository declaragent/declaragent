import { describe, expect, test } from 'bun:test';
import { createExtensionRegistry } from '../extension/registry.js';
import type { ExtensionRegistry } from '../extension/types.js';
import { createPermissionGate } from '../permission/gate.js';
import type { Logger } from '../types/logger.js';
import { createEventBus } from './bus.js';
import {
  adapterExtension,
  eventSourceExtension,
  findAdapter,
  listEventSources,
  sourceInstanceExtension,
} from './source.js';
import type {
  AgentEvent,
  EventSourceAdapter,
  EventSourceInstance,
  SourceDependencies,
} from './types.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function makeRegistry(): ExtensionRegistry {
  return createExtensionRegistry({
    logger: NOOP_LOGGER,
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    configDir: '/tmp',
  });
}

// ── Fake tick adapter ────────────────────────────────────────────────────
// Emits one broadcast event per `intervalMs` until `count` have fired or
// the instance is stopped. Used to exercise the adapter/wrapper contract
// without pulling in a real cron or HTTP server.

interface TickConfig {
  id: string;
  intervalMs: number;
  count: number;
}

const tickAdapter: EventSourceAdapter<TickConfig> = {
  type: 'tick',
  validateConfig(config: unknown): asserts config is TickConfig {
    if (!config || typeof config !== 'object') {
      throw new Error('tick config must be an object');
    }
    const c = config as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id) throw new Error('tick.id required');
    if (typeof c.intervalMs !== 'number') throw new Error('tick.intervalMs required');
    if (typeof c.count !== 'number') throw new Error('tick.count required');
  },
  async create(config: TickConfig, deps: SourceDependencies): Promise<EventSourceInstance> {
    let timer: ReturnType<typeof setInterval> | null = null;
    let emitted = 0;
    let lastEventAt: number | null = null;
    let paused = false;
    let started = false;
    let stopped = false;

    const emit = async (): Promise<void> => {
      if (paused || stopped) return;
      if (emitted >= config.count) {
        if (timer) clearInterval(timer);
        timer = null;
        return;
      }
      emitted += 1;
      lastEventAt = Date.now();
      const event: AgentEvent = {
        id: `${config.id}-tick-${emitted}`,
        kind: 'trigger.fire',
        source: { type: 'cron', triggerId: config.id, schedule: '*/1 * * * *' },
        target: { type: 'broadcast' },
        payload: { n: emitted },
        timestamp: lastEventAt,
        auth: { kind: 'trigger', triggerId: config.id },
      };
      await deps.bus.publish(event);
    };

    return {
      id: config.id,
      type: 'tick',
      async start() {
        if (started) return;
        started = true;
        stopped = false;
        timer = setInterval(() => {
          void emit();
        }, config.intervalMs);
      },
      async stop() {
        stopped = true;
        started = false;
        if (timer) clearInterval(timer);
        timer = null;
      },
      async pause() {
        paused = true;
      },
      async resume() {
        paused = false;
      },
      async health() {
        if (!started) return { status: 'degraded', details: stopped ? 'stopped' : 'not-started' };
        if (paused) return { status: 'degraded', details: 'paused' };
        return { status: 'ok' };
      },
      metrics() {
        return { eventsPublished: emitted, lastEventAt };
      },
    };
  },
};

describe('eventSourceExtension', () => {
  test('validateConfig failure propagates before create()', async () => {
    const bus = createEventBus();
    await expect(
      eventSourceExtension(tickAdapter, {
        config: { id: 'bad' }, // missing intervalMs + count
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('tick.intervalMs required');
  });

  test('descriptor id follows event-source:<type>:<instance.id>', async () => {
    const bus = createEventBus();
    const ext = await eventSourceExtension(tickAdapter, {
      config: { id: 'nightly', intervalMs: 5, count: 1 },
      source: { type: 'built-in' },
      bus,
    });
    expect(ext.descriptor.id).toBe('event-source:tick:nightly');
    expect(ext.descriptor.kind).toBe('event-source');
    expect(ext.descriptor.source).toEqual({ type: 'built-in' });
    await ext.payload.stop(); // release the never-started timer just in case
  });

  test('registry.register invokes start() and events land on the bus', async () => {
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      received.push(e);
    });
    const registry = makeRegistry();
    const ext = await eventSourceExtension(tickAdapter, {
      config: { id: 'ticker', intervalMs: 10, count: 3 },
      source: { type: 'built-in' },
      bus,
    });

    await registry.register(ext);
    // Wait long enough for all 3 ticks to fire.
    await new Promise((r) => setTimeout(r, 80));
    await registry.unregister(ext.descriptor.id);

    expect(received).toHaveLength(3);
    expect(received[0]?.source).toEqual({
      type: 'cron',
      triggerId: 'ticker',
      schedule: '*/1 * * * *',
    });
  });

  test('registry.unregister calls stop() and halts emission', async () => {
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      received.push(e);
    });
    const registry = makeRegistry();
    const ext = await eventSourceExtension(tickAdapter, {
      config: { id: 'stopper', intervalMs: 10, count: 100 },
      source: { type: 'built-in' },
      bus,
    });
    await registry.register(ext);
    await new Promise((r) => setTimeout(r, 25));
    await registry.unregister(ext.descriptor.id);
    const afterStop = received.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(received.length).toBe(afterStop);
  });

  test('pause halts emission; resume continues it', async () => {
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      received.push(e);
    });
    const registry = makeRegistry();
    const ext = await eventSourceExtension(tickAdapter, {
      config: { id: 'paused-src', intervalMs: 10, count: 100 },
      source: { type: 'built-in' },
      bus,
    });
    await registry.register(ext);
    await new Promise((r) => setTimeout(r, 25));
    await ext.payload.pause();
    const duringPause = received.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(received.length).toBe(duringPause);

    await ext.payload.resume();
    await new Promise((r) => setTimeout(r, 40));
    expect(received.length).toBeGreaterThan(duringPause);

    await registry.unregister(ext.descriptor.id);
  });

  test('health() reports ok/degraded across lifecycle transitions', async () => {
    const bus = createEventBus();
    const ext = await eventSourceExtension(tickAdapter, {
      config: { id: 'health-src', intervalMs: 10, count: 1 },
      source: { type: 'built-in' },
      bus,
    });
    expect((await ext.payload.health()).status).toBe('degraded'); // not started
    await ext.payload.start();
    expect((await ext.payload.health()).status).toBe('ok');
    await ext.payload.pause();
    expect((await ext.payload.health()).status).toBe('degraded');
    await ext.payload.resume();
    expect((await ext.payload.health()).status).toBe('ok');
    await ext.payload.stop();
    expect((await ext.payload.health()).status).toBe('degraded');
  });

  test('metrics() tracks events published and lastEventAt', async () => {
    const bus = createEventBus();
    const ext = await eventSourceExtension(tickAdapter, {
      config: { id: 'metrics-src', intervalMs: 10, count: 2 },
      source: { type: 'built-in' },
      bus,
    });
    expect(ext.payload.metrics()).toEqual({ eventsPublished: 0, lastEventAt: null });

    await ext.payload.start();
    await new Promise((r) => setTimeout(r, 60));
    await ext.payload.stop();

    const m = ext.payload.metrics();
    expect(m.eventsPublished).toBe(2);
    expect(m.lastEventAt).not.toBeNull();
  });

  test('adapter/instance type mismatch throws at wrap time', async () => {
    const bus = createEventBus();
    const liar: EventSourceAdapter<TickConfig> = {
      type: 'tick',
      validateConfig(_c: unknown): asserts _c is TickConfig {},
      async create(_cfg: TickConfig, _deps: SourceDependencies) {
        return {
          id: 'liar',
          type: 'not-tick',
          async start() {},
          async stop() {},
          async pause() {},
          async resume() {},
          async health() {
            return { status: 'ok' as const };
          },
          metrics() {
            return { eventsPublished: 0, lastEventAt: null };
          },
        };
      },
    };
    await expect(
      eventSourceExtension(liar, {
        config: { id: 'x', intervalMs: 10, count: 1 },
        source: { type: 'built-in' },
        bus,
      }),
    ).rejects.toThrow('type mismatch');
  });

  test('listEventSources returns every registered EventSourceInstance', async () => {
    const bus = createEventBus();
    const registry = makeRegistry();
    const a = await eventSourceExtension(tickAdapter, {
      config: { id: 'a', intervalMs: 10, count: 1 },
      source: { type: 'built-in' },
      bus,
    });
    const b = await eventSourceExtension(tickAdapter, {
      config: { id: 'b', intervalMs: 10, count: 1 },
      source: { type: 'user' },
      bus,
    });
    await registry.register(a);
    await registry.register(b);

    const sources = listEventSources(registry);
    expect(sources.map((s) => s.id).sort()).toEqual(['a', 'b']);

    await registry.unregister(a.descriptor.id);
    await registry.unregister(b.descriptor.id);
  });

  test('deactivate stops the instance even if start was called directly', async () => {
    const bus = createEventBus();
    const ext = await eventSourceExtension(tickAdapter, {
      config: { id: 'dedup', intervalMs: 10, count: 100 },
      source: { type: 'built-in' },
      bus,
    });
    await ext.payload.start();
    await new Promise((r) => setTimeout(r, 20));
    await ext.deactivate?.();
    const before = ext.payload.metrics().eventsPublished;
    await new Promise((r) => setTimeout(r, 30));
    expect(ext.payload.metrics().eventsPublished).toBe(before);
  });
});

// ─── Phase 4 slice 1: two-step registration ─────────────────────────────

// A second adapter type so we can verify findAdapter disambiguates.
const noopAdapter: EventSourceAdapter<{ id: string }> = {
  type: 'noop',
  agentCompat: '>=0.7.0',
  validateConfig(config: unknown): asserts config is { id: string } {
    if (!config || typeof (config as { id?: unknown }).id !== 'string') {
      throw new Error('noop config requires string id');
    }
  },
  async create(config, _deps): Promise<EventSourceInstance> {
    return {
      id: config.id,
      type: 'noop',
      async start() {},
      async stop() {},
      async pause() {},
      async resume() {},
      async health() {
        return { status: 'healthy' };
      },
      metrics() {
        return { eventsPublished: 0, lastEventAt: null };
      },
    };
  },
};

describe('adapterExtension + sourceInstanceExtension', () => {
  test('adapterExtension produces a registry entry with deterministic id', () => {
    const ext = adapterExtension(tickAdapter, { source: { type: 'built-in' } });
    expect(ext.descriptor.id).toBe('event-source-adapter:tick');
    expect(ext.descriptor.kind).toBe('event-source-adapter');
    expect(ext.payload).toBe(tickAdapter);
  });

  test('findAdapter resolves a registered adapter by type', async () => {
    const registry = makeRegistry();
    await registry.register(adapterExtension(tickAdapter, { source: { type: 'built-in' } }));
    await registry.register(adapterExtension(noopAdapter, { source: { type: 'built-in' } }));

    expect(findAdapter(registry, 'tick')).toBe(tickAdapter);
    expect(findAdapter(registry, 'noop')).toBe(noopAdapter);
    expect(findAdapter(registry, 'missing')).toBeUndefined();
  });

  test('duplicate adapter type is rejected by the registry', async () => {
    const registry = makeRegistry();
    await registry.register(adapterExtension(tickAdapter, { source: { type: 'built-in' } }));
    await expect(
      registry.register(adapterExtension(tickAdapter, { source: { type: 'user' } })),
    ).rejects.toThrow('already registered');
  });

  test('sourceInstanceExtension resolves adapter + creates + starts', async () => {
    const bus = createEventBus();
    const received: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      received.push(e);
    });
    const registry = makeRegistry();
    await registry.register(adapterExtension(tickAdapter, { source: { type: 'built-in' } }));

    const instanceExt = await sourceInstanceExtension(
      registry,
      {
        type: 'tick',
        config: { id: 'step', intervalMs: 10, count: 2 },
        source: { type: 'built-in' },
      },
      {
        bus,
        logger: NOOP_LOGGER,
        configDir: '/tmp',
      },
    );
    expect(instanceExt.descriptor.id).toBe('event-source:tick:step');
    expect(instanceExt.descriptor.kind).toBe('event-source');

    await registry.register(instanceExt);
    await new Promise((r) => setTimeout(r, 60));
    await registry.unregister(instanceExt.descriptor.id);

    expect(received).toHaveLength(2);
  });

  test('sourceInstanceExtension rejects unknown source type', async () => {
    const registry = makeRegistry();
    await expect(
      sourceInstanceExtension(
        registry,
        { type: 'unknown', config: {}, source: { type: 'built-in' } },
        { bus: createEventBus(), logger: NOOP_LOGGER, configDir: '/tmp' },
      ),
    ).rejects.toThrow('no adapter registered for source type "unknown"');
  });

  test('sourceInstanceExtension propagates adapter validateConfig errors', async () => {
    const registry = makeRegistry();
    await registry.register(adapterExtension(tickAdapter, { source: { type: 'built-in' } }));
    await expect(
      sourceInstanceExtension(
        registry,
        { type: 'tick', config: { id: 'x' }, source: { type: 'built-in' } }, // missing intervalMs + count
        { bus: createEventBus(), logger: NOOP_LOGGER, configDir: '/tmp' },
      ),
    ).rejects.toThrow('tick.intervalMs required');
  });

  test('adapter registration + per-source instances can both live in the registry', async () => {
    const registry = makeRegistry();
    await registry.register(adapterExtension(tickAdapter, { source: { type: 'built-in' } }));

    const a = await sourceInstanceExtension(
      registry,
      {
        type: 'tick',
        config: { id: 'a', intervalMs: 10, count: 1 },
        source: { type: 'built-in' },
      },
      { bus: createEventBus(), logger: NOOP_LOGGER, configDir: '/tmp' },
    );
    const b = await sourceInstanceExtension(
      registry,
      {
        type: 'tick',
        config: { id: 'b', intervalMs: 10, count: 1 },
        source: { type: 'built-in' },
      },
      { bus: createEventBus(), logger: NOOP_LOGGER, configDir: '/tmp' },
    );
    await registry.register(a);
    await registry.register(b);

    expect(
      listEventSources(registry)
        .map((s) => s.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(registry.byKind('event-source-adapter')).toHaveLength(1);

    await registry.unregister(a.descriptor.id);
    await registry.unregister(b.descriptor.id);
  });
});

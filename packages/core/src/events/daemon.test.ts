import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createExtensionRegistry } from '../extension/registry.js';
import type { ExtensionRegistry } from '../extension/types.js';
import { createPermissionGate } from '../permission/gate.js';
import type { LoadedTenant } from '../tenancy/config-loader.js';
import { DEFAULT_TENANT_ID } from '../tenancy/types.js';
import type { Logger } from '../types/logger.js';
import {
  type ControlRequest,
  NDJSONDecoder,
  encodeControlMessage,
  handleControlRequest,
  isControlRequest,
} from './control-protocol.js';
import { type ConfiguredSource, startDaemon } from './daemon.js';
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

// ── Fake adapter: emits one event when told ─────────────────────────────

interface PokeConfig {
  id: string;
  /** Arbitrary marker stamped onto every emitted event. Lets tests prove
   * that a config change really produced a new instance. */
  tag?: string;
}

function makePokeAdapter(): {
  adapter: EventSourceAdapter<PokeConfig>;
  pokeAll(): Promise<void>;
  created: PokeController[];
} {
  const created: PokeController[] = [];
  const adapter: EventSourceAdapter<PokeConfig> = {
    type: 'poke',
    validateConfig(c: unknown): asserts c is PokeConfig {
      if (!c || typeof c !== 'object' || typeof (c as PokeConfig).id !== 'string') {
        throw new Error('poke requires string id');
      }
    },
    async create(config: PokeConfig, deps: SourceDependencies): Promise<EventSourceInstance> {
      const controller = new PokeController(config.id, deps, config.tag);
      created.push(controller);
      return controller.toInstance();
    },
  };
  async function pokeAll(): Promise<void> {
    for (const c of created) await c.poke();
  }
  return { adapter, pokeAll, created };
}

class PokeController {
  started = false;
  stopped = false;
  paused = false;
  emitted = 0;
  lastAt: number | null = null;

  constructor(
    readonly id: string,
    readonly deps: SourceDependencies,
    readonly tag: string | undefined = undefined,
  ) {}

  async poke(): Promise<void> {
    if (!this.started || this.paused) return;
    this.emitted += 1;
    const now = Date.now();
    this.lastAt = now;
    const event: AgentEvent = {
      id: `${this.id}-evt-${this.emitted}-${now}-${Math.random()}`,
      kind: 'trigger.fire',
      source: { type: 'cron', triggerId: this.id, schedule: '* * * * *' },
      target: { type: 'broadcast' },
      timestamp: now,
      payload: { tag: this.tag },
      auth: { kind: 'trigger', triggerId: this.id },
    };
    await this.deps.bus.publish(event);
  }

  toInstance(): EventSourceInstance {
    const c = this;
    return {
      id: c.id,
      type: 'poke',
      async start() {
        c.started = true;
        c.stopped = false;
      },
      async stop() {
        c.started = false;
        c.stopped = true;
      },
      async pause() {
        c.paused = true;
      },
      async resume() {
        c.paused = false;
      },
      async health() {
        if (!c.started)
          return { status: 'degraded', details: c.stopped ? 'stopped' : 'not-started' };
        if (c.paused) return { status: 'degraded', details: 'paused' };
        return { status: 'ok' };
      },
      metrics() {
        return { eventsPublished: c.emitted, lastEventAt: c.lastAt };
      },
    };
  }
}

async function bootDaemon(sources: readonly ConfiguredSource[] = []): Promise<{
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  pokeAll: () => Promise<void>;
  controllers: PokeController[];
  cleanup(): void;
}> {
  const db = new Database(':memory:', { create: true });
  const registry = makeRegistry();
  const { adapter, pokeAll, created } = makePokeAdapter();
  const daemon = await startDaemon({
    db,
    registry,
    adapters: { poke: adapter as EventSourceAdapter<unknown> },
    sources,
    trackedMailboxAgents: ['watched-agent'],
  });
  return {
    daemon,
    pokeAll,
    controllers: created,
    cleanup() {
      db.close();
    },
  };
}

/** Adapter whose instance implements `replay()` — for slice-12 tests. */
async function bootDaemonWithReplaySource(id: string): Promise<{
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  cleanup(): void;
}> {
  const db = new Database(':memory:', { create: true });
  const registry = makeRegistry();
  const adapter: EventSourceAdapter<{ id: string }> = {
    type: 'replayable',
    validateConfig(c: unknown): asserts c is { id: string } {
      if (!c || typeof (c as { id: string }).id !== 'string') throw new Error('bad config');
    },
    async create(cfg): Promise<EventSourceInstance> {
      return {
        id: cfg.id,
        type: 'replayable',
        async start() {},
        async stop() {},
        async pause() {},
        async resume() {},
        async health() {
          return { status: 'ok' };
        },
        metrics() {
          return { eventsPublished: 0, lastEventAt: null };
        },
        async *replay() {
          for (let i = 0; i < 2; i++) {
            yield {
              id: `replayed-${i}`,
              kind: 'trigger.fire',
              source: { type: 'self', reason: 'wakeup' },
              target: { type: 'broadcast' },
              timestamp: Date.now(),
              payload: { i },
              auth: { kind: 'internal' },
            } satisfies AgentEvent;
          }
        },
      };
    },
  };
  const daemon = await startDaemon({
    db,
    registry,
    adapters: { replayable: adapter as EventSourceAdapter<unknown> },
    sources: [{ type: 'replayable', config: { id } }],
  });
  return { daemon, cleanup: () => db.close() };
}

/** Adapter whose instance implements listDLQ/showDLQ/redriveDLQ — for slice-12 tests. */
async function bootDaemonWithDLQSource(id: string): Promise<{
  daemon: Awaited<ReturnType<typeof startDaemon>>;
  cleanup(): void;
}> {
  const db = new Database(':memory:', { create: true });
  const registry = makeRegistry();
  const entries = [
    { id: 'dlq-1', body: 'one', headers: {}, reason: 'fail' },
    { id: 'dlq-2', body: 'two', headers: {}, reason: 'fail' },
  ];
  const redriven: string[] = [];
  const adapter: EventSourceAdapter<{ id: string }> = {
    type: 'dlq-capable',
    validateConfig(c: unknown): asserts c is { id: string } {
      if (!c || typeof (c as { id: string }).id !== 'string') throw new Error('bad config');
    },
    async create(cfg): Promise<EventSourceInstance> {
      return {
        id: cfg.id,
        type: 'dlq-capable',
        async start() {},
        async stop() {},
        async pause() {},
        async resume() {},
        async health() {
          return { status: 'ok' };
        },
        metrics() {
          return { eventsPublished: 0, lastEventAt: null };
        },
        async listDLQ() {
          return entries;
        },
        async showDLQ(id: string) {
          return entries.find((e) => e.id === id);
        },
        async redriveDLQ(id: string) {
          redriven.push(id);
        },
      };
    },
  };
  const daemon = await startDaemon({
    db,
    registry,
    adapters: { 'dlq-capable': adapter as EventSourceAdapter<unknown> },
    sources: [{ type: 'dlq-capable', config: { id } }],
  });
  return { daemon, cleanup: () => db.close() };
}

describe('startDaemon', () => {
  test('starts with no sources and reports an empty status', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      const status = await daemon.status();
      expect(status.sources).toEqual([]);
      expect(status.busRecentCount).toBe(0);
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('registers each ConfiguredSource and starts it', async () => {
    const { daemon, controllers, pokeAll, cleanup } = await bootDaemon([
      { type: 'poke', config: { id: 'a' } },
      { type: 'poke', config: { id: 'b' } },
    ]);
    try {
      expect(daemon.sources.size).toBe(2);
      expect(controllers.every((c) => c.started)).toBe(true);

      await pokeAll();
      await daemon.bus.drained();

      const status = await daemon.status();
      expect(status.sources.map((s) => s.id).sort()).toEqual(['a', 'b']);
      expect(status.sources.every((s) => s.health.status === 'ok')).toBe(true);
      expect(status.busRecentCount).toBe(2);
      expect(status.sources.every((s) => s.metrics.eventsPublished === 1)).toBe(true);
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('shutdown stops sources and no further events land', async () => {
    const { daemon, controllers, pokeAll, cleanup } = await bootDaemon([
      { type: 'poke', config: { id: 'a' } },
    ]);
    try {
      const received: AgentEvent[] = [];
      daemon.bus.subscribe('*', (e) => {
        received.push(e);
      });

      await pokeAll();
      await daemon.bus.drained();
      expect(received).toHaveLength(1);

      await daemon.shutdown();
      expect(controllers[0]?.stopped).toBe(true);

      // Poke again → instance is stopped so it no-ops.
      await pokeAll();
      await daemon.bus.drained();
      expect(received).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test('shutdown is idempotent (second call resolves immediately)', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      await daemon.shutdown();
      await daemon.shutdown(); // no throw
    } finally {
      cleanup();
    }
  });

  test('throws when a configured source type has no adapter registered', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      await expect(
        startDaemon({
          db,
          registry: makeRegistry(),
          adapters: {},
          sources: [{ type: 'nope', config: { id: 'x' } }],
        }),
      ).rejects.toThrow('no adapter registered');
    } finally {
      db.close();
    }
  });

  test('sendEvent routes through the dispatcher', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      const outcome = await daemon.sendEvent({
        id: 'ext-evt',
        kind: 'user.input',
        source: { type: 'user', sessionId: 'sess-1' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: {},
        auth: { kind: 'local-user' },
      });
      expect(outcome).toEqual({ kind: 'broadcast' });
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('waitForShutdown resolves after shutdown completes', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      const waited = daemon.waitForShutdown();
      await daemon.shutdown();
      await waited;
    } finally {
      cleanup();
    }
  });
});

// ── Control protocol unit tests ─────────────────────────────────────────

describe('handleControlRequest', () => {
  test('status returns the daemon status', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      const resp = await handleControlRequest(daemon, { id: 'req-1', method: 'status' });
      expect(resp.method).toBe('status');
      if ('result' in resp && resp.method === 'status') {
        expect(resp.result.uptimeMs).toBeGreaterThanOrEqual(0);
        expect(resp.result.sources).toEqual([]);
      }
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('reload with no sources is a no-op and returns empty diff', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      const resp = await handleControlRequest(daemon, { id: 'req-2', method: 'reload' });
      expect(resp.method).toBe('reload');
      if (resp.method === 'reload' && 'result' in resp) {
        expect(resp.result).toEqual({ added: [], removed: [], changed: [], unchanged: [] });
      }
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('shutdown acks immediately and completes asynchronously', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      const resp = await handleControlRequest(daemon, { id: 'req-3', method: 'shutdown' });
      expect(resp).toEqual({ id: 'req-3', method: 'shutdown', result: { ok: true } });
      await daemon.waitForShutdown();
    } finally {
      cleanup();
    }
  });

  test('send-event returns the dispatch outcome', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      const resp = await handleControlRequest(daemon, {
        id: 'req-4',
        method: 'send-event',
        params: {
          event: {
            id: 'sent-evt',
            kind: 'user.input',
            source: { type: 'user', sessionId: 's' },
            target: { type: 'broadcast' },
            timestamp: Date.now(),
            payload: {},
            auth: { kind: 'local-user' },
          },
        },
      });
      expect(resp.method).toBe('send-event');
      if (resp.method === 'send-event' && 'result' in resp) {
        expect(resp.result.outcome).toEqual({ kind: 'broadcast' });
      }
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('replay-range returns the replayed + dispatched counts', async () => {
    const { daemon, cleanup } = await bootDaemonWithReplaySource('replayer');
    try {
      const resp = await handleControlRequest(daemon, {
        id: 'req-rp',
        method: 'replay-range',
        params: { sourceId: 'replayer', fromMs: 0, dispatch: true },
      });
      expect(resp.method).toBe('replay-range');
      if (resp.method === 'replay-range' && 'result' in resp) {
        expect(resp.result.replayed).toBe(2);
        expect(resp.result.dispatched).toBe(2);
        expect(resp.result.outcomes).toHaveLength(2);
      }
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('replay-range errors when the source does not support replay', async () => {
    const { daemon, cleanup } = await bootDaemon([{ type: 'poke', config: { id: 'no-replay' } }]);
    try {
      const resp = await handleControlRequest(daemon, {
        id: 'req-rp',
        method: 'replay-range',
        params: { sourceId: 'no-replay', fromMs: 0 },
      });
      expect('error' in resp).toBe(true);
      if ('error' in resp) expect(resp.error.message).toMatch(/does not support replay/);
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('dlq-list / dlq-show / dlq-redrive round-trip against an adapter that exposes them', async () => {
    const { daemon, cleanup } = await bootDaemonWithDLQSource('dlq-src');
    try {
      const listResp = await handleControlRequest(daemon, {
        id: 'req-dl',
        method: 'dlq-list',
        params: { sourceId: 'dlq-src' },
      });
      expect(listResp.method).toBe('dlq-list');
      if (listResp.method === 'dlq-list' && 'result' in listResp) {
        expect(listResp.result.entries).toHaveLength(2);
      }

      const showResp = await handleControlRequest(daemon, {
        id: 'req-ds',
        method: 'dlq-show',
        params: { sourceId: 'dlq-src', entryId: 'dlq-1' },
      });
      expect(showResp.method).toBe('dlq-show');
      if (showResp.method === 'dlq-show' && 'result' in showResp) {
        expect(showResp.result.entry?.id).toBe('dlq-1');
      }

      const redriveResp = await handleControlRequest(daemon, {
        id: 'req-dr',
        method: 'dlq-redrive',
        params: { sourceId: 'dlq-src', entryId: 'dlq-1' },
      });
      expect(redriveResp.method).toBe('dlq-redrive');
      if (redriveResp.method === 'dlq-redrive' && 'result' in redriveResp) {
        expect(redriveResp.result.ok).toBe(true);
      }
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('dlq-list errors when the source adapter does not expose DLQ access', async () => {
    const { daemon, cleanup } = await bootDaemon([{ type: 'poke', config: { id: 'no-dlq' } }]);
    try {
      const resp = await handleControlRequest(daemon, {
        id: 'req-dlx',
        method: 'dlq-list',
        params: { sourceId: 'no-dlq' },
      });
      expect('error' in resp).toBe(true);
      if ('error' in resp) expect(resp.error.message).toMatch(/does not expose DLQ access/);
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('handler errors surface as error responses, not throws', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      // Monkey-patch status() to blow up.
      const broken = {
        ...daemon,
        async status() {
          throw new Error('boom');
        },
      };
      const resp = await handleControlRequest(broken as unknown as typeof daemon, {
        id: 'req-5',
        method: 'status',
      });
      expect('error' in resp).toBe(true);
      if ('error' in resp) expect(resp.error.message).toBe('boom');
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });
});

describe('NDJSON helpers', () => {
  test('isControlRequest narrows valid shapes', () => {
    expect(isControlRequest({ id: 'a', method: 'status' })).toBe(true);
    expect(isControlRequest({ id: 'a', method: 'unknown' })).toBe(false);
    expect(isControlRequest({})).toBe(false);
    expect(isControlRequest(null)).toBe(false);
  });

  test('encodeControlMessage produces NDJSON that round-trips', () => {
    const req: ControlRequest = { id: 'a', method: 'status' };
    const wire = encodeControlMessage(req);
    expect(wire.endsWith('\n')).toBe(true);
    const decoder = new NDJSONDecoder();
    const parsed = decoder.push(wire);
    expect(parsed).toEqual([req]);
  });

  test('NDJSONDecoder buffers partial lines', () => {
    const decoder = new NDJSONDecoder();
    expect(decoder.push('{"id":"a","meth')).toEqual([]);
    const rest = decoder.push('od":"status"}\n{"id":"b","method":"reload"}\n');
    expect(rest).toEqual([
      { id: 'a', method: 'status' },
      { id: 'b', method: 'reload' },
    ]);
  });

  test('NDJSONDecoder skips malformed lines', () => {
    const decoder = new NDJSONDecoder();
    const parsed = decoder.push('{bad}\n{"id":"ok","method":"reload"}\n');
    expect(parsed).toEqual([{ id: 'ok', method: 'reload' }]);
  });
});

// ── Hot reload (slice 10) ───────────────────────────────────────────────

describe('daemon.reload', () => {
  test('identical new sources report all as unchanged', async () => {
    const { daemon, cleanup } = await bootDaemon([
      { type: 'poke', config: { id: 'a' } },
      { type: 'poke', config: { id: 'b' } },
    ]);
    try {
      const result = await daemon.reload({
        sources: [
          { type: 'poke', config: { id: 'a' } },
          { type: 'poke', config: { id: 'b' } },
        ],
      });
      expect([...result.unchanged].sort()).toEqual(['poke:a', 'poke:b']);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.changed).toEqual([]);
      expect(daemon.sources.size).toBe(2);
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('adds new sources', async () => {
    const { daemon, cleanup } = await bootDaemon([{ type: 'poke', config: { id: 'a' } }]);
    try {
      const result = await daemon.reload({
        sources: [
          { type: 'poke', config: { id: 'a' } },
          { type: 'poke', config: { id: 'b' } },
        ],
      });
      expect(result.added).toEqual(['poke:b']);
      expect(result.unchanged).toEqual(['poke:a']);
      expect(daemon.sources.size).toBe(2);
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('removes missing sources', async () => {
    const { daemon, controllers, cleanup } = await bootDaemon([
      { type: 'poke', config: { id: 'a' } },
      { type: 'poke', config: { id: 'b' } },
    ]);
    try {
      const result = await daemon.reload({ sources: [{ type: 'poke', config: { id: 'a' } }] });
      expect(result.removed).toEqual(['poke:b']);
      expect(daemon.sources.size).toBe(1);
      const bController = controllers.find((c) => c.id === 'b');
      expect(bController?.stopped).toBe(true);
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('config changes rebuild the instance (new controller, old stopped)', async () => {
    const { daemon, controllers, pokeAll, cleanup } = await bootDaemon([
      { type: 'poke', config: { id: 'a', tag: 'v1' } },
    ]);
    try {
      const received: AgentEvent[] = [];
      daemon.bus.subscribe('*', (e) => {
        received.push(e);
      });

      await pokeAll();
      await daemon.bus.drained();
      expect((received[0] as AgentEvent<{ tag?: string }>).payload.tag).toBe('v1');

      const result = await daemon.reload({
        sources: [{ type: 'poke', config: { id: 'a', tag: 'v2' } }],
      });
      expect(result.changed).toEqual(['poke:a']);
      expect(result.added).toEqual([]);
      expect(result.removed).toEqual([]);

      // Old controller is stopped; there are now two PokeControllers total.
      const oldA = controllers[0];
      const newA = controllers[1];
      expect(controllers.length).toBe(2);
      expect(oldA?.stopped).toBe(true);
      expect(newA?.started).toBe(true);
      expect(newA?.tag).toBe('v2');

      await pokeAll();
      await daemon.bus.drained();
      const recent = received.filter((e) => e.source.type === 'cron');
      expect((recent.at(-1) as AgentEvent<{ tag?: string }>).payload.tag).toBe('v2');

      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('bus subscription survives reload (in-flight events still reach subscribers)', async () => {
    const { daemon, pokeAll, cleanup } = await bootDaemon([{ type: 'poke', config: { id: 'a' } }]);
    try {
      const received: AgentEvent[] = [];
      daemon.bus.subscribe('*', (e) => {
        received.push(e);
      });

      // Kick off several pokes concurrently, reload mid-flight, then kick
      // off more. Every published event should reach the subscriber.
      const firstBurst = Promise.all(Array.from({ length: 5 }, () => pokeAll()));
      const reloadPromise = daemon.reload({
        sources: [{ type: 'poke', config: { id: 'a', tag: 'v2' } }],
      });
      await firstBurst;
      await reloadPromise;
      await pokeAll();
      await pokeAll();
      await daemon.bus.drained();

      // 5 pre-reload pokes on the v1 instance (before it stopped) + 2
      // post-reload pokes on the v2 instance. All seven should reach the
      // subscriber — none were dropped by the reload itself.
      expect(received.length).toBeGreaterThanOrEqual(7);
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('sourcesProvider is consulted when no explicit sources are supplied', async () => {
    const db = new Database(':memory:', { create: true });
    const registry = makeRegistry();
    const { adapter, created } = makePokeAdapter();
    let providerCalls = 0;
    const daemon = await startDaemon({
      db,
      registry,
      adapters: { poke: adapter as EventSourceAdapter<unknown> },
      sources: [{ type: 'poke', config: { id: 'a' } }],
      sourcesProvider: () => {
        providerCalls += 1;
        return [
          { type: 'poke', config: { id: 'a' } },
          { type: 'poke', config: { id: 'b' } },
        ];
      },
    });
    try {
      const result = await daemon.reload();
      expect(providerCalls).toBe(1);
      expect(result.added).toEqual(['poke:b']);
      expect(daemon.sources.size).toBe(2);
      expect(created.length).toBe(2);
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('configs without a string id are rejected', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      await expect(daemon.reload({ sources: [{ type: 'poke', config: {} }] })).rejects.toThrow(
        'string "id"',
      );
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });

  test('duplicate keys in new sources list are rejected', async () => {
    const { daemon, cleanup } = await bootDaemon();
    try {
      await expect(
        daemon.reload({
          sources: [
            { type: 'poke', config: { id: 'x' } },
            { type: 'poke', config: { id: 'x' } },
          ],
        }),
      ).rejects.toThrow('duplicate source key');
      await daemon.shutdown();
    } finally {
      cleanup();
    }
  });
});

describe('startDaemon — multi-tenant', () => {
  const tenantAcme: LoadedTenant = {
    context: {
      id: 'acme-prod',
      displayName: 'ACME Production',
      quotas: { maxConcurrentToolCalls: 2 },
    },
  };
  const tenantBeta: LoadedTenant = {
    context: {
      id: 'beta-tenant',
      displayName: 'Beta',
    },
  };

  test('single-tenant default: daemon.tenants always exposes the default runtime', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
      });
      expect([...daemon.tenants.keys()]).toEqual([DEFAULT_TENANT_ID]);
      const defaultRuntime = daemon.tenants.get(DEFAULT_TENANT_ID);
      expect(defaultRuntime).toBeDefined();
      // The default runtime shares the primary bus so sources stay wired.
      expect(defaultRuntime?.bus).toBe(daemon.bus);
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('multi-tenant: one runtime per tenant, primary bus separate from tenant buses', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
        tenants: [tenantAcme, tenantBeta],
      });
      expect([...daemon.tenants.keys()].sort()).toEqual(['acme-prod', 'beta-tenant']);
      const acme = daemon.tenants.get('acme-prod');
      const beta = daemon.tenants.get('beta-tenant');
      expect(acme?.tenant.id).toBe('acme-prod');
      expect(beta?.tenant.id).toBe('beta-tenant');
      // Each tenant gets its own bus in per-tenant strategy.
      expect(acme?.bus).not.toBe(beta?.bus);
      expect(acme?.bus).not.toBe(daemon.bus);
      expect(beta?.bus).not.toBe(daemon.bus);
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('sendEvent rejects an unknown tenantId with `unauthorized`', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
        tenants: [tenantAcme],
      });
      const outcome = await daemon.sendEvent({
        id: 'evt-1',
        kind: 'user.input',
        source: { type: 'user', sessionId: 's1' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: {},
        auth: { kind: 'internal' },
        meta: { tenantId: 'rogue-tenant' },
      });
      expect(outcome).toEqual({
        kind: 'rejected',
        reason: 'unauthorized',
        details: 'unknown tenant "rogue-tenant"',
      });
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('sendEvent dispatches broadcast events to known tenants', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
        tenants: [tenantAcme],
      });
      const outcome = await daemon.sendEvent({
        id: 'evt-ok',
        kind: 'user.input',
        source: { type: 'user', sessionId: 's1' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: {},
        auth: { kind: 'internal' },
        meta: { tenantId: 'acme-prod' },
      });
      expect(outcome.kind).toBe('broadcast');
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('tenantAudit factory is invoked once per tenant at startup', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const invocations: string[] = [];
      const recordCalls: string[] = [];
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
        tenants: [tenantAcme, tenantBeta],
        tenantAudit: (t) => {
          invocations.push(t.id);
          return {
            record: async (r: { kind: string }) => {
              recordCalls.push(`${t.id}:${r.kind}`);
            },
          };
        },
      });
      expect(invocations.sort()).toEqual(['acme-prod', 'beta-tenant']);
      // The audit sink is wired — trip a quota to verify it gets called.
      const acme = daemon.tenants.get('acme-prod');
      acme?.quotas.acquireToolCall();
      acme?.quotas.acquireToolCall();
      expect(() => acme?.quotas.acquireToolCall()).toThrow(/exceeded quota/);
      // Audit writes are async — let them drain.
      await new Promise((r) => setTimeout(r, 5));
      expect(recordCalls).toContain('acme-prod:quota_exceeded');
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('per-tenant Prometheus registries auto-stamp tenant_id on every sample', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
        tenants: [tenantAcme, tenantBeta],
      });
      const acme = daemon.tenants.get('acme-prod');
      const beta = daemon.tenants.get('beta-tenant');
      expect(acme?.metrics).toBeDefined();
      expect(beta?.metrics).toBeDefined();
      // Distinct registries per tenant.
      expect(acme?.metrics).not.toBe(beta?.metrics);

      acme?.metrics?.counter('agent.tool.calls', 'Tool invocations').inc(3);
      beta?.metrics?.counter('agent.tool.calls', 'Tool invocations').inc(7);
      // Label at write time should merge with the constLabel.
      acme?.metrics?.counter('agent.tool.calls').inc(1, { outcome: 'allow' });

      const acmeScrape = acme?.metrics?.scrape() ?? '';
      const betaScrape = beta?.metrics?.scrape() ?? '';
      expect(acmeScrape).toContain('tenant_id="acme-prod"');
      expect(acmeScrape).not.toContain('tenant_id="beta-tenant"');
      expect(acmeScrape).toMatch(/agent_tool_calls\{tenant_id="acme-prod"\} 3/);
      expect(acmeScrape).toMatch(/agent_tool_calls\{outcome="allow",tenant_id="acme-prod"\} 1/);

      expect(betaScrape).toContain('tenant_id="beta-tenant"');
      expect(betaScrape).toMatch(/agent_tool_calls\{tenant_id="beta-tenant"\} 7/);
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('tenantMetricsStrategy="none" opts out of per-tenant registries', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
        tenants: [tenantAcme],
        tenantMetricsStrategy: 'none',
      });
      expect(daemon.tenants.get('acme-prod')?.metrics).toBeUndefined();
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('tenantMetricsStrategy="shared" gives every tenant the same registry', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
        tenants: [tenantAcme, tenantBeta],
        tenantMetricsStrategy: 'shared',
      });
      const acme = daemon.tenants.get('acme-prod')?.metrics;
      const beta = daemon.tenants.get('beta-tenant')?.metrics;
      expect(acme).toBeDefined();
      expect(acme).toBe(beta);
      // Shared registry does NOT auto-stamp tenant_id — callers supply it.
      acme?.counter('agent.channel.messages').inc(1, { tenant_id: 'acme-prod' });
      beta?.counter('agent.channel.messages').inc(2, { tenant_id: 'beta-tenant' });
      const scrape = acme?.scrape() ?? '';
      expect(scrape).toMatch(/agent_channel_messages\{tenant_id="acme-prod"\} 1/);
      expect(scrape).toMatch(/agent_channel_messages\{tenant_id="beta-tenant"\} 2/);
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });

  test('single-tenant mode: default runtime has no metrics registry unless strategy="shared"', async () => {
    const db = new Database(':memory:', { create: true });
    try {
      const daemon = await startDaemon({
        db,
        registry: makeRegistry(),
        adapters: {},
      });
      expect(daemon.tenants.get(DEFAULT_TENANT_ID)?.metrics).toBeUndefined();
      await daemon.shutdown();
    } finally {
      db.close();
    }
  });
});

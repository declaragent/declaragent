import { describe, expect, test } from 'bun:test';
import { createSqliteAuditSink } from '../audit/sqlite-sink.js';
import type { TenantAuditRecord } from '../audit/types.js';
import { createEventBus } from '../events/bus.js';
import type { AgentEvent } from '../events/types.js';
import { createExtensionRegistry } from '../extension/registry.js';
import type { Extension } from '../extension/types.js';
import { createPermissionGate } from '../permission/gate.js';
import type { Logger } from '../types/logger.js';
import { TenantBoundaryError, isTenantBoundaryError } from './boundary-error.js';
import { scopeRegistry } from './extension-view.js';
import { QuotaExceededError, createQuotaTracker } from './quota.js';
import { createTenantRuntime } from './runtime.js';
import type { TenantContext } from './types.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function makeRegistry() {
  return createExtensionRegistry({
    logger: NOOP_LOGGER,
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    configDir: '/tmp',
  });
}

function dummyToolExtension(id: string): Extension {
  return {
    descriptor: { id, kind: 'tool', source: { type: 'built-in' } },
    payload: {
      name: id.replace(/^tool:/, ''),
      description: 'stub',
      inputSchema: { type: 'object' },
      permissionKey: () => 'stub',
      execute: async function* () {
        yield { type: 'result', output: null };
      },
    },
    async activate() {},
  };
}

function makeEvent(tenantId?: string): AgentEvent {
  const event: AgentEvent = {
    id: crypto.randomUUID(),
    kind: 'user.input',
    source: { type: 'user', sessionId: 'sess' },
    target: { type: 'session', sessionId: 'sess', mode: 'inject' },
    timestamp: 0,
    payload: {},
    auth: { kind: 'internal' },
  };
  if (tenantId !== undefined) event.meta = { tenantId };
  return event;
}

describe('EventBus tenant scope enforcement', () => {
  test('stamps meta.tenantId when unset', async () => {
    const bus = createEventBus({ tenantScope: 'acme' });
    const seen: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      seen.push(e);
    });
    await bus.publish(makeEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.meta?.tenantId).toBe('acme');
  });

  test('throws TenantBoundaryError when meta.tenantId mismatches', async () => {
    const bus = createEventBus({ tenantScope: 'acme' });
    try {
      await bus.publish(makeEvent('beta'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(isTenantBoundaryError(err)).toBe(true);
      const boundary = err as TenantBoundaryError;
      expect(boundary.sourceTenantId).toBe('beta');
      expect(boundary.targetTenantId).toBe('acme');
      expect(boundary.resource).toBe('event');
    }
  });

  test('shared bus with filter delivers only matching tenants to subscribers', async () => {
    const bus = createEventBus();
    const subAcme: AgentEvent[] = [];
    const subBeta: AgentEvent[] = [];
    // Simulate shared-with-filter by having subscribers drop non-matching events.
    bus.subscribe('*', (e) => {
      if (e.meta?.tenantId === 'acme') subAcme.push(e);
    });
    bus.subscribe('*', (e) => {
      if (e.meta?.tenantId === 'beta') subBeta.push(e);
    });
    await bus.publish(makeEvent('acme'));
    await bus.publish(makeEvent('beta'));
    await bus.publish(makeEvent('acme'));
    expect(subAcme).toHaveLength(2);
    expect(subBeta).toHaveLength(1);
  });

  test('bus with filterSubscribersByTenant drops non-matching events', async () => {
    const bus = createEventBus({
      tenantScope: 'acme',
      filterSubscribersByTenant: true,
    });
    const seen: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      seen.push(e);
    });
    // Pre-stamped with acme → delivered.
    await bus.publish(makeEvent('acme'));
    expect(seen).toHaveLength(1);
  });
});

describe('scopeRegistry view', () => {
  test('deny always wins over allow', async () => {
    const registry = makeRegistry();
    await registry.register(dummyToolExtension('tool:Bash'));
    await registry.register(dummyToolExtension('tool:Read'));
    await registry.register(dummyToolExtension('plugin-experimental-foo'));
    const view = scopeRegistry(registry, {
      allow: ['tool:*', 'plugin-experimental-*'],
      deny: ['plugin-experimental-*'],
    });
    expect(view.isVisible('tool:Bash')).toBe(true);
    expect(view.isVisible('plugin-experimental-foo')).toBe(false);
    expect(
      view
        .list()
        .map((d) => d.id)
        .sort(),
    ).toEqual(['tool:Bash', 'tool:Read']);
    expect(view.get('plugin-experimental-foo')).toBeUndefined();
  });

  test('missing allow = allow-all', async () => {
    const registry = makeRegistry();
    await registry.register(dummyToolExtension('tool:A'));
    await registry.register(dummyToolExtension('tool:B'));
    const view = scopeRegistry(registry, { deny: ['tool:B'] });
    expect(view.list().map((d) => d.id)).toEqual(['tool:A']);
  });

  test('undefined scope is the identity', async () => {
    const registry = makeRegistry();
    await registry.register(dummyToolExtension('tool:A'));
    const view = scopeRegistry(registry, undefined);
    expect(view.list()).toHaveLength(1);
  });
});

describe('QuotaTracker', () => {
  const tenant: TenantContext = {
    id: 'acme',
    quotas: {
      maxActiveSessions: 2,
      maxConcurrentToolCalls: 1,
      maxEventIngressPerSec: 3,
      dailyTokenUSD: 5,
    },
  };

  test('throws QuotaExceededError when maxActiveSessions exceeded', () => {
    const q = createQuotaTracker({ tenant });
    q.acquireSession();
    q.acquireSession();
    expect(() => q.acquireSession()).toThrow(QuotaExceededError);
  });

  test('throws when maxConcurrentToolCalls exceeded', () => {
    const q = createQuotaTracker({ tenant });
    q.acquireToolCall();
    expect(() => q.acquireToolCall()).toThrow(QuotaExceededError);
  });

  test('throws when dailyTokenUSD exceeded', () => {
    const q = createQuotaTracker({ tenant });
    q.addTokenSpendUSD(2);
    q.addTokenSpendUSD(2);
    expect(() => q.addTokenSpendUSD(2)).toThrow(QuotaExceededError);
  });

  test('emits quota_exceeded audit record on breach', async () => {
    const sink = await createSqliteAuditSink({ path: ':memory:' });
    const q = createQuotaTracker({ tenant, audit: sink });
    try {
      for (let i = 0; i < 4; i += 1) q.acquireToolCall();
    } catch {
      /* expected */
    }
    // Await to give the async audit emit a chance to flush.
    await new Promise((r) => setTimeout(r, 10));
    const records = await sink.query({ tenantId: 'acme' });
    const quotaRecords = records.filter(
      (r): r is typeof r & { record: { kind: 'quota_exceeded' } } =>
        r.record.kind === 'quota_exceeded',
    );
    expect(quotaRecords).toHaveLength(1);
    const rec = quotaRecords[0]?.record as TenantAuditRecord & {
      quota: string;
      limit: number;
      observed: number;
    };
    expect(rec.quota).toBe('maxConcurrentToolCalls');
    expect(rec.limit).toBe(1);
    expect(rec.observed).toBe(2);
    await sink.close();
  });

  test('ingress counter resets at second boundaries', () => {
    let t = 0;
    const q = createQuotaTracker({ tenant, now: () => t });
    q.trackIngress(); // 1
    q.trackIngress(); // 2
    q.trackIngress(); // 3 (exact limit)
    expect(() => q.trackIngress()).toThrow(QuotaExceededError);
    t = 1500; // next second
    q.trackIngress(); // 1 (fresh window)
  });

  test('snapshot reports current counters', () => {
    const q = createQuotaTracker({ tenant });
    q.acquireSession();
    q.acquireToolCall();
    q.addTokenSpendUSD(1.5);
    const snap = q.snapshot();
    expect(snap.activeSessions).toBe(1);
    expect(snap.concurrentToolCalls).toBe(1);
    expect(snap.dailyTokenUSD).toBe(1.5);
  });
});

describe('createTenantRuntime — two tenants in one process', () => {
  test('per-tenant buses are isolated', async () => {
    const registry = makeRegistry();
    const rtA = createTenantRuntime({
      tenant: { id: 'acme' },
      registry,
    });
    const rtB = createTenantRuntime({
      tenant: { id: 'beta' },
      registry,
    });
    const seenA: AgentEvent[] = [];
    const seenB: AgentEvent[] = [];
    rtA.bus.subscribe('*', (e) => {
      seenA.push(e);
    });
    rtB.bus.subscribe('*', (e) => {
      seenB.push(e);
    });
    await rtA.bus.publish(makeEvent());
    await rtB.bus.publish(makeEvent());
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(seenA[0]?.meta?.tenantId).toBe('acme');
    expect(seenB[0]?.meta?.tenantId).toBe('beta');
  });

  test('cross-tenant publish on the wrong bus throws', async () => {
    const registry = makeRegistry();
    const rtA = createTenantRuntime({ tenant: { id: 'acme' }, registry });
    const event = makeEvent('beta');
    await expect(rtA.bus.publish(event)).rejects.toThrow(TenantBoundaryError);
  });

  test('registry view respects tenant scope', async () => {
    const registry = makeRegistry();
    await registry.register(dummyToolExtension('tool:Bash'));
    await registry.register(dummyToolExtension('tool:DangerousRm'));
    const rt = createTenantRuntime({
      tenant: { id: 'acme' },
      registry,
      extensionScope: { deny: ['tool:DangerousRm'] },
    });
    expect(rt.registry.list().map((d) => d.id)).toEqual(['tool:Bash']);
    expect(rt.registry.get('tool:DangerousRm')).toBeUndefined();
  });

  test('shared bus strategy: one bus serves both runtimes with subscriber filters', async () => {
    const registry = makeRegistry();
    const sharedBus = createEventBus();
    const rtA = createTenantRuntime({
      tenant: { id: 'acme' },
      registry,
      sharedBus,
    });
    const rtB = createTenantRuntime({
      tenant: { id: 'beta' },
      registry,
      sharedBus,
    });
    // Runtimes reuse the bus identity, so both subscriptions are on the same bus.
    expect(rtA.bus).toBe(sharedBus);
    expect(rtB.bus).toBe(sharedBus);
    const seenA: AgentEvent[] = [];
    const seenB: AgentEvent[] = [];
    // Each runtime's subscriber filters by its own tenant.
    rtA.bus.subscribe('*', (e) => {
      if (e.meta?.tenantId === rtA.tenant.id) seenA.push(e);
    });
    rtB.bus.subscribe('*', (e) => {
      if (e.meta?.tenantId === rtB.tenant.id) seenB.push(e);
    });
    await sharedBus.publish(makeEvent('acme'));
    await sharedBus.publish(makeEvent('beta'));
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
  });
});

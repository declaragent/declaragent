import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionRegistry } from '../extension/registry.js';
import type { Extension, ExtensionRegistry } from '../extension/types.js';
import { createHookRegistry } from '../hooks/registry.js';
import { createPermissionGate } from '../permission/gate.js';
import type { Skill } from '../skills/types.js';
import { createMemorySession } from '../testing/memory-session.js';
import type { RunAgent, RunAgentInput, RunAgentResult } from '../types/agent.js';
import type { Logger } from '../types/logger.js';
import type { SessionHandle } from '../types/session.js';
import { createEventBus } from './bus.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { createEventDispatcher, frameEvent } from './dispatcher.js';
import { createEventStore } from './store.js';
import type { AgentEvent, EventTarget } from './types.js';

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NOOP_LOGGER,
};

function okResult(): RunAgentResult {
  return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
}

function recordingRunAgent(): {
  runAgent: RunAgent;
  calls: RunAgentInput[];
} {
  const calls: RunAgentInput[] = [];
  const runAgent: RunAgent = async (input) => {
    calls.push(input);
    return okResult();
  };
  return { runAgent, calls };
}

function makeEvent(
  overrides: Partial<AgentEvent> & { id: string; target: EventTarget },
): AgentEvent {
  return {
    kind: 'trigger.fire',
    source: { type: 'self', reason: 'wakeup' },
    timestamp: 0,
    payload: {},
    auth: { kind: 'internal' },
    ...overrides,
  };
}

function makeRegistry(): ExtensionRegistry {
  return createExtensionRegistry({
    logger: NOOP_LOGGER,
    permissions: createPermissionGate({ mode: 'bypass', rules: [] }),
    configDir: '/tmp',
  });
}

function makeSkillExtension(lookupName: string, prompt: string): Extension<'skill'> {
  const skill: Skill = {
    descriptor: {
      id: `skill:user:${lookupName}`,
      kind: 'skill',
      source: { type: 'user' },
    },
    lookupName,
    tier: { type: 'user' },
    frontmatter: { name: lookupName, description: 'test' },
    prompt,
    filePath: `/skills/${lookupName}.md`,
  };
  return { descriptor: skill.descriptor, payload: skill, activate() {} };
}

describe('createEventDispatcher', () => {
  describe('routing', () => {
    test('target: broadcast resolves to broadcast outcome', async () => {
      const { runAgent } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
      });
      const outcome = await dispatcher.handle(
        makeEvent({ id: 'e1', target: { type: 'broadcast' } }),
      );
      expect(outcome).toEqual({ kind: 'broadcast' });
    });

    test('target: session calls runAgent on the resolved session', async () => {
      const session = createMemorySession({ id: 'sess-1' });
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        resolveSession: (id) => (id === 'sess-1' ? session : undefined),
      });
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'e1',
          target: { type: 'session', sessionId: 'sess-1', mode: 'inject' },
        }),
      );
      expect(outcome).toEqual({ kind: 'dispatched', sessionId: 'sess-1' });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.session.id).toBe('sess-1');
      expect(calls[0]?.userMessage).toContain('<event ');
      expect(calls[0]?.userMessage).toContain('id="e1"');
    });

    test('target: session returns no-handler when session is missing', async () => {
      const { runAgent } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        resolveSession: () => undefined,
      });
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'e1',
          target: { type: 'session', sessionId: 'missing', mode: 'inject' },
        }),
      );
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('no-handler');
    });

    test('target: session returns no-handler when resolveSession factory is absent', async () => {
      const { runAgent } = recordingRunAgent();
      const dispatcher = createEventDispatcher({ registry: makeRegistry(), runAgent });
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'e1',
          target: { type: 'session', sessionId: 's', mode: 'inject' },
        }),
      );
      expect(outcome.kind).toBe('rejected');
    });

    test('target: new-session mints a session and prefixes initialPrompt', async () => {
      let mintedId = '';
      const createSession = () => {
        const s = createMemorySession();
        mintedId = s.id;
        return s;
      };
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        createSession,
      });
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'e1',
          target: { type: 'new-session', initialPrompt: 'hello there' },
        }),
      );
      expect(outcome).toEqual({ kind: 'dispatched', sessionId: mintedId });
      expect(calls[0]?.userMessage.startsWith('hello there')).toBe(true);
      expect(calls[0]?.userMessage).toContain('<event ');
    });

    test('target: skill invokes runSkill with a child session', async () => {
      const registry = makeRegistry();
      await registry.register(makeSkillExtension('greet', 'hi {{name}}'));
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry,
        runAgent,
        createChildSession: () => createMemorySession(),
      });
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'e1',
          target: { type: 'skill', name: 'greet', inputs: { name: 'world' } },
        }),
      );
      expect(outcome.kind).toBe('dispatched');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.userMessage).toContain('hi world');
    });

    test('target: skill rejects when the skill is not registered', async () => {
      const { runAgent } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        createChildSession: () => createMemorySession(),
      });
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'e1',
          target: { type: 'skill', name: 'nope', inputs: {} },
        }),
      );
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('no-handler');
    });

    test('target: sub-agent creates a child session and runs at depth 1', async () => {
      let createdParentId = '';
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        createChildSession: (parentId) => {
          createdParentId = parentId;
          return createMemorySession();
        },
      });
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'e1',
          target: { type: 'sub-agent', parentSessionId: 'parent-1', spec: {} },
        }),
      );
      expect(outcome.kind).toBe('dispatched');
      expect(createdParentId).toBe('parent-1');
      expect(calls[0]?.depth).toBe(1);
    });
  });

  describe('idempotency', () => {
    test('duplicate event id returns duplicate without re-dispatching', async () => {
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
      });
      const e = makeEvent({ id: 'same-id', target: { type: 'broadcast' } });
      await dispatcher.handle(e);
      const outcome = await dispatcher.handle(e);
      expect(outcome.kind).toBe('duplicate');
      if (outcome.kind === 'duplicate') expect(outcome.eventId).toBe('same-id');
      expect(calls).toHaveLength(0); // broadcast never calls runAgent anyway
    });

    test('different event ids sharing an idempotencyKey dedupe', async () => {
      const session = createMemorySession({ id: 'sess-1' });
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        resolveSession: () => session,
      });
      const target: EventTarget = { type: 'session', sessionId: 'sess-1', mode: 'inject' };
      await dispatcher.handle(
        makeEvent({
          id: 'evt-1',
          target,
          meta: { idempotencyKey: 'gh-delivery-abc' },
        }),
      );
      const dup = await dispatcher.handle(
        makeEvent({
          id: 'evt-2',
          target,
          meta: { idempotencyKey: 'gh-delivery-abc' },
        }),
      );
      expect(dup.kind).toBe('duplicate');
      expect(calls).toHaveLength(1);
    });

    test('distinct idempotencyKeys are not conflated', async () => {
      const session = createMemorySession({ id: 'sess-1' });
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        resolveSession: () => session,
      });
      const target: EventTarget = { type: 'session', sessionId: 'sess-1', mode: 'inject' };
      await dispatcher.handle(makeEvent({ id: 'e1', target, meta: { idempotencyKey: 'a' } }));
      await dispatcher.handle(makeEvent({ id: 'e2', target, meta: { idempotencyKey: 'b' } }));
      expect(calls).toHaveLength(2);
    });
  });

  describe('loop detection', () => {
    test('rejects events whose causedBy chain contains the same triggerId', async () => {
      const bus = createEventBus();
      const { runAgent } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
      });
      dispatcher.attach(bus);

      // Seed ancestor: triggerId "cron-daily" fired once.
      await bus.publish(
        makeEvent({
          id: 'ancestor',
          source: { type: 'cron', triggerId: 'cron-daily', schedule: '* * * * *' },
          target: { type: 'broadcast' },
        }),
      );
      await dispatcher.draining();

      // New event also tagged cron-daily and claiming causedBy: ancestor.
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'descendant',
          source: { type: 'cron', triggerId: 'cron-daily', schedule: '* * * * *' },
          target: { type: 'broadcast' },
          meta: { causedBy: 'ancestor' },
        }),
      );
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('loop');
    });

    test('allows events whose chain has a different triggerId', async () => {
      const bus = createEventBus();
      const { runAgent } = recordingRunAgent();
      const dispatcher = createEventDispatcher({ registry: makeRegistry(), runAgent });
      dispatcher.attach(bus);
      await bus.publish(
        makeEvent({
          id: 'ancestor',
          source: { type: 'cron', triggerId: 'cron-weekly', schedule: '0 0 * * 0' },
          target: { type: 'broadcast' },
        }),
      );
      await dispatcher.draining();
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'descendant',
          source: { type: 'cron', triggerId: 'cron-daily', schedule: '* * * * *' },
          target: { type: 'broadcast' },
          meta: { causedBy: 'ancestor' },
        }),
      );
      expect(outcome.kind).toBe('broadcast');
    });

    test('respects causedByDepthLimit (ancestor beyond limit is not inspected)', async () => {
      // Build a chain: grand(cron-a) -> mid(unrelated) -> me(cron-a).
      // With depthLimit=1 we only look at `mid`, miss the match on `grand`,
      // and allow.
      const bus = createEventBus();
      const { runAgent } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        causedByDepthLimit: 1,
      });
      dispatcher.attach(bus);
      await bus.publish(
        makeEvent({
          id: 'grand',
          source: { type: 'cron', triggerId: 'cron-a', schedule: '* * * * *' },
          target: { type: 'broadcast' },
        }),
      );
      await bus.publish(
        makeEvent({
          id: 'mid',
          source: { type: 'cron', triggerId: 'cron-b', schedule: '* * * * *' },
          target: { type: 'broadcast' },
          meta: { causedBy: 'grand' },
        }),
      );
      await dispatcher.draining();
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'me',
          source: { type: 'cron', triggerId: 'cron-a', schedule: '* * * * *' },
          target: { type: 'broadcast' },
          meta: { causedBy: 'mid' },
        }),
      );
      expect(outcome.kind).toBe('broadcast');
    });
  });

  describe('hooks', () => {
    test('event.before can drop an event (subscriber returns {} with no event key)', async () => {
      const hooks = createHookRegistry();
      const { runAgent, calls } = recordingRunAgent();
      hooks.on('event.before', () => ({}));
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        hookRegistry: hooks,
        resolveSession: () => createMemorySession({ id: 'sess-1' }),
      });
      const outcome = await dispatcher.handle(
        makeEvent({
          id: 'e1',
          target: { type: 'session', sessionId: 'sess-1', mode: 'inject' },
        }),
      );
      expect(outcome).toEqual({ kind: 'broadcast' });
      expect(calls).toHaveLength(0);
    });

    test('event.before can rewrite the target', async () => {
      const hooks = createHookRegistry();
      const session = createMemorySession({ id: 'real-session' });
      hooks.on('event.before', ({ event }) => ({
        event: {
          ...event,
          target: { type: 'session', sessionId: 'real-session', mode: 'inject' },
        },
      }));
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        hookRegistry: hooks,
        resolveSession: (id) => (id === 'real-session' ? session : undefined),
      });
      const outcome = await dispatcher.handle(
        makeEvent({ id: 'e1', target: { type: 'broadcast' } }),
      );
      expect(outcome).toEqual({ kind: 'dispatched', sessionId: 'real-session' });
      expect(calls).toHaveLength(1);
    });

    test('event.after fires with the resolved outcome', async () => {
      const hooks = createHookRegistry();
      const after: Array<{ id: string; outcome: string }> = [];
      hooks.on('event.after', ({ event, outcome }) => {
        after.push({ id: event.id, outcome: outcome.kind });
      });
      const { runAgent } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        hookRegistry: hooks,
      });
      await dispatcher.handle(makeEvent({ id: 'e1', target: { type: 'broadcast' } }));
      // Duplicate fires event.after as well.
      await dispatcher.handle(makeEvent({ id: 'e1', target: { type: 'broadcast' } }));
      expect(after).toEqual([
        { id: 'e1', outcome: 'broadcast' },
        { id: 'e1', outcome: 'duplicate' },
      ]);
    });
  });

  describe('per-session serialization', () => {
    test('two inject events for the same session run serially in arrival order', async () => {
      const session = createMemorySession({ id: 'sess-1' });
      const order: string[] = [];
      const runAgent: RunAgent = async (input) => {
        const text = input.userMessage;
        const match = text.match(/id="([^"]+)"/);
        const id = match?.[1] ?? '?';
        order.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, 15));
        order.push(`end:${id}`);
        return okResult();
      };
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        resolveSession: () => session,
      });

      const target: EventTarget = { type: 'session', sessionId: 'sess-1', mode: 'inject' };
      const p1 = dispatcher.handle(makeEvent({ id: 'a', target }));
      const p2 = dispatcher.handle(makeEvent({ id: 'b', target }));
      await Promise.all([p1, p2]);

      expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    });
  });

  describe('bus attachment', () => {
    test('attach wires handle() to every kind; detach stops delivery', async () => {
      const bus = createEventBus();
      const session = createMemorySession({ id: 'sess-1' });
      const { runAgent, calls } = recordingRunAgent();
      const dispatcher = createEventDispatcher({
        registry: makeRegistry(),
        runAgent,
        resolveSession: () => session,
      });
      const detach = dispatcher.attach(bus);

      await bus.publish(
        makeEvent({
          id: 'via-bus',
          target: { type: 'session', sessionId: 'sess-1', mode: 'inject' },
        }),
      );
      await dispatcher.draining();
      expect(calls).toHaveLength(1);

      detach();
      await bus.publish(
        makeEvent({
          id: 'after-detach',
          target: { type: 'session', sessionId: 'sess-1', mode: 'inject' },
        }),
      );
      await dispatcher.draining();
      expect(calls).toHaveLength(1);
    });
  });
});

describe('frameEvent', () => {
  test('emits source, id, and escaped payload', () => {
    const xml = frameEvent(
      makeEvent({
        id: 'evt-1',
        source: { type: 'webhook', triggerId: 'gh-pr' },
        target: { type: 'broadcast' },
        payload: { action: 'opened', title: 'hi & <bye>' },
      }),
    );
    expect(xml).toContain('source="webhook"');
    expect(xml).toContain('trigger="gh-pr"');
    expect(xml).toContain('id="evt-1"');
    // Payload contents are inside <payload>; `<` + `&` must be escaped there.
    expect(xml).toContain('&lt;bye&gt;');
    expect(xml).toContain('hi &amp; ');
  });

  test('emits caused-by attribute when meta.causedBy is present', () => {
    const xml = frameEvent(
      makeEvent({
        id: 'evt-2',
        target: { type: 'broadcast' },
        meta: { causedBy: 'evt-1' },
      }),
    );
    expect(xml).toContain('caused-by="evt-1"');
  });

  test('escapes attribute values containing quotes', () => {
    const xml = frameEvent(
      makeEvent({
        id: 'with"quote',
        target: { type: 'broadcast' },
      }),
    );
    expect(xml).toContain('id="with&quot;quote"');
  });
});

// SessionHandle unused import guard — asserts compilation only.
const _types: SessionHandle | null = null;
void _types;

// ── Cross-restart dedup (slice 8) ───────────────────────────────────────

function tmpDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'declaragent-dispatcher-'));
  return {
    path: join(dir, 'events.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('createEventDispatcher (cross-restart dedup)', () => {
  test('persists the event and outcome in the store', async () => {
    const db = new Database(':memory:', { create: true });
    const store = createEventStore({ db });
    const { runAgent } = recordingRunAgent();
    const dispatcher = createEventDispatcher({
      registry: makeRegistry(),
      runAgent,
      store,
    });

    const event = makeEvent({ id: 'persisted', target: { type: 'broadcast' } });
    await dispatcher.handle(event);

    const record = await store.get('persisted');
    expect(record).toBeDefined();
    expect(record?.event.id).toBe('persisted');
    expect(record?.outcome).toEqual({ kind: 'broadcast' });
    expect(record?.outcomeAt).toBeGreaterThan(0);
  });

  test('dedupes by event id across a simulated process restart', async () => {
    const { path, cleanup } = tmpDbPath();
    try {
      const dbA = new Database(path, { create: true });
      const storeA = createEventStore({ db: dbA });
      const { runAgent: runA, calls: callsA } = recordingRunAgent();
      const dispatcherA = createEventDispatcher({
        registry: makeRegistry(),
        runAgent: runA,
        store: storeA,
        resolveSession: () => createMemorySession({ id: 'sess-1' }),
      });
      const evt = makeEvent({
        id: 'restart-evt',
        target: { type: 'session', sessionId: 'sess-1', mode: 'inject' },
      });
      const first = await dispatcherA.handle(evt);
      expect(first.kind).toBe('dispatched');
      expect(callsA).toHaveLength(1);
      dbA.close();

      // Simulate restart: brand-new Database + dispatcher, empty in-memory cache.
      const dbB = new Database(path, { create: true });
      const storeB = createEventStore({ db: dbB });
      const { runAgent: runB, calls: callsB } = recordingRunAgent();
      const dispatcherB = createEventDispatcher({
        registry: makeRegistry(),
        runAgent: runB,
        store: storeB,
        resolveSession: () => createMemorySession({ id: 'sess-1' }),
      });
      const replay = await dispatcherB.handle(evt);
      expect(replay.kind).toBe('duplicate');
      if (replay.kind === 'duplicate') expect(replay.eventId).toBe('restart-evt');
      expect(callsB).toHaveLength(0);
      dbB.close();
    } finally {
      cleanup();
    }
  });

  test('dedupes by (idempotencyKey, source_type) across a restart', async () => {
    const { path, cleanup } = tmpDbPath();
    try {
      const now = Date.now();
      const dbA = new Database(path, { create: true });
      const storeA = createEventStore({ db: dbA });
      const { runAgent: runA } = recordingRunAgent();
      const dispatcherA = createEventDispatcher({
        registry: makeRegistry(),
        runAgent: runA,
        store: storeA,
        resolveSession: () => createMemorySession({ id: 'sess-1' }),
      });
      await dispatcherA.handle(
        makeEvent({
          id: 'first',
          timestamp: now,
          source: { type: 'webhook', triggerId: 'gh-pr' },
          meta: { idempotencyKey: 'delivery-xyz' },
          target: { type: 'session', sessionId: 'sess-1', mode: 'inject' },
        }),
      );
      dbA.close();

      // New process: same idempotency key on a different event id.
      const dbB = new Database(path, { create: true });
      const storeB = createEventStore({ db: dbB });
      const { runAgent: runB, calls: callsB } = recordingRunAgent();
      const dispatcherB = createEventDispatcher({
        registry: makeRegistry(),
        runAgent: runB,
        store: storeB,
        resolveSession: () => createMemorySession({ id: 'sess-1' }),
      });
      const outcome = await dispatcherB.handle(
        makeEvent({
          id: 'second',
          timestamp: now,
          source: { type: 'webhook', triggerId: 'gh-pr' },
          meta: { idempotencyKey: 'delivery-xyz' },
          target: { type: 'session', sessionId: 'sess-1', mode: 'inject' },
        }),
      );
      expect(outcome.kind).toBe('duplicate');
      expect(callsB).toHaveLength(0);
      dbB.close();
    } finally {
      cleanup();
    }
  });

  test('dedupWindowMs narrows the cross-restart dedup window', async () => {
    const db = new Database(':memory:', { create: true });
    const store = createEventStore({ db });
    const { runAgent } = recordingRunAgent();
    const dispatcher = createEventDispatcher({
      registry: makeRegistry(),
      runAgent,
      store,
      dedupWindowMs: 1000,
    });

    // Seed an aged event (2h ago) with an idempotency key.
    await store.record(
      makeEvent({
        id: 'aged',
        timestamp: Date.now() - 2 * 60 * 60 * 1000,
        source: { type: 'webhook', triggerId: 'gh' },
        meta: { idempotencyKey: 'stale' },
        target: { type: 'broadcast' },
      }),
    );
    // A fresh event reusing the key should NOT be deduped because the
    // stored row is older than 1s.
    const outcome = await dispatcher.handle(
      makeEvent({
        id: 'fresh',
        source: { type: 'webhook', triggerId: 'gh' },
        meta: { idempotencyKey: 'stale' },
        target: { type: 'broadcast' },
      }),
    );
    expect(outcome.kind).toBe('broadcast');
  });
});

describe('dispatcher circuit breakers (Slice 3 / PR 3.1)', () => {
  test('opens a per-skill breaker after N consecutive skill failures and rejects subsequent events with reason=circuit-open', async () => {
    const registry = makeRegistry();
    await registry.register(makeSkillExtension('flaky', 'say hi'));
    const calls: RunAgentInput[] = [];
    const runAgent: RunAgent = async (input) => {
      calls.push(input);
      throw new Error('provider blew up');
    };
    // Small threshold so the test is fast.
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 });
    const dispatcher = createEventDispatcher({
      registry,
      runAgent,
      createChildSession: () => createMemorySession(),
      targetBreaker: () => breaker,
    });

    // First 3 attempts fail with reason=invalid (the executeTarget catch
    // path maps thrown errors into `invalid`). Each records a failure.
    for (let i = 0; i < 3; i += 1) {
      const outcome = await dispatcher.handle(
        makeEvent({
          id: `fail-${i}`,
          target: { type: 'skill', name: 'flaky', inputs: {} },
        }),
      );
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') expect(outcome.reason).toBe('invalid');
    }
    expect(calls).toHaveLength(3);
    expect(breaker.state).toBe('open');

    // Fourth attempt: breaker is open → short-circuit to circuit-open
    // without invoking runAgent.
    const outcome = await dispatcher.handle(
      makeEvent({
        id: 'fail-4',
        target: { type: 'skill', name: 'flaky', inputs: {} },
      }),
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('circuit-open');
      expect(outcome.details).toContain('flaky');
    }
    expect(calls).toHaveLength(3); // runAgent NOT invoked again
  });

  test('breakers are per-target: one skill opening does not short-circuit siblings', async () => {
    // Use the skill prompt as the throw-vs-succeed discriminator so we
    // don't have to parse frameEvent output. 'flaky' always throws;
    // 'healthy' always succeeds.
    const registry = makeRegistry();
    await registry.register(makeSkillExtension('flaky', 'FLAKY_MARKER'));
    await registry.register(makeSkillExtension('healthy', 'HEALTHY_MARKER'));
    const runAgent: RunAgent = async (input) => {
      if (input.userMessage.includes('FLAKY_MARKER')) throw new Error('boom');
      return okResult();
    };
    const breakers = new Map<string, CircuitBreaker>();
    const getBreaker = (name: string): CircuitBreaker => {
      let b = breakers.get(name);
      if (!b) {
        b = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 30_000 });
        breakers.set(name, b);
      }
      return b;
    };
    const dispatcher = createEventDispatcher({
      registry,
      runAgent,
      createChildSession: () => createMemorySession(),
      targetBreaker: getBreaker,
    });

    // Two flaky dispatches trip the breaker.
    await dispatcher.handle(
      makeEvent({ id: 'a', target: { type: 'skill', name: 'flaky', inputs: {} } }),
    );
    await dispatcher.handle(
      makeEvent({ id: 'b', target: { type: 'skill', name: 'flaky', inputs: {} } }),
    );
    expect(breakers.get('flaky')?.state).toBe('open');

    // 'healthy' is unaffected.
    const ok = await dispatcher.handle(
      makeEvent({ id: 'c', target: { type: 'skill', name: 'healthy', inputs: {} } }),
    );
    expect(ok.kind).toBe('dispatched');
    expect(breakers.get('healthy')?.state ?? 'closed').toBe('closed');

    // The next flaky event short-circuits (no runAgent throw).
    const shortCircuit = await dispatcher.handle(
      makeEvent({ id: 'd', target: { type: 'skill', name: 'flaky', inputs: {} } }),
    );
    expect(shortCircuit.kind).toBe('rejected');
    if (shortCircuit.kind === 'rejected') expect(shortCircuit.reason).toBe('circuit-open');
  });

  test('rejected outcomes flow into the rejected_events dispatch DLQ (Slice 5 / PR 5.1)', async () => {
    const registry = makeRegistry();
    await registry.register(makeSkillExtension('boom', 'BOOM'));
    const runAgent: RunAgent = async () => {
      throw new Error('boom');
    };
    const store = createEventStore({ db: new Database(':memory:') });
    const dispatcher = createEventDispatcher({
      registry,
      runAgent,
      createChildSession: () => createMemorySession(),
      store,
    });

    // Two rejected dispatches → DLQ row with attempt_count=2.
    await dispatcher.handle(
      makeEvent({ id: 'dlq-1', target: { type: 'skill', name: 'boom', inputs: {} } }),
    );
    // Second event — different id so dedup doesn't intervene.
    await dispatcher.handle(
      makeEvent({ id: 'dlq-2', target: { type: 'skill', name: 'boom', inputs: {} } }),
    );

    const rows = await store.listRejections();
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r.eventId === 'dlq-1');
    expect(row?.rejectionReason).toBe('invalid');
    expect(row?.attemptCount).toBe(1);
  });

  test('successful dispatch after rejection clears the DLQ row', async () => {
    const registry = makeRegistry();
    await registry.register(makeSkillExtension('flaky', 'FLAKY'));
    let failMode = true;
    const runAgent: RunAgent = async () => {
      if (failMode) throw new Error('boom');
      return okResult();
    };
    const store = createEventStore({ db: new Database(':memory:') });
    const dispatcher = createEventDispatcher({
      registry,
      runAgent,
      createChildSession: () => createMemorySession(),
      store,
    });
    await dispatcher.handle(
      makeEvent({ id: 'r1', target: { type: 'skill', name: 'flaky', inputs: {} } }),
    );
    expect((await store.listRejections()).length).toBe(1);

    // Healed: a new event for the same skill dispatches successfully.
    // Different event id because the original is already dedup-locked.
    failMode = false;
    await dispatcher.handle(
      makeEvent({ id: 'r2', target: { type: 'skill', name: 'flaky', inputs: {} } }),
    );
    // The DLQ row for the healed event's id should be gone; the
    // still-rejected older event remains in the DLQ until a requeue.
    expect(await store.getRejection('r2')).toBeUndefined();
    expect(await store.getRejection('r1')).toBeDefined();
  });

  test('breaker closes after a successful probe in half-open state', async () => {
    const registry = makeRegistry();
    await registry.register(makeSkillExtension('recover', 'RECOVER'));
    let failMode = true;
    const runAgent: RunAgent = async () => {
      if (failMode) throw new Error('boom');
      return okResult();
    };
    let clock = 1_000_000;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 5_000,
      now: () => clock,
    });
    const dispatcher = createEventDispatcher({
      registry,
      runAgent,
      createChildSession: () => createMemorySession(),
      targetBreaker: () => breaker,
    });

    // Trip the breaker.
    await dispatcher.handle(
      makeEvent({ id: 'f1', target: { type: 'skill', name: 'recover', inputs: {} } }),
    );
    await dispatcher.handle(
      makeEvent({ id: 'f2', target: { type: 'skill', name: 'recover', inputs: {} } }),
    );
    expect(breaker.state).toBe('open');

    // Healed service — advance the clock past the cooldown and fire a
    // probe. The probe runs (half-open allows), succeeds, breaker closes.
    failMode = false;
    clock += 6_000;
    const probe = await dispatcher.handle(
      makeEvent({ id: 'probe', target: { type: 'skill', name: 'recover', inputs: {} } }),
    );
    expect(probe.kind).toBe('dispatched');
    expect(breaker.state).toBe('closed');
  });
});

describe('dispatcher rate limits (slice 14)', () => {
  test('rejects with kind=rejected + reason=rate-limit when the bucket is exhausted', async () => {
    const bus = createEventBus();
    const { runAgent } = recordingRunAgent();
    const dispatcher = createEventDispatcher({
      registry: makeRegistry(),
      runAgent,
      logger: NOOP_LOGGER,
      rateLimits: {
        byTarget: [{ target: 'broadcast', ratePerSec: 2, burst: 2 }],
      },
    });
    dispatcher.attach(bus);

    const o1 = await dispatcher.handle(makeEvent({ id: 'e1', target: { type: 'broadcast' } }));
    const o2 = await dispatcher.handle(makeEvent({ id: 'e2', target: { type: 'broadcast' } }));
    const o3 = await dispatcher.handle(makeEvent({ id: 'e3', target: { type: 'broadcast' } }));

    expect(o1.kind).toBe('broadcast');
    expect(o2.kind).toBe('broadcast');
    expect(o3.kind).toBe('rejected');
    if (o3.kind === 'rejected') {
      expect(o3.reason).toBe('rate-limit');
      expect(o3.details).toContain('broadcast');
    }
  });

  test('does not spin up an agent turn for a rate-limited session target', async () => {
    const bus = createEventBus();
    const session = createMemorySession({ id: 's1' });
    const { runAgent, calls } = recordingRunAgent();
    const dispatcher = createEventDispatcher({
      registry: makeRegistry(),
      runAgent,
      logger: NOOP_LOGGER,
      rateLimits: {
        byTarget: [{ target: 'session', id: 's1', ratePerSec: 1, burst: 1 }],
      },
      resolveSession: (id) => (id === session.id ? (session as SessionHandle) : undefined),
    });
    dispatcher.attach(bus);

    const first = await dispatcher.handle(
      makeEvent({ id: 'e1', target: { type: 'session', sessionId: 's1', mode: 'inject' } }),
    );
    const second = await dispatcher.handle(
      makeEvent({ id: 'e2', target: { type: 'session', sessionId: 's1', mode: 'inject' } }),
    );
    expect(first.kind).toBe('dispatched');
    expect(second.kind).toBe('rejected');
    // Only the first call reached `runAgent`.
    expect(calls).toHaveLength(1);
  });

  test('unrelated targets keep their own bucket', async () => {
    const bus = createEventBus();
    const { runAgent } = recordingRunAgent();
    const dispatcher = createEventDispatcher({
      registry: makeRegistry(),
      runAgent,
      logger: NOOP_LOGGER,
      rateLimits: {
        byTarget: [{ target: 'broadcast', ratePerSec: 1, burst: 1 }],
      },
    });
    dispatcher.attach(bus);
    // Exhaust the broadcast bucket.
    const okB = await dispatcher.handle(makeEvent({ id: 'b1', target: { type: 'broadcast' } }));
    const denyB = await dispatcher.handle(makeEvent({ id: 'b2', target: { type: 'broadcast' } }));
    expect(okB.kind).toBe('broadcast');
    expect(denyB.kind).toBe('rejected');
    // A session target should be unaffected because its type isn't in the rule set.
    const session = createMemorySession({ id: 's1' });
    const d2 = createEventDispatcher({
      registry: makeRegistry(),
      runAgent,
      logger: NOOP_LOGGER,
      rateLimits: {
        byTarget: [{ target: 'broadcast', ratePerSec: 1, burst: 1 }],
      },
      resolveSession: (id) => (id === session.id ? (session as SessionHandle) : undefined),
    });
    d2.attach(createEventBus());
    const s1 = await d2.handle(
      makeEvent({ id: 's1-ev', target: { type: 'session', sessionId: 's1', mode: 'inject' } }),
    );
    expect(s1.kind).toBe('dispatched');
  });

  test('dedup runs before the rate-limit check (duplicates do not spend tokens)', async () => {
    // Bucket of 2. If dedup ran AFTER rate-limit, the duplicate would
    // spend a token and the fresh third call would be rejected. Since
    // dedup runs first, only the 2 non-duplicate calls spend tokens.
    const bus = createEventBus();
    const { runAgent } = recordingRunAgent();
    const dispatcher = createEventDispatcher({
      registry: makeRegistry(),
      runAgent,
      logger: NOOP_LOGGER,
      rateLimits: {
        byTarget: [{ target: 'broadcast', ratePerSec: 2, burst: 2 }],
      },
    });
    dispatcher.attach(bus);
    const evt = makeEvent({
      id: 'dup-event',
      meta: { idempotencyKey: 'k' },
      source: { type: 'webhook', triggerId: 'gh' },
      target: { type: 'broadcast' },
    });
    const o1 = await dispatcher.handle(evt);
    const o2 = await dispatcher.handle(evt); // duplicate — no token spent
    const o3 = await dispatcher.handle(makeEvent({ id: 'fresh', target: { type: 'broadcast' } }));
    expect(o1.kind).toBe('broadcast');
    expect(o2.kind).toBe('duplicate');
    expect(o3.kind).toBe('broadcast'); // second real call — still under burst=2
  });
});

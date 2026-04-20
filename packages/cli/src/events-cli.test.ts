import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { AgentEvent, EventStore } from '@declaragent/core';
import { createEventStore } from '@declaragent/core';
import { eventsList, eventsShow } from './events-cli.js';

function makeStore(): EventStore {
  const db = new Database(':memory:', { create: true });
  return createEventStore({ db });
}

function captureIO(): {
  out: string[];
  err: string[];
  io: { out: (s: string) => void; err: (s: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
  };
}

const SAMPLE_EVENT: AgentEvent = {
  id: 'evt-a',
  kind: 'webhook.received',
  source: { type: 'webhook', triggerId: 'gh-pr' },
  target: { type: 'broadcast' },
  timestamp: Date.parse('2026-04-16T10:00:00Z'),
  payload: { action: 'opened' },
  auth: { kind: 'hmac', signatureHash: 'abc' },
  meta: { correlationId: 'run-1' },
};

describe('eventsList', () => {
  test('prints "no events" when store is empty', async () => {
    const store = makeStore();
    const { out, io } = captureIO();
    const code = await eventsList({}, { store, io });
    expect(code).toBe(0);
    expect(out.join('')).toContain('no events');
  });

  test('lists events with source + outcome columns', async () => {
    const store = makeStore();
    await store.record(SAMPLE_EVENT);
    await store.markOutcome('evt-a', { kind: 'broadcast' });

    const { out, io } = captureIO();
    const code = await eventsList({}, { store, io });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('events (1)');
    expect(text).toContain('webhook.received');
    expect(text).toContain('webhook:gh-pr');
    expect(text).toContain('broadcast');
    expect(text).toContain('evt-a');
  });

  test('applies the kind filter', async () => {
    const store = makeStore();
    await store.record(SAMPLE_EVENT);
    await store.record({
      ...SAMPLE_EVENT,
      id: 'evt-b',
      kind: 'trigger.fire',
      source: { type: 'cron', triggerId: 'daily', schedule: '0 9 * * *' },
    });
    const { out, io } = captureIO();
    const code = await eventsList({ kind: 'trigger.fire' }, { store, io });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('evt-b');
    expect(text).not.toContain('evt-a');
  });

  test('applies the correlation filter', async () => {
    const store = makeStore();
    await store.record(SAMPLE_EVENT);
    await store.record({
      ...SAMPLE_EVENT,
      id: 'evt-b',
      meta: { correlationId: 'run-2' },
    });
    const { out, io } = captureIO();
    const code = await eventsList({ correlation: 'run-1' }, { store, io });
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('evt-a');
    expect(text).not.toContain('evt-b');
  });
});

describe('eventsShow', () => {
  test('prints full JSON for an existing event', async () => {
    const store = makeStore();
    await store.record(SAMPLE_EVENT);
    const { out, io } = captureIO();
    const code = await eventsShow('evt-a', { store, io });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.event.id).toBe('evt-a');
    expect(parsed.event.payload).toEqual({ action: 'opened' });
  });

  test('returns exit 1 + error message when missing', async () => {
    const store = makeStore();
    const { err, io } = captureIO();
    const code = await eventsShow('nope', { store, io });
    expect(code).toBe(1);
    expect(err.join('')).toContain('not found');
  });
});

describe('eventsReplay', () => {
  test('errors when the daemon socket is absent', async () => {
    const store = makeStore();
    await store.record(SAMPLE_EVENT);
    const { err, io } = captureIO();
    const { eventsReplay } = await import('./events-cli.js');
    const code = await eventsReplay('evt-a', {
      store,
      io,
      socketPath: '/tmp/declaragent-does-not-exist.sock',
    });
    expect(code).toBe(1);
    expect(err.join('')).toContain('daemon not running');
  });

  test('errors when the event is missing', async () => {
    const store = makeStore();
    const { err, io } = captureIO();
    const { eventsReplay } = await import('./events-cli.js');
    const code = await eventsReplay('nope', { store, io });
    expect(code).toBe(1);
    expect(err.join('')).toContain('not found');
  });
});

describe('eventsReplayRange', () => {
  test('errors when the daemon socket is absent', async () => {
    const { err, io } = captureIO();
    const { eventsReplayRange } = await import('./events-cli.js');
    const code = await eventsReplayRange(
      { source: 'x', from: 0 },
      { io, socketPath: '/tmp/declaragent-does-not-exist.sock' },
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('daemon not running');
  });
});

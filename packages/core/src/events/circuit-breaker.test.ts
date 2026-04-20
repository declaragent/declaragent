import { describe, expect, test } from 'bun:test';
import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  test('starts closed and allows calls', () => {
    const b = new CircuitBreaker();
    expect(b.state).toBe('closed');
    expect(b.allow()).toBe(true);
  });

  test('opens after the failure threshold of consecutive failures', () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.record(false);
    b.record(false);
    expect(b.state).toBe('closed');
    b.record(false);
    expect(b.state).toBe('open');
    expect(b.allow()).toBe(false);
  });

  test('a single success in closed state resets the failure counter', () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.record(false);
    b.record(false);
    b.record(true);
    b.record(false);
    b.record(false);
    expect(b.state).toBe('closed'); // would have opened without the intervening success
  });

  test('flips open → half-open after resetTimeoutMs elapses', () => {
    let t = 0;
    const b = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 100,
      now: () => t,
    });
    b.record(false);
    b.record(false);
    expect(b.state).toBe('open');
    t = 50;
    expect(b.state).toBe('open'); // not yet
    t = 100;
    expect(b.state).toBe('half-open');
    expect(b.allow()).toBe(true);
  });

  test('half-open success (above threshold) closes the breaker', () => {
    let t = 0;
    const b = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      resetTimeoutMs: 100,
      now: () => t,
    });
    b.record(false);
    expect(b.state).toBe('open');
    t = 100;
    expect(b.state).toBe('half-open');
    b.record(true);
    expect(b.state).toBe('half-open'); // needs 2
    b.record(true);
    expect(b.state).toBe('closed');
  });

  test('half-open failure reopens the breaker + restarts cool-down', () => {
    let t = 0;
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      now: () => t,
    });
    b.record(false);
    t = 100;
    expect(b.state).toBe('half-open');
    b.record(false);
    expect(b.state).toBe('open');
    // Cool-down restarts from the reopen moment.
    t = 150;
    expect(b.state).toBe('open');
    t = 200;
    expect(b.state).toBe('half-open');
  });

  test('trip() forces open; reset() forces closed', () => {
    const b = new CircuitBreaker();
    expect(b.state).toBe('closed');
    b.trip();
    expect(b.state).toBe('open');
    b.reset();
    expect(b.state).toBe('closed');
  });

  test('onTransition fires on state changes with from/to/at', () => {
    let t = 0;
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 10,
      now: () => t,
    });
    const transitions: Array<{ from: string; to: string; at: number }> = [];
    b.onTransition((e) => transitions.push({ from: e.from, to: e.to, at: e.at }));

    b.record(false); // closed → open
    t = 10;
    expect(b.state).toBe('half-open'); // open → half-open (read-side lazy transition)
    b.record(true); // half-open → closed

    expect(transitions).toEqual([
      { from: 'closed', to: 'open', at: 0 },
      { from: 'open', to: 'half-open', at: 10 },
      { from: 'half-open', to: 'closed', at: 10 },
    ]);
  });

  test('listener exceptions do not break the breaker', () => {
    const b = new CircuitBreaker({ failureThreshold: 1 });
    b.onTransition(() => {
      throw new Error('kaboom');
    });
    // Should not throw.
    b.record(false);
    expect(b.state).toBe('open');
  });

  test('run() executes successful calls and records success', async () => {
    const b = new CircuitBreaker({ failureThreshold: 2 });
    const out = await b.run(async () => 42);
    expect(out).toBe(42);
    expect(b.state).toBe('closed');
  });

  test('run() records failures and eventually opens', async () => {
    const b = new CircuitBreaker({ failureThreshold: 2 });
    for (let i = 0; i < 2; i++) {
      try {
        await b.run(async () => {
          throw new Error('fail');
        });
      } catch {
        // expected
      }
    }
    expect(b.state).toBe('open');
  });

  test('run() rejects when state is open', async () => {
    const b = new CircuitBreaker({ failureThreshold: 1 });
    b.record(false);
    expect(b.state).toBe('open');
    await expect(b.run(async () => 1)).rejects.toThrow(/circuit-breaker/);
  });
});

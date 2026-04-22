import { describe, expect, test } from 'bun:test';
import type { LLMProvider, LLMRequest, LLMResponse } from '../types/llm.js';
import type { Message } from '../types/messages.js';
import {
  DEFAULT_PROVIDER_RATE_PER_SEC,
  ProviderTokenBucket,
  defaultRateForProvider,
  withProviderRateLimit,
} from './rate-limit.js';

function makeFakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeFakeSleep(clock: { advance: (ms: number) => void }): {
  sleep: (ms: number) => Promise<void>;
  waits: number[];
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock.advance(ms);
    },
  };
}

function fakeProvider(impl?: Partial<LLMProvider>): LLMProvider & { completeCalls: LLMRequest[] } {
  const completeCalls: LLMRequest[] = [];
  const base: LLMProvider = {
    name: 'fake',
    async countTokens(_msgs: Message[]) {
      return 0;
    },
    async complete(request: LLMRequest): Promise<LLMResponse> {
      completeCalls.push(request);
      return {
        content: [{ type: 'text', text: 'ok' }],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end_turn',
        model: 'fake',
      };
    },
  };
  return Object.assign(base, impl ?? {}, { completeCalls });
}

function simpleRequest(): LLMRequest {
  return {
    model: 'fake',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 1,
  };
}

describe('TokenBucket', () => {
  test('takes without waiting when burst is available', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const bucket = new ProviderTokenBucket({
      ratePerSec: 10,
      burst: 5,
      now: clock.now,
      sleep: sleep.sleep,
    });
    for (let i = 0; i < 5; i += 1) {
      expect(await bucket.take()).toBe(0);
    }
    expect(sleep.waits).toHaveLength(0);
  });

  test('waits to refill when the bucket is empty', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const bucket = new ProviderTokenBucket({
      ratePerSec: 10,
      burst: 1,
      now: clock.now,
      sleep: sleep.sleep,
    });
    // First take consumes the burst.
    expect(await bucket.take()).toBe(0);
    // Second take waits ~100ms (1 token / 10 tokens/sec).
    const waited = await bucket.take();
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(100);
    expect(sleep.waits).toHaveLength(1);
  });

  test('respects the burst cap even after a long idle period', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const bucket = new ProviderTokenBucket({
      ratePerSec: 10,
      burst: 3,
      now: clock.now,
      sleep: sleep.sleep,
    });
    // Drain the initial burst.
    for (let i = 0; i < 3; i += 1) await bucket.take();
    // Idle for 10s — would refill 100 tokens without a cap, but the
    // cap is 3 so we only get 3 free takes back.
    clock.advance(10_000);
    for (let i = 0; i < 3; i += 1) expect(await bucket.take()).toBe(0);
    expect(sleep.waits).toHaveLength(0);
    // The 4th take must wait.
    const waited = await bucket.take();
    expect(waited).toBeGreaterThan(0);
  });

  test('throws when ratePerSec is zero or negative', () => {
    expect(() => new ProviderTokenBucket({ ratePerSec: 0 })).toThrow('ratePerSec');
    expect(() => new ProviderTokenBucket({ ratePerSec: -5 })).toThrow('ratePerSec');
  });
});

describe('withProviderRateLimit', () => {
  test('passes complete() calls through when capacity is available', async () => {
    const provider = fakeProvider();
    const wrapped = withProviderRateLimit(provider, { ratePerSec: 100, burst: 5 });
    for (let i = 0; i < 3; i += 1) {
      const res = await wrapped.complete(simpleRequest(), new AbortController().signal);
      expect(res.content[0]?.type).toBe('text');
    }
    expect(provider.completeCalls).toHaveLength(3);
  });

  test('fires onWait when the bucket empties and calls queue', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const provider = fakeProvider();
    const waitEvents: number[] = [];
    const wrapped = withProviderRateLimit(provider, {
      ratePerSec: 10,
      burst: 1,
      now: clock.now,
      sleep: sleep.sleep,
      onWait: (ms) => waitEvents.push(ms),
    });
    const req = simpleRequest();
    // First call consumes the burst without waiting.
    await wrapped.complete(req, new AbortController().signal);
    expect(waitEvents).toHaveLength(0);
    // Second call must wait → onWait fires with the wait duration.
    await wrapped.complete(req, new AbortController().signal);
    expect(waitEvents).toHaveLength(1);
    expect(waitEvents[0] ?? 0).toBeGreaterThan(0);
  });

  test('forwards provider.name + countTokens unchanged', async () => {
    const provider = fakeProvider({ name: 'anthropic' });
    const wrapped = withProviderRateLimit(provider, { ratePerSec: 50 });
    expect(wrapped.name).toBe('anthropic');
    expect(await wrapped.countTokens([])).toBe(0);
  });

  test('swallows onWait hook errors so limiting never corrupts the call path', async () => {
    const clock = makeFakeClock();
    const sleep = makeFakeSleep(clock);
    const provider = fakeProvider();
    const wrapped = withProviderRateLimit(provider, {
      ratePerSec: 10,
      burst: 1,
      now: clock.now,
      sleep: sleep.sleep,
      onWait: () => {
        throw new Error('hook blew up');
      },
    });
    const req = simpleRequest();
    await wrapped.complete(req, new AbortController().signal);
    // Second call waits → hook throws → wrapper swallows → call completes.
    const res = await wrapped.complete(req, new AbortController().signal);
    expect(res.content[0]?.type).toBe('text');
  });
});

describe('defaultRateForProvider', () => {
  test('returns curated defaults for known providers', () => {
    expect(defaultRateForProvider('anthropic')).toBe(DEFAULT_PROVIDER_RATE_PER_SEC.anthropic ?? -1);
    expect(defaultRateForProvider('openrouter')).toBe(
      DEFAULT_PROVIDER_RATE_PER_SEC.openrouter ?? -1,
    );
  });

  test('falls back to 10 rps for unknown providers', () => {
    expect(defaultRateForProvider('mystery-vendor')).toBe(10);
  });
});

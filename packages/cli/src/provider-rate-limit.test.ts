import { describe, expect, test } from 'bun:test';
import type { LLMProvider, LLMResponse } from '@declaragent/core';
import { wrapProviderWithRateLimit } from './provider-rate-limit.js';

function fakeProvider(): LLMProvider {
  return {
    name: 'fake',
    complete: async (): Promise<LLMResponse> => ({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm',
    }),
    countTokens: async () => 0,
  };
}

function captureIo(): {
  io: { out: (s: string) => void; err: (s: string) => void };
  lines: string[];
} {
  const lines: string[] = [];
  return { io: { out: (s) => lines.push(s), err: (s) => lines.push(s) }, lines };
}

describe('wrapProviderWithRateLimit (shared by up + fleet run)', () => {
  test('wraps with the provider preset default and announces the rate', () => {
    const { io, lines } = captureIo();
    const inner = fakeProvider();
    const wrapped = wrapProviderWithRateLimit({
      provider: inner,
      providerId: 'anthropic',
      io,
      env: {},
    });
    expect(wrapped).not.toBe(inner);
    expect(lines.join('')).toContain('rate-limit: 50 rps (provider=anthropic');
  });

  test('DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE=1 returns the bare provider', () => {
    const { io, lines } = captureIo();
    const inner = fakeProvider();
    const wrapped = wrapProviderWithRateLimit({
      provider: inner,
      providerId: 'anthropic',
      io,
      env: { DECLARAGENT_PROVIDER_RATE_LIMIT_DISABLE: '1' },
    });
    expect(wrapped).toBe(inner);
    expect(lines.join('')).toContain('rate-limit: disabled');
  });

  test('DECLARAGENT_PROVIDER_RATE_LIMIT_RPS overrides the default; junk falls back with a warning', () => {
    const { io, lines } = captureIo();
    wrapProviderWithRateLimit({
      provider: fakeProvider(),
      providerId: 'openrouter',
      io,
      env: { DECLARAGENT_PROVIDER_RATE_LIMIT_RPS: '3.5' },
    });
    expect(lines.join('')).toContain('rate-limit: 3.5 rps');

    const junk = captureIo();
    wrapProviderWithRateLimit({
      provider: fakeProvider(),
      providerId: 'openrouter',
      io: junk.io,
      env: { DECLARAGENT_PROVIDER_RATE_LIMIT_RPS: 'nope' },
    });
    expect(junk.lines.join('')).toContain('is not a positive number');
    expect(junk.lines.join('')).toContain('rate-limit: 20 rps');
  });

  test('unknown provider ids get the 10 rps fallback', () => {
    const { io, lines } = captureIo();
    wrapProviderWithRateLimit({ provider: fakeProvider(), providerId: 'mystery', io, env: {} });
    expect(lines.join('')).toContain('rate-limit: 10 rps');
  });
});

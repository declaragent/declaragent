import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchOpenRouterModels,
  filterAnthropicCompatible,
  summarizeModel,
} from './openrouter-models.js';

const SAMPLE = {
  data: [
    {
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Claude 3.5 Sonnet',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
    },
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      context_length: 128000,
      pricing: { prompt: '0.0000025', completion: '0.00001' },
    },
    {
      id: 'google/gemini-2.0-flash-exp',
      name: 'Gemini 2.0 Flash',
      context_length: 1048576,
    },
  ],
};

describe('filterAnthropicCompatible', () => {
  test('keeps only anthropic/* models', () => {
    const out = filterAnthropicCompatible(SAMPLE.data);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('anthropic/claude-3.5-sonnet');
  });
});

describe('summarizeModel', () => {
  test('formats context length and prompt price', () => {
    const anthropicSample = SAMPLE.data[0];
    if (!anthropicSample) throw new Error('fixture missing');
    const s = summarizeModel(anthropicSample);
    expect(s).toContain('200K ctx');
    expect(s).toContain('$3.00/M in');
  });

  test('omits price when missing', () => {
    const geminiSample = SAMPLE.data[2];
    if (!geminiSample) throw new Error('fixture missing');
    const s = summarizeModel(geminiSample);
    expect(s).toContain('1049K ctx');
    expect(s).not.toContain('/M in');
  });
});

describe('fetchOpenRouterModels', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'declaragent-orm-'));
    cachePath = join(dir, 'cache.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('fetches live when cache is absent and writes cache', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify(SAMPLE), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchOpenRouterModels({
      cachePath,
      fetchImpl: fakeFetch,
    });
    expect(result.source).toBe('live');
    expect(result.models).toHaveLength(3);
    const onDisk = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(onDisk.models).toHaveLength(3);
    expect(typeof onDisk.fetchedAt).toBe('number');
  });

  test('serves from cache when within TTL', async () => {
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), models: SAMPLE.data }));
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchOpenRouterModels({
      cachePath,
      fetchImpl: fakeFetch,
    });
    expect(result.source).toBe('cache');
    expect(called).toBe(false);
  });

  test('refetches when cache is stale', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
        models: [{ id: 'anthropic/old' }],
      }),
    );
    const fakeFetch = (async () =>
      new Response(JSON.stringify(SAMPLE), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchOpenRouterModels({
      cachePath,
      fetchImpl: fakeFetch,
    });
    expect(result.source).toBe('live');
    expect(result.models).toHaveLength(3);
  });

  test('force bypasses cache', async () => {
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), models: [{ id: 'old' }] }));
    const fakeFetch = (async () =>
      new Response(JSON.stringify(SAMPLE), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchOpenRouterModels({
      cachePath,
      fetchImpl: fakeFetch,
      force: true,
    });
    expect(result.source).toBe('live');
    expect(result.models).toHaveLength(3);
  });

  test('falls back to stale cache on fetch failure', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
        models: [{ id: 'anthropic/old-stashed' }],
      }),
    );
    const fakeFetch = (async () =>
      new Response('server down', { status: 503 })) as unknown as typeof fetch;
    const result = await fetchOpenRouterModels({
      cachePath,
      fetchImpl: fakeFetch,
    });
    expect(result.source).toBe('stale-fallback');
    expect(result.models[0]?.id).toBe('anthropic/old-stashed');
  });

  test('throws when fetch fails and no cache exists', async () => {
    const fakeFetch = (async () =>
      new Response('down', { status: 500 })) as unknown as typeof fetch;
    await expect(fetchOpenRouterModels({ cachePath, fetchImpl: fakeFetch })).rejects.toThrow(/500/);
  });
});

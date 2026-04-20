import { describe, expect, it } from 'bun:test';
import { createTtlCache } from './ttl-cache.js';

describe('createTtlCache', () => {
  it('returns undefined for missing keys', () => {
    const c = createTtlCache<string>({ defaultTtlMs: 1000 });
    expect(c.get('missing')).toBeUndefined();
  });

  it('caches a value within the TTL window', () => {
    let time = 0;
    const c = createTtlCache<string>({ defaultTtlMs: 1000, now: () => time });
    c.set('k', 'v');
    time = 500;
    expect(c.get('k')).toBe('v');
  });

  it('evicts after the TTL window', () => {
    let time = 0;
    const evicted: Array<[string, string]> = [];
    const c = createTtlCache<string>({
      defaultTtlMs: 1000,
      now: () => time,
      onEvict: (k, v) => evicted.push([k, v]),
    });
    c.set('k', 'v');
    time = 2000;
    expect(c.get('k')).toBeUndefined();
    expect(evicted).toEqual([['k', 'v']]);
    expect(c.size).toBe(0);
  });

  it('honors a per-entry ttl override', () => {
    let time = 0;
    const c = createTtlCache<string>({ defaultTtlMs: 10_000, now: () => time });
    c.set('k', 'v', 100);
    time = 200;
    expect(c.get('k')).toBeUndefined();
  });

  it('treats ttl <= 0 as "do not cache"', () => {
    const c = createTtlCache<string>({ defaultTtlMs: 1000 });
    c.set('k', 'v', 0);
    expect(c.get('k')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('delete + clear fire onEvict', () => {
    const evicted: string[] = [];
    const c = createTtlCache<string>({
      defaultTtlMs: 1000,
      onEvict: (k) => evicted.push(k),
    });
    c.set('a', '1');
    c.set('b', '2');
    c.delete('a');
    c.clear();
    expect(evicted).toEqual(['a', 'b']);
  });
});

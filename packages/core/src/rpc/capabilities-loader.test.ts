import { describe, expect, test } from 'bun:test';
import { CapabilitiesConfigError, parseCapabilitiesConfig } from './capabilities-loader.js';

describe('parseCapabilitiesConfig', () => {
  test('accepts a minimal valid config', () => {
    const loaded = parseCapabilitiesConfig({
      version: 1,
      agent: 'agent://pr-reviewer',
      transports: [
        {
          kind: 'kafka',
          brokers: ['kafka.internal:9092'],
          topics: { requests: 'agents.pr-reviewer.requests' },
        },
      ],
      capabilities: [{ name: 'review-pr', timeoutMs: 60000, idempotent: true }],
    });
    expect(loaded.config.agent).toBe('agent://pr-reviewer');
    expect(loaded.byName.get('review-pr')?.name).toBe('review-pr');
  });

  test('rejects duplicate capability names', () => {
    expect(() =>
      parseCapabilitiesConfig({
        version: 1,
        agent: 'agent://x',
        transports: [
          {
            kind: 'memory',
            topics: { requests: 'agents.x.requests' },
          },
        ],
        capabilities: [{ name: 'foo' }, { name: 'foo' }],
      }),
    ).toThrow();
  });

  test('rejects agent without agent:// scheme', () => {
    expect(() =>
      parseCapabilitiesConfig({
        version: 1,
        agent: 'pr-reviewer',
        transports: [
          {
            kind: 'memory',
            topics: { requests: 'agents.x.requests' },
          },
        ],
        capabilities: [{ name: 'foo' }],
      }),
    ).toThrow(CapabilitiesConfigError);
  });

  test('rejects empty transports', () => {
    expect(() =>
      parseCapabilitiesConfig({
        version: 1,
        agent: 'agent://x',
        transports: [],
        capabilities: [{ name: 'foo' }],
      }),
    ).toThrow(CapabilitiesConfigError);
  });

  test('accepts multiple transport kinds', () => {
    const loaded = parseCapabilitiesConfig({
      version: 1,
      agent: 'agent://multi',
      transports: [
        {
          kind: 'kafka',
          brokers: ['k:9092'],
          topics: { requests: 'agents.multi.requests' },
        },
        {
          kind: 'nats',
          servers: ['nats://n:4222'],
          subjects: { requests: 'agents.multi.requests' },
        },
      ],
      capabilities: [{ name: 'foo' }],
    });
    expect(loaded.config.transports).toHaveLength(2);
  });
});

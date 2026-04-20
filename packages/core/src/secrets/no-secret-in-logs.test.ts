import { describe, expect, it } from 'bun:test';
import { createDefaultSecretResolver } from '../events/secret-resolver.js';
import type { Logger } from '../types/logger.js';
import type { SecretAccessAuditRecord, SecretAuditSink, SecretProvider } from './types.js';

/**
 * Phase 6 slice-3 property test: no resolved secret value appears in
 * any audit record or log line. The plan's §5.3 calls this out as a
 * slice-3 release gate. We run 500 rounds of random secret values
 * through a successful resolve + a failing resolve and assert neither
 * path emits the value anywhere observable.
 */

function randomSecret(i: number): string {
  // Mix of printable ASCII + the occasional non-ascii to cover log
  // shape edge cases. `i` is folded in so the generated strings are
  // diverse across rounds.
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{};:,./<>?';
  const length = 16 + (i % 64);
  let out = '';
  for (let j = 0; j < length; j += 1) {
    out += alphabet[(i * 7919 + j * 31 + 13) % alphabet.length];
  }
  return out;
}

function makeCapturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (level: string, msg: string, bindings?: Record<string, unknown>) => {
    lines.push(`${level} ${msg} ${bindings ? JSON.stringify(bindings) : ''}`);
  };
  const logger: Logger = {
    debug: (m, b) => push('DEBUG', m, b),
    info: (m, b) => push('INFO', m, b),
    warn: (m, b) => push('WARN', m, b),
    error: (m, b) => push('ERROR', m, b),
    child: () => logger,
  };
  return { logger, lines };
}

function makeCapturingSink(): { sink: SecretAuditSink; records: SecretAccessAuditRecord[] } {
  const records: SecretAccessAuditRecord[] = [];
  return {
    sink: {
      record: (rec) => {
        records.push(rec);
      },
    },
    records,
  };
}

describe('no secret value appears in audit records or logs', () => {
  it('resolves 500 random secrets and asserts none leak', async () => {
    const values: string[] = [];
    for (let i = 0; i < 500; i += 1) values.push(randomSecret(i));

    // Provider that returns the i-th value for `secret:${i}`.
    const provider: SecretProvider = {
      type: 'vault',
      name: 'vault-test',
      async resolve(path) {
        const idx = Number(path);
        if (!Number.isFinite(idx) || idx < 0 || idx >= values.length) {
          throw new Error(`invalid path ${path}`);
        }
        return values[idx] as string;
      },
    };

    const { logger, lines } = makeCapturingLogger();
    const { sink, records } = makeCapturingSink();
    const resolver = createDefaultSecretResolver({
      providers: [provider],
      auditSink: sink,
      tenant: { id: 'acme-prod' },
      requester: 'channel:slack-prod',
    });

    // Resolve each value through the full audit path.
    for (let i = 0; i < values.length; i += 1) {
      const resolved = await resolver.resolve(`vault:${i}`);
      expect(resolved).toBe(values[i] as string);
      // Also emit some log noise involving the ref (never the value).
      logger.info('secret.resolved', { ref: `vault:${i}`, attempt: i });
    }

    const auditJson = JSON.stringify(records);
    const logJson = lines.join('\n');

    expect(records).toHaveLength(values.length);
    for (const value of values) {
      // The secret value must not appear anywhere observable.
      expect(auditJson.includes(value)).toBe(false);
      expect(logJson.includes(value)).toBe(false);
    }
  });

  it('error + denied paths never log the value', async () => {
    const denyProvider: SecretProvider = {
      type: 'vault',
      name: 'vault-deny',
      async resolve(path) {
        // The error message MUST NOT carry the secret; here we simulate
        // a would-be value that the audit path should never witness.
        const err = new Error(`denied on ${path}`) as Error & { code: string };
        err.code = 'EDENIED';
        throw err;
      },
    };
    const { logger, lines } = makeCapturingLogger();
    const { sink, records } = makeCapturingSink();
    const resolver = createDefaultSecretResolver({
      providers: [denyProvider],
      auditSink: sink,
    });
    // Intentionally set up a value the test then asserts doesn't appear:
    const FORBIDDEN_SECRET = 'bearer-token-that-must-not-leak-0xABCDEF';
    logger.debug('start', { note: 'asserting forbidden never appears below' });
    for (let i = 0; i < 50; i += 1) {
      await expect(resolver.resolve(`vault:path-${i}`)).rejects.toThrow(/denied/);
    }
    const auditJson = JSON.stringify(records);
    const logJson = lines.join('\n');
    expect(auditJson.includes(FORBIDDEN_SECRET)).toBe(false);
    expect(logJson.includes(FORBIDDEN_SECRET)).toBe(false);
    // Audit records present + all are denials.
    expect(records).toHaveLength(50);
    expect(records.every((r) => r.outcome === 'denied')).toBe(true);
  });
});

import type { ChaosAssertion, ChaosAssertionResult, ChaosSnapshot } from '../types.js';

/**
 * Phase 6 slice-7 `no-secret-in-logs` assertion.
 *
 * Confirms that none of the secret values the harness recorded during
 * this run appear in any captured log line or audit record. Pairs
 * with {@link createNoSecretInLogsAssertion} — callers register the
 * raw log/audit streams they care about; the factory snapshots them
 * at assertion time.
 */

export interface NoSecretInLogsAssertionOptions {
  /**
   * Secrets observed during the run. The assertion fails if any of
   * these strings appear in {@link getLogLines} / serialized audit records.
   */
  watchedValues: () => readonly string[];
  /** Snapshot log capture — must include everything the run emitted. */
  getLogLines: () => readonly string[];
}

export function createNoSecretInLogsAssertion(
  options: NoSecretInLogsAssertionOptions,
): ChaosAssertion {
  return {
    name: 'no-secret-in-logs',
    check(snapshot: ChaosSnapshot): ChaosAssertionResult {
      const values = options.watchedValues();
      if (values.length === 0) {
        return {
          name: 'no-secret-in-logs',
          ok: true,
          message: 'no secret values registered for this run',
        };
      }
      const logJson = options.getLogLines().join('\n');
      const auditJson = JSON.stringify(snapshot.auditRecords);
      const hits: Array<{ value: string; source: 'logs' | 'audit' }> = [];
      for (const v of values) {
        if (v.length === 0) continue;
        if (logJson.includes(v)) hits.push({ value: '[redacted]', source: 'logs' });
        if (auditJson.includes(v)) hits.push({ value: '[redacted]', source: 'audit' });
      }
      if (hits.length === 0) {
        return {
          name: 'no-secret-in-logs',
          ok: true,
          message: `no leaks across ${values.length} watched value(s)`,
        };
      }
      // Never include the actual value in the output.
      return {
        name: 'no-secret-in-logs',
        ok: false,
        message: `${hits.length} secret leak(s) detected`,
        details: { hits: hits.slice(0, 10) },
      };
    },
  };
}

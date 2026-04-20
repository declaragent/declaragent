import type {
  StoredAuditEntry,
  TenantAuditRecord,
  VerifyReport,
  VerifyViolation,
} from './types.js';

/**
 * Phase 6 slice-5 standalone chain-verify helper.
 *
 * Walks an iterable of {@link StoredAuditEntry} in seq order and
 * verifies:
 *   1. `prevHash` equals the previous entry's `recordHash`.
 *   2. For non-tombstone entries: `recordHash` equals
 *      `SHA-256(prevHash + "\n" + canonicalize(record))`.
 *
 * Tombstone entries (`kind === 'erased'`) keep their original hash —
 * the erasure path never recomputes it. Verification for tombstones is
 * continuity-only; the original content is gone, so an external
 * auditor can confirm the chain is intact without ever seeing PII.
 */

const HEX_CHARS = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += HEX_CHARS[b >> 4];
    out += HEX_CHARS[b & 0xf];
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return bytesToHex(new Uint8Array(digest));
}

/** Canonicalize with sorted keys so the hash is deterministic. */
export function canonicalizeRecord(record: TenantAuditRecord): string {
  return JSON.stringify(deepSortKeys(record));
}

function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      out[k] = deepSortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Compute the hash for one entry given the previous entry's hash. */
export async function computeRecordHash(
  prevHash: string,
  record: TenantAuditRecord,
): Promise<string> {
  return sha256Hex(`${prevHash}\n${canonicalizeRecord(record)}`);
}

/** Verify an iterable of stored entries. See module docstring. */
export async function verifyEntries(entries: Iterable<StoredAuditEntry>): Promise<VerifyReport> {
  const violations: VerifyViolation[] = [];
  let verified = 0;
  let total = 0;
  let expectedPrev = '';
  for (const entry of entries) {
    total += 1;
    if (entry.prevHash !== expectedPrev) {
      violations.push({
        seq: entry.seq,
        kind: 'prev-hash-mismatch',
        expectedHash: expectedPrev,
        observedHash: entry.prevHash,
        message: `prev_hash chain break at seq ${entry.seq}`,
      });
      expectedPrev = entry.recordHash;
      continue;
    }
    if (entry.record.kind !== 'erased') {
      const computed = await computeRecordHash(entry.prevHash, entry.record);
      if (computed !== entry.recordHash) {
        violations.push({
          seq: entry.seq,
          kind: 'hash-mismatch',
          expectedHash: entry.recordHash,
          observedHash: computed,
          message: `record hash mismatch at seq ${entry.seq}`,
        });
        expectedPrev = entry.recordHash;
        continue;
      }
    }
    verified += 1;
    expectedPrev = entry.recordHash;
  }
  return {
    ok: violations.length === 0,
    totalEntries: total,
    verifiedEntries: verified,
    violations,
  };
}

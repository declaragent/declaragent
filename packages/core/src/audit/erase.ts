import type { EraseOptions, TenantAuditRecord, TenantAuditSink } from './types.js';

/**
 * Phase 6 slice-5 right-to-erasure helpers.
 *
 * Thin convenience wrappers over {@link TenantAuditSink.erase}. The
 * sink does the heavy lifting; these helpers pre-wire the common
 * predicates (platform user id, session id, correlation id) so CLI
 * + control-plane callers don't have to re-implement the pattern.
 *
 * Every helper leaves a tombstone behind per the plan's §13.7 design —
 * the hash chain stays verifiable after erasure because the record's
 * recorded hash is preserved; only the serialized content is scrubbed.
 */

export interface ErasePlatformUserOptions {
  platformUserId: string;
  reason?: string;
}

/**
 * Erase every record that mentions `platformUserId` in a channel
 * context (inbound event, tool call, outbound send). Returns the
 * erased count.
 */
export async function erasePlatformUser(
  sink: TenantAuditSink,
  opts: ErasePlatformUserOptions,
): Promise<number> {
  const reason = opts.reason ?? 'gdpr-subject-erasure';
  const matches: EraseOptions['matches'] = (record: TenantAuditRecord) => {
    switch (record.kind) {
      case 'channel_event':
        return record.user.platformUserId === opts.platformUserId;
      case 'channel_tool_call':
        return record.user.platformUserId === opts.platformUserId;
      default:
        return false;
    }
  };
  return sink.erase({ reason, matches });
}

export interface EraseBySessionOptions {
  sessionId: string;
  reason?: string;
}

/**
 * Erase every record attached to `sessionId` — covers both the
 * generic `tool_call` records and the Phase-5 channel-tool-call +
 * outbound variants.
 */
export async function eraseBySession(
  sink: TenantAuditSink,
  opts: EraseBySessionOptions,
): Promise<number> {
  const reason = opts.reason ?? 'session-erasure';
  const matches: EraseOptions['matches'] = (record: TenantAuditRecord) => {
    switch (record.kind) {
      case 'tool_call':
        return record.sessionId === opts.sessionId;
      case 'channel_tool_call':
        return record.sessionId === opts.sessionId;
      case 'channel_outbound':
        return record.sessionId === opts.sessionId;
      default:
        return false;
    }
  };
  return sink.erase({ reason, matches });
}

export interface EraseByCorrelationOptions {
  correlationId: string;
  reason?: string;
}

/**
 * Erase every record that shares a correlation id. Useful when an
 * incident response narrows the scope to one originating event's full
 * blast-radius.
 */
export async function eraseByCorrelation(
  sink: TenantAuditSink,
  opts: EraseByCorrelationOptions,
): Promise<number> {
  const reason = opts.reason ?? 'incident-erasure';
  const matches: EraseOptions['matches'] = (record: TenantAuditRecord) => {
    return 'correlationId' in record && record.correlationId === opts.correlationId;
  };
  return sink.erase({ reason, matches });
}

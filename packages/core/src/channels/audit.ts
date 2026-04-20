import type { EventKind } from '../events/types.js';
import type { MessageContent } from './types.js';

/**
 * Channel-scoped audit log (Phase-5 slice 9).
 *
 * Every inbound channel event, every tool call dispatched from a
 * channel-backed session, and every outbound send emits a record. The
 * daemon wires one of these into the session-channel context at
 * spawn time; tests stub it with `createInMemoryChannelAuditLogger`.
 *
 * The daemon's existing Phase-1 audit log captures tool calls agnostic
 * of their origin. This channel audit is orthogonal — it answers the
 * question "who in which conversation caused this?" which the generic
 * tool-call log cannot reconstruct without a principal join.
 *
 * Phase 6 (security hardening) may wire a tamper-evident sink here.
 * For v0.9 the in-memory default is sufficient for on-daemon queries +
 * test assertions.
 */

// ── Record shapes ─────────────────────────────────────────────────────────

interface ChannelAuditRecordBase {
  /** Record creation timestamp (ms-epoch). */
  ts: number;
  /** Channel adapter instance id (e.g. "telegram-main"). */
  channelId: string;
  /** Trace id threaded from the originating event. */
  correlationId?: string;
}

/**
 * An inbound channel event: a user sent a message, clicked a button,
 * fired a slash command, added a reaction. Recorded before the
 * dispatcher routes the event so audit attribution is preserved even
 * when the session rejects or short-circuits.
 */
export interface ChannelEventAuditRecord extends ChannelAuditRecordBase {
  kind: 'channel_event';
  user: {
    platformUserId: string;
    displayName?: string;
    agentUserId?: string;
  };
  conversationId: string;
  threadId?: string;
  /** The `EventKind` dispatched for this inbound. */
  eventKind: EventKind;
  /** Optional short summary of the payload text for scanning log output. */
  payloadSummary?: string;
}

/**
 * A tool call invoked from a channel-backed session. Captured at the
 * permission-gate decision point so every allow / deny / prompt
 * outcome is attributed to the originating principal.
 */
export interface ChannelToolCallAuditRecord extends ChannelAuditRecordBase {
  kind: 'channel_tool_call';
  user: { platformUserId: string; agentUserId?: string };
  conversationId: string;
  sessionId: string;
  tool: string;
  permissionKey: string;
  outcome: 'allow' | 'deny' | 'prompt';
  /** Glob pattern that matched (allowed or denied). */
  matchedRule?: string;
  /** Execution duration for allowed calls. */
  durationMs?: number;
  /** Error payload on tool failure. */
  error?: { code?: string; message: string };
}

/**
 * An outbound message sent back to a channel. Recorded after the
 * transport acknowledges so `messageId` + `latencyMs` are populated;
 * failures are recorded with an empty messageId + `error`.
 */
export interface ChannelOutboundAuditRecord extends ChannelAuditRecordBase {
  kind: 'channel_outbound';
  conversationId: string;
  /** Session that produced the outbound, when known. */
  sessionId?: string;
  /** Platform-assigned message id ('' on failure). */
  messageId: string;
  contentKind: MessageContent['kind'];
  latencyMs?: number;
  /** Attributed reason (bridge-issued / SendMessage tool / other). */
  origin?: 'bridge' | 'tool' | 'external';
  error?: { code?: string; message: string };
}

export type ChannelAuditRecord =
  | ChannelEventAuditRecord
  | ChannelToolCallAuditRecord
  | ChannelOutboundAuditRecord;

// ── Public API ────────────────────────────────────────────────────────────

type OmitMeta<T> = Omit<T, 'kind' | 'ts'>;

export interface ChannelAuditLogger {
  emitChannelEvent(record: OmitMeta<ChannelEventAuditRecord>): void;
  emitChannelToolCall(record: OmitMeta<ChannelToolCallAuditRecord>): void;
  emitChannelOutbound(record: OmitMeta<ChannelOutboundAuditRecord>): void;
  /** Read snapshot for `/status` and tests. */
  snapshot(filter?: ChannelAuditFilter): readonly ChannelAuditRecord[];
  clear(): void;
}

export interface ChannelAuditFilter {
  channelId?: string;
  sinceMs?: number;
  kind?: ChannelAuditRecord['kind'];
}

export interface CreateChannelAuditLoggerOptions {
  /** LRU cap on stored records. Defaults to 4096. */
  maxRecords?: number;
  /** Injected clock. Default: `Date.now`. */
  now?: () => number;
}

export const DEFAULT_CHANNEL_AUDIT_MAX = 4096;

/**
 * In-memory implementation. Constant-time emit, linear snapshot.
 * Retains the most recent `maxRecords` entries; older entries evict
 * on insertion so long-running daemons don't leak memory.
 */
export function createInMemoryChannelAuditLogger(
  options: CreateChannelAuditLoggerOptions = {},
): ChannelAuditLogger {
  const maxRecords = options.maxRecords ?? DEFAULT_CHANNEL_AUDIT_MAX;
  const now = options.now ?? Date.now;
  const records: ChannelAuditRecord[] = [];

  function push(record: ChannelAuditRecord): void {
    records.push(record);
    if (records.length > maxRecords) {
      records.splice(0, records.length - maxRecords);
    }
  }

  return {
    emitChannelEvent(input) {
      push({ ...input, kind: 'channel_event', ts: now() });
    },
    emitChannelToolCall(input) {
      push({ ...input, kind: 'channel_tool_call', ts: now() });
    },
    emitChannelOutbound(input) {
      push({ ...input, kind: 'channel_outbound', ts: now() });
    },
    snapshot(filter) {
      if (!filter) return [...records];
      return records.filter((r) => {
        if (filter.kind && r.kind !== filter.kind) return false;
        if (filter.channelId && r.channelId !== filter.channelId) return false;
        if (filter.sinceMs !== undefined && r.ts < filter.sinceMs) return false;
        return true;
      });
    },
    clear() {
      records.length = 0;
    },
  };
}

/**
 * Null logger used when auditing is explicitly off. Every method is a
 * no-op; `snapshot()` returns an empty array. Useful as a default
 * sentinel in dependency injection chains.
 */
export function createNoopChannelAuditLogger(): ChannelAuditLogger {
  return {
    emitChannelEvent() {},
    emitChannelToolCall() {},
    emitChannelOutbound() {},
    snapshot() {
      return [];
    },
    clear() {},
  };
}

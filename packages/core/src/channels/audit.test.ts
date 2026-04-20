import { describe, expect, test } from 'bun:test';
import { createInMemoryChannelAuditLogger, createNoopChannelAuditLogger } from './audit.js';

describe('createInMemoryChannelAuditLogger', () => {
  test('stamps ts + kind on every record', () => {
    let t = 1000;
    const logger = createInMemoryChannelAuditLogger({ now: () => t });
    logger.emitChannelEvent({
      channelId: 'slack-prod',
      user: { platformUserId: 'U0A', displayName: 'Alice' },
      conversationId: 'C1',
      eventKind: 'chat.mention',
    });
    t = 2000;
    logger.emitChannelToolCall({
      channelId: 'slack-prod',
      user: { platformUserId: 'U0A' },
      conversationId: 'C1',
      sessionId: 'chat:slack-prod:C1:main',
      tool: 'Bash',
      permissionKey: 'Bash:git status',
      outcome: 'allow',
      matchedRule: 'Bash:git *',
      durationMs: 12,
    });
    t = 3000;
    logger.emitChannelOutbound({
      channelId: 'slack-prod',
      conversationId: 'C1',
      messageId: 'ts-1',
      contentKind: 'rich',
      latencyMs: 240,
      origin: 'bridge',
    });
    const snap = logger.snapshot();
    expect(snap).toHaveLength(3);
    expect(snap.map((r) => r.kind)).toEqual([
      'channel_event',
      'channel_tool_call',
      'channel_outbound',
    ]);
    expect(snap.map((r) => r.ts)).toEqual([1000, 2000, 3000]);
  });

  test('filters by channelId', () => {
    const logger = createInMemoryChannelAuditLogger();
    logger.emitChannelEvent({
      channelId: 'a',
      user: { platformUserId: 'U' },
      conversationId: 'C',
      eventKind: 'chat.message',
    });
    logger.emitChannelEvent({
      channelId: 'b',
      user: { platformUserId: 'U' },
      conversationId: 'C',
      eventKind: 'chat.message',
    });
    const slotA = logger.snapshot({ channelId: 'a' });
    expect(slotA).toHaveLength(1);
    expect(slotA[0]?.channelId).toBe('a');
  });

  test('filters by kind', () => {
    const logger = createInMemoryChannelAuditLogger();
    logger.emitChannelEvent({
      channelId: 'a',
      user: { platformUserId: 'U' },
      conversationId: 'C',
      eventKind: 'chat.message',
    });
    logger.emitChannelOutbound({
      channelId: 'a',
      conversationId: 'C',
      messageId: 'm',
      contentKind: 'text',
    });
    const outbound = logger.snapshot({ kind: 'channel_outbound' });
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.kind).toBe('channel_outbound');
  });

  test('filters by sinceMs', () => {
    let t = 0;
    const logger = createInMemoryChannelAuditLogger({ now: () => t });
    for (let i = 0; i < 5; i++) {
      t = i * 100;
      logger.emitChannelEvent({
        channelId: 'a',
        user: { platformUserId: 'U' },
        conversationId: 'C',
        eventKind: 'chat.message',
      });
    }
    const since = logger.snapshot({ sinceMs: 200 });
    expect(since.map((r) => r.ts)).toEqual([200, 300, 400]);
  });

  test('caps retention at maxRecords (LRU eviction)', () => {
    const logger = createInMemoryChannelAuditLogger({ maxRecords: 3 });
    for (let i = 0; i < 5; i++) {
      logger.emitChannelEvent({
        channelId: 'a',
        user: { platformUserId: `U${i}` },
        conversationId: 'C',
        eventKind: 'chat.message',
      });
    }
    const snap = logger.snapshot();
    expect(snap).toHaveLength(3);
    // Oldest 2 entries evicted; remaining 3 keep insertion order.
    expect(
      snap.map((r) => (r as { user: { platformUserId: string } }).user.platformUserId),
    ).toEqual(['U2', 'U3', 'U4']);
  });

  test('clear resets the log', () => {
    const logger = createInMemoryChannelAuditLogger();
    logger.emitChannelEvent({
      channelId: 'a',
      user: { platformUserId: 'U' },
      conversationId: 'C',
      eventKind: 'chat.message',
    });
    logger.clear();
    expect(logger.snapshot()).toEqual([]);
  });

  test('snapshot returns a defensive copy', () => {
    const logger = createInMemoryChannelAuditLogger();
    logger.emitChannelEvent({
      channelId: 'a',
      user: { platformUserId: 'U' },
      conversationId: 'C',
      eventKind: 'chat.message',
    });
    const snap1 = logger.snapshot();
    logger.emitChannelEvent({
      channelId: 'a',
      user: { platformUserId: 'U' },
      conversationId: 'C',
      eventKind: 'chat.message',
    });
    expect(snap1).toHaveLength(1);
    expect(logger.snapshot()).toHaveLength(2);
  });
});

describe('createNoopChannelAuditLogger', () => {
  test('every method is a no-op with an empty snapshot', () => {
    const logger = createNoopChannelAuditLogger();
    logger.emitChannelEvent({
      channelId: 'a',
      user: { platformUserId: 'U' },
      conversationId: 'C',
      eventKind: 'chat.message',
    });
    logger.emitChannelToolCall({
      channelId: 'a',
      user: { platformUserId: 'U' },
      conversationId: 'C',
      sessionId: 's',
      tool: 'Bash',
      permissionKey: 'Bash:x',
      outcome: 'allow',
    });
    logger.emitChannelOutbound({
      channelId: 'a',
      conversationId: 'C',
      messageId: 'm',
      contentKind: 'text',
    });
    expect(logger.snapshot()).toEqual([]);
    logger.clear();
    expect(logger.snapshot()).toEqual([]);
  });
});

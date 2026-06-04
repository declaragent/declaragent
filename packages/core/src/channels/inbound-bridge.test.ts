import { describe, expect, test } from 'bun:test';
import { createEventBus } from '../events/bus.js';
import type { AgentEvent, EventTarget } from '../events/types.js';
import { createChannelInboundBridge } from './inbound-bridge.js';

function makeChannelEvent(opts: {
  id: string;
  kind: string;
  channelId: string;
  target?: EventTarget;
  payload?: unknown;
}): AgentEvent {
  return {
    id: opts.id,
    kind: opts.kind as AgentEvent['kind'],
    source: {
      type: 'slack',
      channelId: opts.channelId,
      teamId: 'T1',
      channelSlackId: 'C1',
      ts: '1700000000.000',
    } as AgentEvent['source'],
    target: opts.target ?? { type: 'session', sessionId: 's-1', mode: 'inject' },
    timestamp: 1_700_000_000_000,
    payload: opts.payload ?? { text: 'hello' },
    auth: { kind: 'internal' },
  };
}

describe('createChannelInboundBridge', () => {
  test('republishes a session-targeted channel event as a skill target when configured', async () => {
    const bus = createEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      captured.push(e);
    });
    let counter = 0;
    const bridge = createChannelInboundBridge({
      bus,
      routesByChannel: {
        'slack-main': [{ event: 'chat.mention', skill: 'triage' }],
      },
      idFactory: () => `bridged-${++counter}`,
    });

    await bus.publish(
      makeChannelEvent({ id: 'inbound-1', kind: 'chat.mention', channelId: 'slack-main' }),
    );
    // Let the bridge's async subscriber settle.
    await new Promise((r) => setTimeout(r, 0));

    // Original session-target + one bridged skill-target.
    expect(captured).toHaveLength(2);
    const bridged = captured.find((e) => e.target.type === 'skill');
    expect(bridged).toBeDefined();
    expect(bridged?.target.type === 'skill' && bridged.target.name).toBe('triage');
    expect(bridged?.meta?.causedBy).toBe('inbound-1');
    expect(bridge.emitted).toBe(1);

    bridge.detach();
  });

  test('ignores events from channels without configured routes', async () => {
    const bus = createEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      captured.push(e);
    });
    const bridge = createChannelInboundBridge({
      bus,
      routesByChannel: { 'slack-main': [{ event: 'chat.mention', skill: 'triage' }] },
    });
    await bus.publish(
      makeChannelEvent({ id: 'x', kind: 'chat.mention', channelId: 'OTHER-CHANNEL' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toHaveLength(1);
    expect(bridge.emitted).toBe(0);
    bridge.detach();
  });

  test('ignores events whose kind does not match any route', async () => {
    const bus = createEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      captured.push(e);
    });
    const bridge = createChannelInboundBridge({
      bus,
      routesByChannel: { 'slack-main': [{ event: 'chat.mention', skill: 'triage' }] },
    });
    await bus.publish(makeChannelEvent({ id: 'x', kind: 'chat.dm', channelId: 'slack-main' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toHaveLength(1);
    expect(bridge.emitted).toBe(0);
    bridge.detach();
  });

  test('does not re-enter on its own bridged events (skill-target guard)', async () => {
    const bus = createEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      captured.push(e);
    });
    let counter = 0;
    const bridge = createChannelInboundBridge({
      bus,
      routesByChannel: { 'slack-main': [{ event: 'chat.mention', skill: 'triage' }] },
      idFactory: () => `b-${++counter}`,
    });
    await bus.publish(
      makeChannelEvent({ id: 'inbound-1', kind: 'chat.mention', channelId: 'slack-main' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    // Original + exactly one bridged event — not an infinite chain.
    expect(captured).toHaveLength(2);
    expect(bridge.emitted).toBe(1);
    bridge.detach();
  });

  test('fans out when the same kind has multiple route entries', async () => {
    const bus = createEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      captured.push(e);
    });
    let counter = 0;
    const bridge = createChannelInboundBridge({
      bus,
      routesByChannel: {
        'slack-main': [
          { event: 'chat.mention', skill: 'triage' },
          { event: 'chat.mention', skill: 'audit' },
        ],
      },
      idFactory: () => `b-${++counter}`,
    });
    await bus.publish(makeChannelEvent({ id: 'i', kind: 'chat.mention', channelId: 'slack-main' }));
    await new Promise((r) => setTimeout(r, 0));
    const skillTargets = captured
      .filter((e) => e.target.type === 'skill')
      .map((e) => (e.target.type === 'skill' ? e.target.name : ''));
    expect(skillTargets.sort()).toEqual(['audit', 'triage']);
    expect(bridge.emitted).toBe(2);
    bridge.detach();
  });

  test('copies sessionKey onto the bridged skill target when the route declares one', async () => {
    const bus = createEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      captured.push(e);
    });
    const bridge = createChannelInboundBridge({
      bus,
      routesByChannel: {
        'slack-main': [{ event: 'chat.mention', skill: 'triage', sessionKey: 'thread-1' }],
      },
      idFactory: () => 'bridged-1',
    });
    await bus.publish(
      makeChannelEvent({ id: 'inbound-1', kind: 'chat.mention', channelId: 'slack-main' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const bridged = captured.find((e) => e.target.type === 'skill');
    expect(bridged?.target.type === 'skill' && bridged.target.sessionKey).toBe('thread-1');
    bridge.detach();
  });

  test('omits sessionKey from the bridged target when the route has none', async () => {
    const bus = createEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      captured.push(e);
    });
    const bridge = createChannelInboundBridge({
      bus,
      routesByChannel: { 'slack-main': [{ event: 'chat.mention', skill: 'triage' }] },
      idFactory: () => 'bridged-1',
    });
    await bus.publish(
      makeChannelEvent({ id: 'inbound-1', kind: 'chat.mention', channelId: 'slack-main' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const bridged = captured.find((e) => e.target.type === 'skill');
    expect(bridged).toBeDefined();
    // No `sessionKey` key emitted at all — byte-for-byte identical to pre-pinning.
    expect(bridged?.target.type === 'skill' && 'sessionKey' in bridged.target).toBe(false);
    bridge.detach();
  });

  test('detach stops further bridging', async () => {
    const bus = createEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe('*', (e) => {
      captured.push(e);
    });
    const bridge = createChannelInboundBridge({
      bus,
      routesByChannel: { 'slack-main': [{ event: 'chat.mention', skill: 'triage' }] },
    });
    bridge.detach();
    await bus.publish(
      makeChannelEvent({ id: 'after-detach', kind: 'chat.mention', channelId: 'slack-main' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toHaveLength(1);
    expect(bridge.emitted).toBe(0);
  });
});

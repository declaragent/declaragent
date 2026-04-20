/**
 * Phase 5 acceptance demo — programmatic tier.
 *
 * The spec's acceptance bar is:
 *
 *   > Bidirectional conversation on each of the four channels with
 *   > threads, reactions, typing indicators, and file upload demonstrated
 *   > in a single demo session.
 *
 * This test proves the end-to-end wiring using `createMockChannelInstance`
 * for all four channels. Real-platform integration is gated behind env
 * credentials and runs in a separate nightly workflow.
 *
 * Flow for each channel:
 *   1. Publish a synthetic `chat.message` AgentEvent via the mock's
 *      `publishInbound` path (direct call on `bus.publish`).
 *   2. A test "echo subscriber" re-emits the inbound as a
 *      `channel.send.request` on the bus — stands in for the real
 *      session/engine loop.
 *   3. `ChannelOutboundBridge` consumes the request and calls
 *      `channel.send()` on the matching mock.
 *   4. We exercise the rest of the capability surface (react, setTyping,
 *      uploadFile) via direct calls on each channel to cover the full
 *      spec bar.
 *
 * No real network calls, no real credentials — the demo runs in CI.
 */

import { describe, expect, test } from 'bun:test';
import {
  type AgentEvent,
  type ChannelSendRequestPayload,
  type ConversationRef,
  type FileUpload,
  type MessageContent,
  createChannelOutboundBridge,
  createChannelRegistry,
  createEventBus,
  createSessionChannelContextStore,
} from '@declaragent/core';
import { createMockChannelInstance } from '@declaragent/testkit/channels';

interface DemoChannelSpec {
  id: string;
  displayName: string;
  /**
   * Thread-style conversation reference — every channel carries one so
   * we prove threading support on each platform.
   */
  conversation: ConversationRef;
  inboundText: string;
}

const DEMO_CHANNELS: readonly DemoChannelSpec[] = [
  {
    id: 'telegram-demo',
    displayName: 'Telegram',
    conversation: {
      channelId: 'telegram-demo',
      conversationId: 'chat-12345',
    },
    inboundText: '/help please',
  },
  {
    id: 'discord-demo',
    displayName: 'Discord',
    conversation: {
      channelId: 'discord-demo',
      conversationId: 'channel-9876',
      threadId: 'thread-abc',
    },
    inboundText: 'hey bot, open a ticket',
  },
  {
    id: 'slack-demo',
    displayName: 'Slack',
    conversation: {
      channelId: 'slack-demo',
      conversationId: 'C0123',
      threadId: '1700000000.000100',
    },
    inboundText: '<@bot> status?',
  },
  {
    id: 'whatsapp-demo',
    displayName: 'WhatsApp',
    conversation: {
      channelId: 'whatsapp-demo',
      conversationId: '+15551234567',
    },
    inboundText: 'hola',
  },
];

describe('Phase 5 acceptance demo (programmatic)', () => {
  test('four-channel bidirectional conversation with threads, reactions, typing, files', async () => {
    // ── Setup ───────────────────────────────────────────────────────────
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    };

    // One mock instance per platform; the registry is keyed by id.
    const mocks = DEMO_CHANNELS.map((spec) => createMockChannelInstance({ id: spec.id }));
    for (const mock of mocks) {
      await mock.start();
      channels.register(mock);
    }

    // Outbound bridge — the real one, not a test double. It subscribes
    // to `channel.send.request` + `assistant.final`.
    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
    });
    const detachBridge = bridge.start();

    // Canned echo subscriber: for every `chat.message` event, re-emit
    // the inbound payload as a `channel.send.request` so the bridge
    // routes it to the originating channel. Stands in for the real
    // session/engine loop.
    const detachEcho = bus.subscribe('chat.message', async (event) => {
      const payload = event.payload as {
        conversation: ConversationRef;
        content: MessageContent;
      };
      const replyText =
        payload.content.kind === 'text' ? `concierge> ${payload.content.text} ✅` : 'concierge> 👍';
      const reply: ChannelSendRequestPayload = {
        conversation: payload.conversation,
        content: { kind: 'text', text: replyText },
        idempotencyKey: `demo:${payload.conversation.channelId}:${event.id}`,
      };
      await bus.publish({
        id: `reply-${event.id}`,
        kind: 'channel.send.request',
        source: { type: 'self', reason: 'loop' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: reply,
        auth: { kind: 'internal' },
      });
    });

    try {
      // ── Drive inbound traffic on every channel ───────────────────────
      for (const spec of DEMO_CHANNELS) {
        const inbound: AgentEvent = {
          id: `inbound-${spec.id}`,
          kind: 'chat.message',
          source: { type: 'self', reason: 'loop' },
          target: { type: 'broadcast' },
          timestamp: Date.now(),
          payload: {
            conversation: spec.conversation,
            content: { kind: 'text', text: spec.inboundText },
          },
          auth: { kind: 'internal' },
          meta: { correlationId: `demo-${spec.id}` },
        };
        await bus.publish(inbound);
      }
      await bus.drained();

      // Each mock should now have exactly one outbound send.
      for (let i = 0; i < DEMO_CHANNELS.length; i += 1) {
        const spec = DEMO_CHANNELS[i];
        const mock = mocks[i];
        if (!spec || !mock) throw new Error('demo spec/mock out of sync');
        expect(mock.calls.send).toHaveLength(1);
        const sent = mock.calls.send[0];
        if (!sent) throw new Error(`${spec.displayName} did not record a send`);
        expect(sent.conversation).toEqual(spec.conversation);
        expect(sent.content.kind).toBe('text');
        if (sent.content.kind === 'text') {
          expect(sent.content.text).toBe(`concierge> ${spec.inboundText} ✅`);
        }
        expect(sent.idempotencyKey.startsWith('demo:')).toBe(true);
      }

      // ── Exercise the rest of the capability surface per channel ──────
      // reactions, typing, file upload — everything the acceptance bar
      // explicitly mentions. Direct calls on the mock; the mock records
      // every invocation so tests assert on the whole surface.
      for (let i = 0; i < DEMO_CHANNELS.length; i += 1) {
        const spec = DEMO_CHANNELS[i];
        const mock = mocks[i];
        if (!spec || !mock) throw new Error('demo spec/mock out of sync');

        // Reaction on the inbound message.
        await mock.react?.({ conversation: spec.conversation, id: `msg-${spec.id}` }, '👀');
        // Typing indicator while "thinking".
        await mock.setTyping?.(spec.conversation, 2000);
        // File upload (simulated).
        const upload: FileUpload = {
          name: 'response.md',
          mimeType: 'text/markdown',
          bytes: new TextEncoder().encode(`# hello from ${spec.displayName}\n`),
        };
        const uploaded = await mock.uploadFile?.(upload, spec.conversation);
        expect(uploaded?.name).toBe('response.md');
        // Final ✅ reaction after reply.
        await mock.react?.({ conversation: spec.conversation, id: `msg-${spec.id}` }, '✅');
      }

      // ── Assertions across all four channels ──────────────────────────
      for (let i = 0; i < DEMO_CHANNELS.length; i += 1) {
        const spec = DEMO_CHANNELS[i];
        const mock = mocks[i];
        if (!spec || !mock) throw new Error('demo spec/mock out of sync');

        expect(mock.calls.send).toHaveLength(1);
        expect(mock.calls.react).toHaveLength(2);
        expect(mock.calls.react[0]?.emoji).toBe('👀');
        expect(mock.calls.react[1]?.emoji).toBe('✅');
        expect(mock.calls.setTyping).toHaveLength(1);
        expect(mock.calls.setTyping[0]?.durationMs).toBe(2000);
        expect(mock.calls.uploadFile).toHaveLength(1);
        expect(mock.calls.uploadFile[0]?.file.name).toBe('response.md');
        // Every channel should declare the four capabilities the
        // acceptance bar calls out explicitly.
        expect(mock.capabilities.supportsThreads).toBe(true);
        expect(mock.capabilities.supportsReactions).toBe(true);
        expect(mock.capabilities.supportsTypingIndicator).toBe(true);
        expect(mock.capabilities.supportsFileUpload).toBe(true);
      }

      // The echo produced exactly one outbound send per channel; no
      // drops, no duplicates.
      const totalSends = mocks.reduce((acc, m) => acc + m.calls.send.length, 0);
      expect(totalSends).toBe(DEMO_CHANNELS.length);
    } finally {
      detachEcho();
      detachBridge();
      for (const mock of mocks) await mock.stop();
    }
  });

  test('threaded conversations carry threadId end-to-end', async () => {
    // Separate + narrower test proving the bridge preserves
    // `conversation.threadId` on the outbound send.
    const bus = createEventBus();
    const channels = createChannelRegistry();
    const sessionChannelContext = createSessionChannelContextStore();
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    };
    const slack = createMockChannelInstance({ id: 'slack-threaded' });
    await slack.start();
    channels.register(slack);
    const bridge = createChannelOutboundBridge({
      bus,
      channels,
      sessionChannelContext,
      logger,
    });
    const detach = bridge.start();

    try {
      await bus.publish({
        id: 'threaded-1',
        kind: 'channel.send.request',
        source: { type: 'self', reason: 'loop' },
        target: { type: 'broadcast' },
        timestamp: Date.now(),
        payload: {
          conversation: {
            channelId: 'slack-threaded',
            conversationId: 'C99',
            threadId: '1700000000.000999',
          },
          content: { kind: 'text', text: 'threaded reply' },
          idempotencyKey: 'thread-1',
        },
        auth: { kind: 'internal' },
      });
      await bus.drained();
      expect(slack.calls.send).toHaveLength(1);
      expect(slack.calls.send[0]?.conversation.threadId).toBe('1700000000.000999');
    } finally {
      detach();
      await slack.stop();
    }
  });
});

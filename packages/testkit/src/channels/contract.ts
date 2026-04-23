/**
 * Reusable `ChannelInstance` conformance suite (Phase-5 slice 12).
 *
 * Every in-tree channel adapter imports + invokes this suite so the
 * baseline contract stays consistent: capabilities declared, send
 * idempotency enforced, rate-limit-retry behavior matched, optional
 * methods present only when the capability is set, lifecycle methods
 * complete without throwing.
 *
 * Usage inside an adapter package's `contract.test.ts`:
 *
 * ```ts
 * import { channelContractSuite } from '@declaragent/testkit/channels';
 * import { TelegramChannelInstance } from '../src/instance.js';
 *
 * channelContractSuite('telegram', async () => {
 *   const { instance, stub } = buildFixture();
 *   return {
 *     instance,
 *     simulateRateLimit(retryAfterMs) { stub.nextError = new ChannelRateLimitError(retryAfterMs); },
 *     cleanup: () => instance.stop(),
 *   };
 * });
 * ```
 */

import { describe, expect, test } from 'bun:test';
import type {
  ChannelCapabilities,
  ChannelInstance,
  ChannelMessageContent,
  ChannelRateLimitError,
  ConversationRef,
  MessageRef,
  SendMessageParams,
} from '@declaragent/core';

export interface ChannelContractFixture {
  /** The instance under test; freshly constructed per-test. */
  instance: ChannelInstance;
  /**
   * Optional teardown. Called after the last assertion in a test block;
   * implementations should stop any long-running work they started.
   */
  cleanup?(): Promise<void> | void;
  /**
   * Optional hook: configure the instance so the next `send()` throws a
   * `ChannelRateLimitError(retryAfterMs)`. When the fixture omits this,
   * the rate-limit-retry assertion is skipped.
   */
  simulateRateLimit?(retryAfterMs: number): void;
  /**
   * Optional hook: configure the instance so the next `send()` throws an
   * unspecified `Error(message)`. Skipped when absent.
   */
  simulateError?(message: string): void;
  /**
   * Optional hook: how many times the underlying transport's outbound
   * call has fired. Tests that assert "exactly one transport call after
   * idempotency dedupe" use this.
   */
  transportSendCount?(): number;
  /**
   * Conversation to use for tests. Defaults to `{ channelId: instance.id,
   * conversationId: 'test-conv-1' }`.
   */
  conversation?: ConversationRef;
}

export interface ChannelContractOptions {
  /**
   * When false, skip the lifecycle (start/stop/pause/resume) assertions —
   * useful for instances that keep long-running resources open across
   * tests. Default: true.
   */
  lifecycle?: boolean;
  /**
   * When false, skip the `send()` assertions — lets the suite run
   * against inbound-only stubs. Default: true.
   */
  outbound?: boolean;
}

type FixtureFactory = () => Promise<ChannelContractFixture> | ChannelContractFixture;

/**
 * Run the conformance suite against a `ChannelInstance` factory.
 * Wrap the whole suite in one `describe` so adapter package test output
 * shows "contract(telegram) > …" clearly.
 */
export function channelContractSuite(
  name: string,
  factory: FixtureFactory,
  options: ChannelContractOptions = {},
): void {
  const lifecycle = options.lifecycle ?? true;
  const outbound = options.outbound ?? true;

  describe(`channel contract (${name})`, () => {
    test('capabilities expose the required fields', async () => {
      const fx = await factory();
      try {
        assertCapabilitiesShape(fx.instance.capabilities);
      } finally {
        await fx.cleanup?.();
      }
    });

    test('instance.id + instance.type are non-empty strings', async () => {
      const fx = await factory();
      try {
        expect(typeof fx.instance.id).toBe('string');
        expect(fx.instance.id.length).toBeGreaterThan(0);
        expect(typeof fx.instance.type).toBe('string');
        expect(fx.instance.type.length).toBeGreaterThan(0);
      } finally {
        await fx.cleanup?.();
      }
    });

    test('optional methods match their capability flags', async () => {
      const fx = await factory();
      try {
        const caps = fx.instance.capabilities;
        const inst = fx.instance;
        // When a capability is declared, the corresponding method must exist.
        if (caps.supportsTypingIndicator) expect(typeof inst.setTyping).toBe('function');
        if (caps.supportsReactions) expect(typeof inst.react).toBe('function');
        if (caps.supportsEditMessage) expect(typeof inst.edit).toBe('function');
        if (caps.supportsDeleteMessage) expect(typeof inst.delete).toBe('function');
        // send is always required.
        expect(typeof inst.send).toBe('function');
      } finally {
        await fx.cleanup?.();
      }
    });

    if (lifecycle) {
      test('lifecycle: start/stop/pause/resume complete without throwing', async () => {
        const fx = await factory();
        try {
          await fx.instance.start();
          await fx.instance.pause();
          await fx.instance.resume();
          await fx.instance.stop();
        } finally {
          await fx.cleanup?.();
        }
      });

      test('health() returns a valid status', async () => {
        const fx = await factory();
        try {
          await fx.instance.start();
          const health = await fx.instance.health();
          expect(typeof health.status).toBe('string');
        } finally {
          await fx.instance.stop();
          await fx.cleanup?.();
        }
      });
    }

    if (outbound) {
      test('send() requires idempotencyKey', async () => {
        const fx = await factory();
        try {
          await fx.instance.start();
          const params: SendMessageParams = {
            conversation: defaultConv(fx),
            content: textContent('hi'),
            idempotencyKey: '',
          };
          await expect(fx.instance.send(params)).rejects.toThrow();
        } finally {
          await fx.instance.stop();
          await fx.cleanup?.();
        }
      });

      test('send() dedupes on identical idempotencyKey', async () => {
        const fx = await factory();
        try {
          await fx.instance.start();
          const key = `contract-dedupe-${Math.random()}`;
          const conv = defaultConv(fx);
          const first = await fx.instance.send({
            conversation: conv,
            content: textContent('once'),
            idempotencyKey: key,
          });
          const second = await fx.instance.send({
            conversation: conv,
            content: textContent('twice'),
            idempotencyKey: key,
          });
          expect(second).toEqual(first);
          if (fx.transportSendCount) {
            expect(fx.transportSendCount()).toBe(1);
          }
        } finally {
          await fx.instance.stop();
          await fx.cleanup?.();
        }
      });

      test('send() succeeds on plain text', async () => {
        const fx = await factory();
        try {
          await fx.instance.start();
          const sent = await fx.instance.send({
            conversation: defaultConv(fx),
            content: textContent('hello from contract'),
            idempotencyKey: `contract-text-${Math.random()}`,
          });
          expect(typeof sent.id).toBe('string');
          expect(sent.id.length).toBeGreaterThan(0);
          expect(sent.conversation.channelId).toBe(fx.instance.id);
        } finally {
          await fx.instance.stop();
          await fx.cleanup?.();
        }
      });

      test('ChannelRateLimitError triggers a single retry', async () => {
        const fx = await factory();
        if (!fx.simulateRateLimit) {
          // Fixture doesn't expose the hook; skip gracefully.
          await fx.cleanup?.();
          return;
        }
        try {
          await fx.instance.start();
          fx.simulateRateLimit(5);
          const sent = await fx.instance.send({
            conversation: defaultConv(fx),
            content: textContent('retry-me'),
            idempotencyKey: `contract-rl-${Math.random()}`,
          });
          expect(typeof sent.id).toBe('string');
        } finally {
          await fx.instance.stop();
          await fx.cleanup?.();
        }
      });

      test('non-rate-limit errors propagate', async () => {
        const fx = await factory();
        if (!fx.simulateError) {
          await fx.cleanup?.();
          return;
        }
        try {
          await fx.instance.start();
          fx.simulateError('contract-injected-error');
          await expect(
            fx.instance.send({
              conversation: defaultConv(fx),
              content: textContent('will fail'),
              idempotencyKey: `contract-err-${Math.random()}`,
            }),
          ).rejects.toThrow('contract-injected-error');
        } finally {
          await fx.instance.stop();
          await fx.cleanup?.();
        }
      });

      test('optional react() + edit() + delete() (when declared) run without throwing', async () => {
        const fx = await factory();
        try {
          await fx.instance.start();
          const conv = defaultConv(fx);
          const sent = await fx.instance.send({
            conversation: conv,
            content: textContent('anchor'),
            idempotencyKey: `contract-anchor-${Math.random()}`,
          });
          const ref: MessageRef = { conversation: conv, id: sent.id };
          if (fx.instance.capabilities.supportsReactions && fx.instance.react) {
            await fx.instance.react(ref, '👍');
          }
          if (fx.instance.capabilities.supportsEditMessage && fx.instance.edit) {
            await fx.instance.edit(ref, textContent('updated'));
          }
          if (fx.instance.capabilities.supportsDeleteMessage && fx.instance.delete) {
            await fx.instance.delete(ref);
          }
        } finally {
          await fx.instance.stop();
          await fx.cleanup?.();
        }
      });
    }
  });
}

function defaultConv(fx: ChannelContractFixture): ConversationRef {
  return fx.conversation ?? { channelId: fx.instance.id, conversationId: 'test-conv-1' };
}

function textContent(text: string): ChannelMessageContent {
  return { kind: 'text', text };
}

/**
 * Shape-check: every `ChannelCapabilities` key exists + has the right
 * primitive type. Keeps adapters from silently forgetting a field when
 * upstream `ChannelCapabilities` grows.
 */
function assertCapabilitiesShape(caps: ChannelCapabilities): void {
  const booleanFields: readonly (keyof ChannelCapabilities)[] = [
    'supportsThreads',
    'supportsReactions',
    'supportsTypingIndicator',
    'supportsFileUpload',
    'supportsVoice',
    'supportsButtons',
    'supportsEditMessage',
    'supportsDeleteMessage',
    'supportsPresence',
    'supportsSlashCommands',
    'supportsDMs',
    'supportsGroupChats',
    'supportsVoiceChannels',
  ];
  for (const field of booleanFields) {
    expect(typeof caps[field]).toBe('boolean');
  }
  expect(typeof caps.maxMessageLength).toBe('number');
  expect(caps.maxMessageLength).toBeGreaterThan(0);
  expect(typeof caps.maxAttachmentBytes).toBe('number');
  expect(caps.maxAttachmentBytes).toBeGreaterThan(0);
}

// Import-only assertion to keep `ChannelRateLimitError` from being
// tree-shaken out of adapter bundles that depend on the testkit.
export type { ChannelRateLimitError };

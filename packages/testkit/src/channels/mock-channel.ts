/**
 * Mock channel adapter + instance for skill-author + integration tests.
 *
 * Provides a fully capable `ChannelInstance` that records every outbound
 * call so callers can assert their skill produced the expected
 * `SendMessageParams`. Register it in a `ChannelRegistry` in place of a
 * real adapter:
 *
 * ```ts
 * const channels = createChannelRegistry();
 * const mock = createMockChannelInstance({ id: 'slack-mock' });
 * channels.register(mock);
 * // ...run the skill...
 * expect(mock.calls.send).toHaveLength(1);
 * expect(mock.calls.send[0].content).toEqual({ kind: 'text', text: 'hi' });
 * ```
 *
 * Also surfaces an `adapter()` factory that implements the full
 * `ChannelAdapter` contract — useful for discovery-layer tests that
 * exercise registration plumbing.
 */

import {
  type ChannelAction,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelDependencies,
  type ChannelInstance,
  type ChannelMessageContent,
  ChannelRateLimitError,
  type ConversationRef,
  type FileRef,
  type FileUpload,
  type MessageRef,
  type SendMessageParams,
  type SentMessage,
  type SourceHealthStatus,
  type WebhookRequest,
  type WebhookResponse,
} from '@declaragent/core';

export const MOCK_CAPABILITIES: ChannelCapabilities = {
  supportsThreads: true,
  supportsReactions: true,
  supportsTypingIndicator: true,
  supportsFileUpload: true,
  supportsVoice: true,
  supportsButtons: true,
  supportsEditMessage: true,
  supportsDeleteMessage: true,
  supportsPresence: false,
  supportsSlashCommands: true,
  supportsDMs: true,
  supportsGroupChats: true,
  supportsVoiceChannels: false,
  maxMessageLength: 4096,
  maxAttachmentBytes: 10 * 1024 * 1024,
};

// ── Recorded calls ────────────────────────────────────────────────────────

export interface MockChannelCalls {
  send: SendMessageParams[];
  setTyping: { conversation: ConversationRef; durationMs?: number }[];
  react: { ref: MessageRef; emoji: string }[];
  edit: { ref: MessageRef; content: ChannelMessageContent }[];
  delete: MessageRef[];
  uploadFile: { file: FileUpload; conversation: ConversationRef }[];
  performAction: ChannelAction[];
  handleWebhook: WebhookRequest[];
  start: number;
  stop: number;
  pause: number;
  resume: number;
}

// ── Configuration ─────────────────────────────────────────────────────────

export interface MockChannelOptions {
  /** Adapter id + `instance.id`. Defaults to `mock-channel`. */
  id?: string;
  /** Override declared capabilities (e.g. turn off typing). */
  capabilities?: ChannelCapabilities;
  /**
   * Optional preset of deterministic send outcomes. Each `send()` call
   * pops the next entry off the queue; when empty, a synthetic
   * `SentMessage` with an incrementing id is returned.
   */
  sendOutcomes?: MockSendOutcome[];
  /** Response returned from `handleWebhook` (default: 200 ok). */
  webhookResponse?: WebhookResponse;
}

export type MockSendOutcome =
  /** Succeed with this payload. */
  | { kind: 'ok'; result?: Partial<SentMessage> }
  /** Throw `ChannelRateLimitError(retryAfterMs)`. */
  | { kind: 'rate-limit'; retryAfterMs: number }
  /** Throw a plain `Error(message)`. */
  | { kind: 'error'; message: string };

// ── Instance ──────────────────────────────────────────────────────────────

export interface MockChannelInstance extends ChannelInstance {
  readonly calls: MockChannelCalls;
  /** Push an outcome for the next `send()`. */
  queueSendOutcome(outcome: MockSendOutcome): void;
  /** Reset every recorded call + outcome queue. */
  reset(): void;
  /** Current internal health state (for tests asserting lifecycle transitions). */
  state(): SourceHealthStatus;
}

export function createMockChannelInstance(options: MockChannelOptions = {}): MockChannelInstance {
  const id = options.id ?? 'mock-channel';
  const capabilities = options.capabilities ?? MOCK_CAPABILITIES;
  const webhookResponse = options.webhookResponse ?? { status: 200, body: 'ok' };
  const sendOutcomes: MockSendOutcome[] = [...(options.sendOutcomes ?? [])];
  const calls = emptyCalls();
  let state: SourceHealthStatus = 'starting';
  let sendSeq = 0;
  const idempotencyCache = new Map<string, SentMessage>();

  const instance: MockChannelInstance = {
    id,
    type: 'mock',
    capabilities,
    calls,

    async start() {
      calls.start += 1;
      state = 'healthy';
    },
    async stop() {
      calls.stop += 1;
      state = 'stopped';
    },
    async pause() {
      calls.pause += 1;
      state = 'degraded';
    },
    async resume() {
      calls.resume += 1;
      state = 'healthy';
    },
    async health() {
      return { status: state };
    },
    metrics() {
      return {
        eventsPublished: 0,
        lastEventAt: null,
      };
    },

    async send(params: SendMessageParams): Promise<SentMessage> {
      if (!params.idempotencyKey) {
        throw new Error('mock channel: idempotencyKey is required');
      }
      const cached = idempotencyCache.get(params.idempotencyKey);
      if (cached) return cached;

      calls.send.push(params);
      // Mimic BaseChannelInstance's one-shot rate-limit retry: pop the
      // outcome; if it's rate-limit, pop another and either succeed or
      // surface the second failure as before.
      const applyOutcome = (outcome: MockSendOutcome): SentMessage | null => {
        switch (outcome.kind) {
          case 'ok': {
            sendSeq += 1;
            const sent: SentMessage = {
              id: outcome.result?.id ?? `${id}-msg-${sendSeq}`,
              conversation: outcome.result?.conversation ?? params.conversation,
              ...(outcome.result?.sentAt !== undefined && { sentAt: outcome.result.sentAt }),
            };
            idempotencyCache.set(params.idempotencyKey, sent);
            return sent;
          }
          case 'rate-limit':
            throw new ChannelRateLimitError(outcome.retryAfterMs);
          case 'error':
            throw new Error(outcome.message);
        }
      };

      const first = sendOutcomes.shift() ?? { kind: 'ok' as const };
      try {
        const sent = applyOutcome(first);
        if (sent !== null) return sent;
      } catch (err) {
        if (err instanceof ChannelRateLimitError) {
          const retry = sendOutcomes.shift() ?? { kind: 'ok' as const };
          const sent = applyOutcome(retry);
          if (sent !== null) return sent;
        }
        throw err;
      }
      // Unreachable — applyOutcome always returns or throws for 'ok',
      // but TypeScript wants a terminal return.
      throw new Error('mock channel: unreachable');
    },

    async setTyping(conversation: ConversationRef, durationMs?: number) {
      calls.setTyping.push({ conversation, ...(durationMs !== undefined && { durationMs }) });
    },
    async react(ref: MessageRef, emoji: string) {
      calls.react.push({ ref, emoji });
    },
    async edit(ref: MessageRef, content: ChannelMessageContent) {
      calls.edit.push({ ref, content });
    },
    async delete(ref: MessageRef) {
      calls.delete.push(ref);
    },
    async uploadFile(file: FileUpload, conversation: ConversationRef): Promise<FileRef> {
      calls.uploadFile.push({ file, conversation });
      return {
        id: `mock-file-${calls.uploadFile.length}`,
        name: file.name,
        mimeType: file.mimeType,
      };
    },
    async performAction(action: ChannelAction) {
      calls.performAction.push(action);
    },
    async handleWebhook(req: WebhookRequest): Promise<WebhookResponse> {
      calls.handleWebhook.push(req);
      return webhookResponse;
    },

    queueSendOutcome(outcome) {
      sendOutcomes.push(outcome);
    },
    reset() {
      resetCalls(calls);
      sendOutcomes.length = 0;
      sendSeq = 0;
      state = 'starting';
      idempotencyCache.clear();
    },
    state() {
      return state;
    },
  };
  return instance;
}

function emptyCalls(): MockChannelCalls {
  return {
    send: [],
    setTyping: [],
    react: [],
    edit: [],
    delete: [],
    uploadFile: [],
    performAction: [],
    handleWebhook: [],
    start: 0,
    stop: 0,
    pause: 0,
    resume: 0,
  };
}

function resetCalls(c: MockChannelCalls): void {
  c.send.length = 0;
  c.setTyping.length = 0;
  c.react.length = 0;
  c.edit.length = 0;
  c.delete.length = 0;
  c.uploadFile.length = 0;
  c.performAction.length = 0;
  c.handleWebhook.length = 0;
  c.start = 0;
  c.stop = 0;
  c.pause = 0;
  c.resume = 0;
}

// ── Adapter factory ───────────────────────────────────────────────────────

export interface MockChannelConfig {
  id: string;
  capabilities?: ChannelCapabilities;
}

export function createMockChannelAdapter(
  options: MockChannelOptions = {},
): ChannelAdapter<MockChannelConfig> {
  return {
    type: 'mock',
    agentCompat: '*',
    capabilities: options.capabilities ?? MOCK_CAPABILITIES,
    validateConfig(cfg: unknown): asserts cfg is MockChannelConfig {
      if (!cfg || typeof cfg !== 'object') throw new Error('mock config must be an object');
      const c = cfg as Record<string, unknown>;
      if (typeof c.id !== 'string' || c.id.length === 0) {
        throw new Error('mock config requires a non-empty id');
      }
    },
    async create(cfg: MockChannelConfig, _deps: ChannelDependencies): Promise<ChannelInstance> {
      const merged: MockChannelOptions = { ...options, id: cfg.id };
      if (cfg.capabilities !== undefined) merged.capabilities = cfg.capabilities;
      return createMockChannelInstance(merged);
    },
  };
}

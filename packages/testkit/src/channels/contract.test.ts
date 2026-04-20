import { channelContractSuite } from './contract.js';
import { type MockChannelInstance, createMockChannelInstance } from './mock-channel.js';

/**
 * Self-test: the mock channel must pass its own conformance suite. This
 * doubles as a live example of the fixture plumbing adapter authors use
 * in their own `contract.test.ts`.
 */
channelContractSuite('mock-channel (self-test)', () => {
  const instance = createMockChannelInstance({ id: 'mock-self' });
  return {
    instance,
    simulateRateLimit(retryAfterMs) {
      instance.queueSendOutcome({ kind: 'rate-limit', retryAfterMs });
    },
    simulateError(message) {
      instance.queueSendOutcome({ kind: 'error', message });
    },
    transportSendCount() {
      return instance.calls.send.length;
    },
    cleanup: () => {
      instance.reset();
    },
  };
});

// Second pass with capabilities narrowed — verifies the suite skips
// optional-method checks when the capability flag is false.
channelContractSuite(
  'mock-channel (no buttons, no edit)',
  () => {
    const instance: MockChannelInstance = createMockChannelInstance({
      id: 'mock-narrow',
      capabilities: {
        supportsThreads: false,
        supportsReactions: false,
        supportsTypingIndicator: false,
        supportsFileUpload: false,
        supportsVoice: false,
        supportsButtons: false,
        supportsEditMessage: false,
        supportsDeleteMessage: false,
        supportsPresence: false,
        supportsSlashCommands: false,
        supportsDMs: true,
        supportsGroupChats: false,
        supportsVoiceChannels: false,
        maxMessageLength: 2000,
        maxAttachmentBytes: 1024 * 1024,
      },
    });
    return { instance, cleanup: () => instance.reset() };
  },
  { lifecycle: true, outbound: true },
);

import type {
  ChannelMessageContent,
  ChannelRegistry,
  ConversationRef,
  MessageRef,
} from '../channels/types.js';
import type { Mailbox } from '../events/mailbox.js';
import type { Tool } from '../types/tool.js';

// ── Input / output shapes ──────────────────────────────────────────────────

/**
 * Slice-11 input shape. Discriminated union over the two supported
 * destinations — the mailbox (agent-to-agent) and a registered
 * `ChannelInstance` (agent-to-chat).
 *
 * The permission key is derived from the kind:
 *   - `{ kind: 'agent', agent: 'billing-bot' }`         → `agent:billing-bot`
 *   - `{ kind: 'channel', channelId: 'slack-prod',
 *        conversationId: 'C123' }`                     → `channel:slack-prod/C123`
 *
 * which gives operators glob-match control per destination family:
 *
 * ```yaml
 * permissions:
 *   allow:
 *     - SendMessage:agent:billing-*        # any billing-* agent
 *     - SendMessage:channel:slack-prod/*   # any conversation on slack-prod
 *   deny:
 *     - SendMessage:channel:*              # block all channel sends by default
 * ```
 */
export type SendMessageInput =
  | {
      kind: 'agent';
      agent: string;
      payload: unknown;
    }
  | {
      kind: 'channel';
      channelId: string;
      conversationId: string;
      threadId?: string;
      content: ChannelMessageContent;
      replyTo?: MessageRef;
      /**
       * Optional override. When absent the tool derives a deterministic
       * key from `session.id + toolCall.id` (via `ctx` — for v0.9 we
       * fall back to a UUID since the tool context doesn't surface the
       * per-call id; the adapter's own `SendIdempotencyCache` still
       * de-dupes on exact key matches).
       */
      idempotencyKey?: string;
    };

export interface SendMessageOutput {
  kind: 'agent' | 'channel';
  /** Agent-target result fields. */
  eventId?: string;
  toAgent?: string;
  fromAgent?: string;
  /** Channel-target result fields. */
  messageId?: string;
  channelId?: string;
  conversationId?: string;
  threadId?: string;
}

// ── Factory ────────────────────────────────────────────────────────────────

export interface CreateSendMessageToolDeps {
  mailbox: Mailbox;
  /**
   * Optional channel registry. When absent the `channel` kind returns
   * ENOCHANNEL so agent-only deployments continue to work without
   * pulling in channel runtime dependencies.
   */
  channels?: ChannelRegistry;
}

/**
 * Normalize the factory arg. Two call shapes are accepted:
 *
 *   createSendMessageTool(mailbox)
 *   createSendMessageTool({ mailbox, channels? })
 *
 * The first is the Phase-3 agent-only signature; the second is the
 * slice-11 multi-target signature. Shape-sniff via the `mailbox` key.
 */
function normalizeDeps(arg: CreateSendMessageToolDeps | Mailbox): CreateSendMessageToolDeps {
  if (arg && typeof arg === 'object' && 'mailbox' in arg) {
    return arg;
  }
  return { mailbox: arg as Mailbox };
}

export function createSendMessageTool(
  arg: CreateSendMessageToolDeps | Mailbox,
): Tool<SendMessageInput, SendMessageOutput> {
  const { mailbox, channels } = normalizeDeps(arg);

  return {
    name: 'SendMessage',
    description:
      'Send a message to another agent or to a communication channel. Two forms:\n' +
      '  • kind: "agent"   — deliver to the recipient\'s next turn via the mailbox.\n' +
      '  • kind: "channel" — post to a registered channel conversation (Telegram / Discord / Slack / WhatsApp).\n' +
      'Permissioned per destination: `SendMessage:agent:<id>` or `SendMessage:channel:<channelId>/<conversationId>`.',
    inputSchema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          properties: {
            kind: { const: 'agent' },
            agent: { type: 'string', description: 'Recipient agent id.' },
            payload: { description: 'JSON-serializable payload delivered to the recipient.' },
          },
          required: ['kind', 'agent', 'payload'],
        },
        {
          type: 'object',
          properties: {
            kind: { const: 'channel' },
            channelId: {
              type: 'string',
              description: 'Channel adapter instance id (e.g. "slack-prod").',
            },
            conversationId: {
              type: 'string',
              description: 'Platform-specific conversation id (chat/channel/wa_id).',
            },
            threadId: { type: 'string', description: 'Optional thread id.' },
            content: {
              type: 'object',
              description: 'ChannelMessageContent union (text / rich / template / file / voice).',
            },
            replyTo: {
              type: 'object',
              description: 'Optional MessageRef to reply to.',
            },
            idempotencyKey: { type: 'string' },
          },
          required: ['kind', 'channelId', 'conversationId', 'content'],
        },
      ],
    },
    permissionKey: (input) => permissionKeyFor(input),
    async *execute(input, ctx) {
      if (ctx.abortSignal.aborted) {
        yield { type: 'error', error: { code: 'ABORTED', message: 'SendMessage aborted' } };
        return;
      }

      if (input.kind === 'agent') {
        try {
          const fromAgent = ctx.session.spec.name;
          const eventId = await mailbox.send(input.agent, input.payload, fromAgent);
          yield {
            type: 'result',
            output: {
              kind: 'agent',
              eventId,
              toAgent: input.agent,
              fromAgent,
            },
          };
        } catch (err) {
          yield {
            type: 'error',
            error: {
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            },
          };
        }
        return;
      }

      if (input.kind === 'channel') {
        if (!channels) {
          yield {
            type: 'error',
            error: {
              code: 'ENOCHANNEL',
              message:
                'SendMessage(channel) requires a channel registry. Wire `channels` into createSendMessageTool.',
            },
          };
          return;
        }
        const instance = channels.get(input.channelId);
        if (!instance) {
          yield {
            type: 'error',
            error: {
              code: 'ENOCHANNEL',
              message: `channel "${input.channelId}" is not registered`,
            },
          };
          return;
        }
        const conversation: ConversationRef = {
          channelId: input.channelId,
          conversationId: input.conversationId,
          ...(input.threadId !== undefined && { threadId: input.threadId }),
        };
        const idempotencyKey =
          input.idempotencyKey ?? `tool:${ctx.session.id}:${crypto.randomUUID()}`;
        try {
          const sent = await instance.send({
            conversation,
            content: input.content,
            idempotencyKey,
            ...(input.replyTo !== undefined && { replyTo: input.replyTo }),
          });
          const out: SendMessageOutput = {
            kind: 'channel',
            messageId: sent.id,
            channelId: input.channelId,
            conversationId: input.conversationId,
          };
          if (input.threadId !== undefined) out.threadId = input.threadId;
          yield { type: 'result', output: out };
        } catch (err) {
          yield {
            type: 'error',
            error: {
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            },
          };
        }
        return;
      }

      // Exhaustive — unreachable but satisfies TS exhaustiveness.
      const _exhaustive: never = input;
      void _exhaustive;
    },
  };
}

/**
 * Permission-key builder. Exposed so tests + audit callers can compute
 * the same key the tool would.
 */
export function permissionKeyFor(input: SendMessageInput): string {
  if (input.kind === 'agent') return `agent:${input.agent}`;
  return `channel:${input.channelId}/${input.conversationId}`;
}

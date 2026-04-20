import {
  type AckContext,
  BaseSourceInstance,
  type EventSourceTag,
  type NormalizeContext,
  type RawMessage,
  type SourceDependencies,
} from '@declaragent/core';
import type { SqsClient, SqsIncomingMessage } from './client.js';
import { type SqsTriggerConfig, isFifoQueue } from './config.js';

const DEFAULT_WAIT_SECONDS = 20;
const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_VISIBILITY_SECONDS = 30;

/**
 * SQS source instance. Subclasses `BaseSourceInstance` for retry / metrics
 * / span / concurrency. The instance owns:
 *
 * - the long-poll loop (one concurrent `receiveMessage` call at a time)
 * - visibility-timeout renewal while a handler is still running
 * - per-`MessageGroupId` serialization for FIFO queues
 * - ack = `DeleteMessage`; nack = `ChangeMessageVisibility(0)` for
 *   immediate redelivery (SQS then increments `ApproximateReceiveCount`
 *   and handles DLQ redrive natively when `maxReceiveCount` is hit).
 *
 * `delivery.maxRetries` is respected only when `delivery.dlq?.kind ===
 * 'agent-managed'`. For transport-native DLQ (the default and recommended
 * SQS pattern), the adapter keeps nacking and trusts the queue's
 * RedrivePolicy; setting `maxRetries` low in that configuration would
 * silently drop messages because acking removes them from SQS before
 * redrive fires.
 */
export class SqsSourceInstance extends BaseSourceInstance {
  private readonly sqsConfig: SqsTriggerConfig;
  private readonly client: SqsClient;
  private readonly queueUrl: string;
  private readonly isFifo: boolean;
  private readonly waitTimeSeconds: number;
  private readonly maxMessages: number;
  private readonly visibilityTimeoutSeconds: number;
  private readonly visibilityRenewalMs: number;

  private pollController: AbortController | null = null;
  private pollLoop: Promise<void> | null = null;
  private paused = false;

  /** Promise tail per MessageGroupId — FIFO serialization. */
  private readonly groupTails = new Map<string, Promise<void>>();

  /** Visibility-renewal timers per receipt handle. */
  private readonly renewalTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(config: SqsTriggerConfig, deps: SourceDependencies, client: SqsClient) {
    super({
      type: 'sqs',
      config: {
        id: config.id,
        routing: config.routing,
        delivery: config.delivery,
        limits: config.limits,
      },
      deps,
    });
    this.sqsConfig = config;
    this.client = client;
    this.queueUrl = config.transport.queueUrl;
    this.isFifo = isFifoQueue(this.queueUrl);
    this.waitTimeSeconds = config.transport.waitTimeSeconds ?? DEFAULT_WAIT_SECONDS;
    this.maxMessages = config.transport.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.visibilityTimeoutSeconds =
      config.transport.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_SECONDS;
    // Renew at half the visibility window by default; 0 disables.
    this.visibilityRenewalMs =
      config.transport.visibilityRenewalMs ??
      Math.floor((this.visibilityTimeoutSeconds * 1000) / 2);
  }

  // ── BaseSourceInstance lifecycle ────────────────────────────────────────

  protected async doStart(): Promise<void> {
    this.pollController = new AbortController();
    this.pollLoop = this.runPollLoop(this.pollController.signal);
  }

  protected async doStop(_reason?: string): Promise<void> {
    this.pollController?.abort();
    this.pollController = null;
    const loop = this.pollLoop;
    this.pollLoop = null;
    if (loop) {
      try {
        await loop;
      } catch (err) {
        this.deps.logger.warn('sqs.poll.stop-error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const timer of this.renewalTimers.values()) {
      clearInterval(timer);
    }
    this.renewalTimers.clear();
    this.groupTails.clear();
    try {
      await this.client.disconnect();
    } catch (err) {
      this.deps.logger.warn('sqs.client.disconnect-error', {
        id: this.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  protected async doPause(): Promise<void> {
    // `paused` suppresses new polls; in-flight handlers drain naturally.
    // We intentionally don't abort the running receiveMessage — its
    // timeout will elapse and the next loop iteration observes `paused`.
    this.paused = true;
  }

  protected async doResume(): Promise<void> {
    this.paused = false;
  }

  protected async healthDetails(): Promise<Record<string, unknown>> {
    return {
      queueUrl: this.queueUrl,
      fifo: this.isFifo,
      inflightRenewalTimers: this.renewalTimers.size,
      paused: this.paused,
    };
  }

  /**
   * Transport-native DLQ is a no-op: SQS's RedrivePolicy moves the
   * message to the configured DLQ queue once `ApproximateReceiveCount`
   * exceeds `maxReceiveCount`. Calling this from the base class means
   * the agent-managed path is active; send to the configured URL.
   */
  protected async sendToDLQ(raw: RawMessage, err: Error): Promise<void> {
    const dlq = this.sqsConfig.delivery.dlq;
    if (!dlq || dlq.kind !== 'agent-managed') {
      this.deps.logger.warn('sqs.dlq.native', {
        id: this.id,
        messageId: raw.meta?.messageId,
        hint: 'configure SQS RedrivePolicy for native DLQ; adapter never reaches this path when dlq.kind is transport-native',
      });
      return;
    }
    if (!dlq.destination) {
      throw new Error('sqs dlq.destination is required for agent-managed DLQ');
    }
    const bodyStr = typeof raw.value === 'string' ? raw.value : new TextDecoder().decode(raw.value);
    await this.client.sendMessage({
      queueUrl: dlq.destination,
      body: bodyStr,
      messageAttributes: {
        'x-declaragent-dlq-reason': err.message,
        'x-declaragent-origin-queue': this.queueUrl,
        ...(raw.meta?.messageId !== undefined && {
          'x-declaragent-origin-message-id': String(raw.meta.messageId),
        }),
      },
    });
  }

  /**
   * Override the base retry/DLQ path for SQS-native redrive. When DLQ is
   * transport-native (default), always nack — never ack — so SQS's
   * RedrivePolicy handles terminal failure. The local `maxRetries`
   * budget is ignored in that case because acking would delete the
   * message before SQS can redrive it.
   */
  protected override async handleFailure(
    raw: RawMessage,
    ack: AckContext,
    err: Error,
  ): Promise<void> {
    const dlq = this.sqsConfig.delivery.dlq;
    if (dlq?.kind === 'agent-managed') {
      return super.handleFailure(raw, ack, err);
    }
    this.deps.logger.warn('sqs.nack-forever', {
      id: this.id,
      messageId: ack.messageId,
      attempt: Number(raw.meta?.deliveryCount ?? 0),
      err: err.message,
    });
    try {
      await ack.nack();
    } catch (nackErr) {
      this.deps.logger.error('sqs.nack.error', {
        id: this.id,
        err: nackErr instanceof Error ? nackErr.message : String(nackErr),
      });
    }
  }

  // ── Polling loop ────────────────────────────────────────────────────────

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.paused) {
        await sleep(200, signal);
        continue;
      }
      try {
        const msgs = await this.client.receiveMessage({
          queueUrl: this.queueUrl,
          maxMessages: this.maxMessages,
          waitTimeSeconds: this.waitTimeSeconds,
          visibilityTimeoutSeconds: this.visibilityTimeoutSeconds,
          attributeNames: ['All'],
          messageAttributeNames: ['All'],
        });
        if (signal.aborted) break;
        for (const msg of msgs) {
          this.dispatchMessage(msg);
        }
      } catch (err) {
        if (signal.aborted) break;
        this.recordConnectionError();
        this.deps.logger.error('sqs.receive.error', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
        // Back off briefly so we don't hot-loop against a broken endpoint.
        await sleep(1000, signal);
      }
    }
  }

  private dispatchMessage(msg: SqsIncomingMessage): void {
    const raw = this.toRaw(msg);
    const ack = this.buildAckContext(msg);
    this.scheduleVisibilityRenewal(msg);

    const task = async () => {
      try {
        await this.handleMessage(raw, ack);
      } catch (err) {
        // handleMessage already handles everything (retry/DLQ); this catch
        // is belt-and-suspenders against an unexpected programming error
        // inside the base class itself.
        this.deps.logger.error('sqs.handleMessage.unexpected', {
          id: this.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };

    if (this.isFifo && msg.messageGroupId !== undefined) {
      this.enqueueForGroup(msg.messageGroupId, task);
    } else {
      // Fire-and-forget. The concurrency limiter inside BaseSourceInstance
      // still bounds the parallelism; we rely on that rather than await
      // here so the poll loop stays responsive.
      void task();
    }
  }

  private enqueueForGroup(group: string, task: () => Promise<void>): void {
    const prev = this.groupTails.get(group) ?? Promise.resolve();
    // Chain regardless of prev outcome — a failed predecessor has already
    // been handled by BaseSourceInstance, and we still want the next
    // message in the group to run.
    const next = prev.then(task, task);
    this.groupTails.set(group, next);
    // Best-effort cleanup once the tail settles.
    void next.finally(() => {
      if (this.groupTails.get(group) === next) {
        this.groupTails.delete(group);
      }
    });
  }

  // ── Visibility renewal ──────────────────────────────────────────────────

  private scheduleVisibilityRenewal(msg: SqsIncomingMessage): void {
    if (this.visibilityRenewalMs <= 0) return;
    const timer = setInterval(() => {
      void this.client
        .changeMessageVisibility(this.queueUrl, msg.receiptHandle, this.visibilityTimeoutSeconds)
        .catch((err: unknown) => {
          this.deps.logger.warn('sqs.visibility.renew-error', {
            id: this.id,
            messageId: msg.messageId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }, this.visibilityRenewalMs);
    this.renewalTimers.set(msg.receiptHandle, timer);
  }

  private clearRenewal(receiptHandle: string): void {
    const timer = this.renewalTimers.get(receiptHandle);
    if (timer !== undefined) {
      clearInterval(timer);
      this.renewalTimers.delete(receiptHandle);
    }
  }

  // ── Mapping ─────────────────────────────────────────────────────────────

  private toRaw(msg: SqsIncomingMessage): RawMessage {
    const headers: Record<string, unknown> = { ...msg.messageAttributes };
    // Surface SQS system attributes on the event too (SentTimestamp,
    // ApproximateReceiveCount, …) via `meta` — they're not headers per se
    // but callers often want them for audit.
    const timestampStr = msg.attributes.SentTimestamp;
    const timestamp = timestampStr ? Number(timestampStr) : undefined;
    const deliveryCount = Number(msg.attributes.ApproximateReceiveCount ?? '1');
    return {
      value: msg.body,
      headers,
      ...(timestamp !== undefined && Number.isFinite(timestamp) && { timestamp }),
      meta: {
        messageId: msg.messageId,
        receiptHandle: msg.receiptHandle,
        deliveryCount,
        ...(msg.messageGroupId !== undefined && { messageGroupId: msg.messageGroupId }),
        ...(msg.messageDeduplicationId !== undefined && {
          messageDeduplicationId: msg.messageDeduplicationId,
        }),
        sqsAttributes: msg.attributes,
      },
    };
  }

  private buildAckContext(msg: SqsIncomingMessage): AckContext {
    const { messageId, receiptHandle } = msg;
    return {
      messageId,
      ack: async () => {
        this.clearRenewal(receiptHandle);
        await this.client.deleteMessage(this.queueUrl, receiptHandle);
      },
      nack: async () => {
        this.clearRenewal(receiptHandle);
        // Visibility 0 = immediate redelivery. SQS increments
        // ApproximateReceiveCount which feeds the next deliveryCount.
        await this.client.changeMessageVisibility(this.queueUrl, receiptHandle, 0);
      },
    };
  }

  protected override buildNormalizeContext(raw: RawMessage): NormalizeContext {
    const meta = raw.meta ?? {};
    const source: EventSourceTag = {
      type: 'sqs',
      triggerId: this.id,
      queueUrl: this.queueUrl,
      messageId: String(meta.messageId ?? ''),
      ...(typeof meta.messageGroupId === 'string' && { messageGroupId: meta.messageGroupId }),
    };
    return { source, auth: { kind: 'trigger', triggerId: this.id } };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

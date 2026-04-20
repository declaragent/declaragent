/**
 * Thin facade over the AWS SDK surface the adapter uses. Keeping this
 * interface narrow lets unit tests stub SQS completely — the real SDK
 * only appears in `createAwsSqsClient` (the default factory).
 */

export interface SqsClientOptions {
  /** AWS region, e.g. `us-east-1`. */
  region: string;
  /**
   * Custom endpoint URL. Used by LocalStack + MinIO-compatible services.
   * When unset the SDK uses AWS's regional endpoint.
   */
  endpoint?: string;
  /**
   * Static credentials. Only use when the default credential chain
   * (instance profile, IAM role, env vars, shared config) isn't
   * acceptable. `undefined` → default chain.
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /** Maximum retries the SDK performs per call. Default 3. */
  maxAttempts?: number;
}

export interface SqsIncomingMessage {
  /** SQS MessageId. Unique per send. */
  messageId: string;
  /**
   * SQS receipt handle — required for `deleteMessage` + `changeMessageVisibility`.
   * Changes every time a message is returned from ReceiveMessage.
   */
  receiptHandle: string;
  body: string;
  /** Standard SQS system attributes (SentTimestamp, ApproximateReceiveCount, …). */
  attributes: Record<string, string>;
  /** User-supplied `MessageAttributes` decoded to strings. */
  messageAttributes: Record<string, string>;
  /** Populated only for FIFO queues. */
  messageGroupId?: string;
  messageDeduplicationId?: string;
  /** MD5 of the body, echoed by SQS. Useful for integrity checks. */
  md5OfBody?: string;
}

export interface ReceiveMessageRequest {
  queueUrl: string;
  maxMessages: number;
  /** Long-poll wait time (seconds). SQS caps at 20. */
  waitTimeSeconds: number;
  /**
   * Visibility timeout (seconds) applied to the returned batch. Adapters
   * pass their configured value here; separate from the queue's default.
   */
  visibilityTimeoutSeconds?: number;
  /** Comma-separable list; `All` to request every attribute. */
  attributeNames?: readonly string[];
  messageAttributeNames?: readonly string[];
}

export interface SendMessageRequest {
  queueUrl: string;
  body: string;
  messageGroupId?: string;
  messageDeduplicationId?: string;
  delaySeconds?: number;
  messageAttributes?: Record<string, string>;
}

export interface SqsClient {
  receiveMessage(req: ReceiveMessageRequest): Promise<readonly SqsIncomingMessage[]>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
  changeMessageVisibility(
    queueUrl: string,
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void>;
  /** Used only by adapters with an agent-managed DLQ. Not needed for SQS-native redrive. */
  sendMessage(req: SendMessageRequest): Promise<{ messageId: string }>;
  disconnect(): Promise<void>;
}

// ─── Default impl: @aws-sdk/client-sqs ──────────────────────────────────

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

export function createAwsSqsClient(options: SqsClientOptions): SqsClient {
  const client = new SQSClient({
    region: options.region,
    ...(options.endpoint !== undefined && { endpoint: options.endpoint }),
    ...(options.credentials !== undefined && {
      credentials: {
        accessKeyId: options.credentials.accessKeyId,
        secretAccessKey: options.credentials.secretAccessKey,
        ...(options.credentials.sessionToken !== undefined && {
          sessionToken: options.credentials.sessionToken,
        }),
      },
    }),
    ...(options.maxAttempts !== undefined && { maxAttempts: options.maxAttempts }),
  });

  return {
    async receiveMessage(req) {
      const out = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: req.queueUrl,
          MaxNumberOfMessages: req.maxMessages,
          WaitTimeSeconds: req.waitTimeSeconds,
          ...(req.visibilityTimeoutSeconds !== undefined && {
            VisibilityTimeout: req.visibilityTimeoutSeconds,
          }),
          // The SDK's type uses a (deprecated) string enum; we pass through
          // whatever the adapter requested.
          ...(req.attributeNames !== undefined && {
            AttributeNames: [...req.attributeNames] as never,
          }),
          ...(req.messageAttributeNames !== undefined && {
            MessageAttributeNames: [...req.messageAttributeNames],
          }),
        }),
      );

      const msgs = out.Messages ?? [];
      return msgs.map((m) => {
        const attrs = m.Attributes ?? {};
        const userAttrs: Record<string, string> = {};
        if (m.MessageAttributes) {
          for (const [k, v] of Object.entries(m.MessageAttributes)) {
            // StringValue is the canonical field for scalar types; Binary
            // values are rare enough to skip for v1.
            if (v.StringValue !== undefined) userAttrs[k] = v.StringValue;
          }
        }
        const out: SqsIncomingMessage = {
          messageId: m.MessageId ?? '',
          receiptHandle: m.ReceiptHandle ?? '',
          body: m.Body ?? '',
          attributes: attrs as Record<string, string>,
          messageAttributes: userAttrs,
          ...(attrs.MessageGroupId !== undefined && { messageGroupId: attrs.MessageGroupId }),
          ...(attrs.MessageDeduplicationId !== undefined && {
            messageDeduplicationId: attrs.MessageDeduplicationId,
          }),
          ...(m.MD5OfBody !== undefined && { md5OfBody: m.MD5OfBody }),
        };
        return out;
      });
    },
    async deleteMessage(queueUrl, receiptHandle) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      );
    },
    async changeMessageVisibility(queueUrl, receiptHandle, visibilityTimeoutSeconds) {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilityTimeoutSeconds,
        }),
      );
    },
    async sendMessage(req) {
      const attrs: Record<string, { DataType: string; StringValue: string }> | undefined =
        req.messageAttributes
          ? Object.fromEntries(
              Object.entries(req.messageAttributes).map(([k, v]) => [
                k,
                { DataType: 'String', StringValue: v },
              ]),
            )
          : undefined;
      const out = await client.send(
        new SendMessageCommand({
          QueueUrl: req.queueUrl,
          MessageBody: req.body,
          ...(req.messageGroupId !== undefined && { MessageGroupId: req.messageGroupId }),
          ...(req.messageDeduplicationId !== undefined && {
            MessageDeduplicationId: req.messageDeduplicationId,
          }),
          ...(req.delaySeconds !== undefined && { DelaySeconds: req.delaySeconds }),
          ...(attrs !== undefined && { MessageAttributes: attrs }),
        }),
      );
      return { messageId: out.MessageId ?? '' };
    },
    async disconnect() {
      client.destroy();
    },
  };
}

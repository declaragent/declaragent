/**
 * Kafka load producer. Emits JSON messages with two header fields:
 *
 *   x-declaragent-load-seq    — 0-indexed monotonic sequence
 *   x-declaragent-load-sent   — producer-side `Date.now()` at send
 *
 * The consumer side reads both to compute latency (`now() - sent`) and
 * detect drops/duplicates (uniqueness of `seq` over the run).
 */

import { Kafka, type Producer } from 'kafkajs';
import { type RunAtRateResult, runAtRate } from './pacer.js';

export const LOAD_SEQ_HEADER = 'x-declaragent-load-seq';
export const LOAD_SENT_HEADER = 'x-declaragent-load-sent';

export interface KafkaLoadProducerOptions {
  brokers: readonly string[];
  topic: string;
  clientId?: string;
  /** Target messages-per-second. */
  ratePerSec: number;
  /** Total messages to send. */
  totalMessages: number;
  /**
   * Payload generator. Defaults to a small JSON blob containing the
   * sequence number. Supply your own for realistic load shapes.
   */
  payloadFor?: (seq: number) => string;
  /** Producer-level batch size. Defaults to 16. Higher → fewer roundtrips. */
  batchSize?: number;
  /** Abort signal to stop early. */
  signal?: AbortSignal;
  /** Logger tag; used only for console.error on producer errors. */
  logLabel?: string;
  /** Test seam: inject a pre-built kafkajs producer instead of building one. */
  producer?: Producer;
}

export interface KafkaLoadProducerResult extends RunAtRateResult {
  sendErrors: number;
}

export async function runKafkaLoadProducer(
  options: KafkaLoadProducerOptions,
): Promise<KafkaLoadProducerResult> {
  const { brokers, topic, ratePerSec, totalMessages } = options;
  const payloadFor = options.payloadFor ?? ((seq) => JSON.stringify({ seq }));
  let producer: Producer;
  let ownedProducer = false;
  if (options.producer) {
    producer = options.producer;
  } else {
    const kafka = new Kafka({
      brokers: [...brokers],
      clientId: options.clientId ?? `declaragent-load-${Date.now()}`,
    });
    producer = kafka.producer();
    ownedProducer = true;
    await producer.connect();
  }
  let sendErrors = 0;
  try {
    const driver = await runAtRate({
      ratePerSec,
      totalMessages,
      batchSize: options.batchSize ?? 16,
      ...(options.signal !== undefined && { signal: options.signal }),
      onTick: async (seq) => {
        const sent = Date.now();
        try {
          await producer.send({
            topic,
            messages: [
              {
                value: payloadFor(seq),
                headers: {
                  [LOAD_SEQ_HEADER]: String(seq),
                  [LOAD_SENT_HEADER]: String(sent),
                },
              },
            ],
          });
        } catch (err) {
          sendErrors += 1;
          const label = options.logLabel ?? 'kafka-load-producer';
          console.error(
            `[${label}] send error seq=${seq}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    });
    return { ...driver, sendErrors };
  } finally {
    if (ownedProducer) {
      try {
        await producer.disconnect();
      } catch {
        // best-effort
      }
    }
  }
}

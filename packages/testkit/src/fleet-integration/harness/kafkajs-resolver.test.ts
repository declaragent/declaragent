import { describe, expect, test } from 'bun:test';
import { resolveKafkaJsModule } from './kafkajs-resolver.js';

describe('resolveKafkaJsModule', () => {
  test('resolves kafkajs from testkit deps and exposes Kafka', () => {
    const mod = resolveKafkaJsModule();
    expect(typeof mod.Kafka).toBe('function');
  });

  test('is cached (same reference on repeat calls)', () => {
    expect(resolveKafkaJsModule()).toBe(resolveKafkaJsModule());
  });

  test('the resolved module constructs a client without throwing', () => {
    const { Kafka } = resolveKafkaJsModule();
    const client = new Kafka({ clientId: 'test', brokers: ['localhost:9092'] });
    // Constructing a producer/consumer must not require a live broker.
    expect(typeof client.producer).toBe('function');
    expect(typeof client.consumer).toBe('function');
  });
});

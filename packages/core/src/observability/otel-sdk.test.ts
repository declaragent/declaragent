import { describe, expect, test } from 'bun:test';
import { OtelSdkError, startOtelSdk } from './otel-sdk.js';

function stubSdkModule(calls: {
  started: number;
  shutdown: number;
  config?: Record<string, unknown>;
}) {
  return {
    NodeSDK: class {
      constructor(config: Record<string, unknown>) {
        calls.config = config;
      }
      start() {
        calls.started += 1;
      }
      async shutdown() {
        calls.shutdown += 1;
      }
    },
  };
}

describe('startOtelSdk (WS7)', () => {
  test('constructs + starts the NodeSDK with the endpoint, returns a stop handle', async () => {
    const calls = { started: 0, shutdown: 0 } as {
      started: number;
      shutdown: number;
      config?: Record<string, unknown>;
    };
    const handle = await startOtelSdk({
      endpoint: 'http://collector:4318',
      serviceName: 'svc',
      loader: async () => stubSdkModule(calls),
    });
    expect(calls.started).toBe(1);
    expect(calls.config?.serviceName).toBe('svc');
    expect(calls.config?.traceExporter).toEqual({ url: 'http://collector:4318' });

    // stop() shuts the SDK down, and is idempotent.
    await handle.stop();
    await handle.stop();
    expect(calls.shutdown).toBe(1);
  });

  test('throws OtelSdkError when the sdk-node peer dep is absent', async () => {
    await expect(
      startOtelSdk({
        endpoint: 'http://c:4318',
        loader: async () => {
          throw new Error('Cannot find module');
        },
      }),
    ).rejects.toBeInstanceOf(OtelSdkError);
  });

  test('throws OtelSdkError when the module lacks a NodeSDK constructor', async () => {
    await expect(
      startOtelSdk({ endpoint: 'http://c:4318', loader: async () => ({}) }),
    ).rejects.toThrow(/NodeSDK/);
  });

  test('throws OtelSdkError when start() fails', async () => {
    await expect(
      startOtelSdk({
        endpoint: 'http://c:4318',
        loader: async () => ({
          NodeSDK: class {
            start() {
              throw new Error('bind failed');
            }
            async shutdown() {}
          },
        }),
      }),
    ).rejects.toThrow(/failed to start/);
  });
});

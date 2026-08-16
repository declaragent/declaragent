import { describe, expect, test } from 'bun:test';
import { OtelSdkError, otlpTracesUrl, startOtelSdk } from './otel-sdk.js';

interface Calls {
  started: number;
  shutdown: number;
  sdkConfig?: Record<string, unknown>;
  exporterConfig?: { url: string };
}

/**
 * Loader stub returning BOTH peer-dep modules the real bootstrap loads:
 * `@opentelemetry/sdk-node` (NodeSDK) and
 * `@opentelemetry/exporter-trace-otlp-http` (OTLPTraceExporter). The exporter
 * stub records the url it was constructed with — the real shape NodeSDK needs
 * (a SpanExporter instance, not a plain `{ url }`).
 */
function stubLoader(calls: Calls) {
  return async (name: string) => {
    if (name === '@opentelemetry/sdk-node') {
      return {
        NodeSDK: class {
          constructor(config: Record<string, unknown>) {
            calls.sdkConfig = config;
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
    if (name === '@opentelemetry/exporter-trace-otlp-http') {
      return {
        OTLPTraceExporter: class {
          export() {}
          constructor(config: { url: string }) {
            calls.exporterConfig = config;
          }
        },
      };
    }
    throw new Error(`unexpected module ${name}`);
  };
}

describe('otlpTracesUrl', () => {
  test('appends /v1/traces to a base endpoint, leaves a suffixed one as-is', () => {
    expect(otlpTracesUrl('http://c:4318')).toBe('http://c:4318/v1/traces');
    expect(otlpTracesUrl('http://c:4318/')).toBe('http://c:4318/v1/traces');
    expect(otlpTracesUrl('http://c:4318/v1/traces')).toBe('http://c:4318/v1/traces');
  });
});

describe('startOtelSdk (WS7)', () => {
  test('constructs a real OTLPTraceExporter + starts the NodeSDK, returns a stop handle', async () => {
    const calls: Calls = { started: 0, shutdown: 0 };
    const handle = await startOtelSdk({
      endpoint: 'http://collector:4318',
      serviceName: 'svc',
      loader: stubLoader(calls),
    });
    expect(calls.started).toBe(1);
    expect(calls.sdkConfig?.serviceName).toBe('svc');
    // The exporter is a constructed instance with the resolved traces URL,
    // and it's the object handed to NodeSDK as traceExporter (not `{ url }`).
    expect(calls.exporterConfig).toEqual({ url: 'http://collector:4318/v1/traces' });
    expect(calls.sdkConfig?.traceExporter).toBeDefined();
    expect(typeof (calls.sdkConfig?.traceExporter as { export?: unknown }).export).toBe('function');

    await handle.stop();
    await handle.stop();
    expect(calls.shutdown).toBe(1);
  });

  test('throws OtelSdkError when a peer dep is absent', async () => {
    await expect(
      startOtelSdk({
        endpoint: 'http://c:4318',
        loader: async () => {
          throw new Error('Cannot find module');
        },
      }),
    ).rejects.toBeInstanceOf(OtelSdkError);
  });

  test('throws OtelSdkError when sdk-node lacks NodeSDK', async () => {
    await expect(
      startOtelSdk({
        endpoint: 'http://c:4318',
        loader: async (name) =>
          name === '@opentelemetry/sdk-node' ? {} : { OTLPTraceExporter: class {} },
      }),
    ).rejects.toThrow(/NodeSDK/);
  });

  test('throws OtelSdkError when the exporter module lacks OTLPTraceExporter', async () => {
    await expect(
      startOtelSdk({
        endpoint: 'http://c:4318',
        loader: async (name) =>
          name === '@opentelemetry/sdk-node'
            ? {
                NodeSDK: class {
                  start() {}
                  async shutdown() {}
                },
              }
            : {},
      }),
    ).rejects.toThrow(/OTLPTraceExporter/);
  });

  test('throws OtelSdkError when start() fails', async () => {
    await expect(
      startOtelSdk({
        endpoint: 'http://c:4318',
        loader: async (name) =>
          name === '@opentelemetry/sdk-node'
            ? {
                NodeSDK: class {
                  start() {
                    throw new Error('bind failed');
                  }
                  async shutdown() {}
                },
              }
            : { OTLPTraceExporter: class {} },
      }),
    ).rejects.toThrow(/failed to start/);
  });
});

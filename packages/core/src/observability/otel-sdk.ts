/**
 * WS7 — actually START an OpenTelemetry SDK so spans EXPORT.
 *
 * `createOtelBridge` wraps `@opentelemetry/api`, which only produces a real
 * tracer once a `TracerProvider` is registered in the process. Until now
 * declaragent never registered one, so the bridge's spans went nowhere — the
 * audit's "tracing claimed but never started" finding (the `up` banner was made
 * honest about this in an earlier pass). This module closes the gap: when an
 * OTLP endpoint is configured, it loads `@opentelemetry/sdk-node` (a peer dep,
 * like the API bridge) and calls `sdk.start()`, so spans actually flow to the
 * collector at `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * The SDK is loaded through an injectable `PeerDepLoader`, so the bootstrap
 * logic — "did we construct + start the SDK, and does the returned handle stop
 * it" — is unit-testable with a stub module, no real collector required. The
 * actual span receipt is verified by the integration/soak environment.
 */

import { type PeerDepLoader, defaultPeerLoader } from '../events/schema-registry.js';

/** Minimal shape of `@opentelemetry/sdk-node`'s NodeSDK we depend on. */
interface NodeSdkLike {
  start(): void | Promise<void>;
  shutdown(): Promise<void>;
}

interface SdkNodeModule {
  NodeSDK: new (config: Record<string, unknown>) => NodeSdkLike;
}

export interface StartOtelSdkOptions {
  /** OTLP endpoint (e.g. `http://collector:4318`). Required to start. */
  endpoint: string;
  /** `service.name` resource attribute. Defaults to `declaragent`. */
  serviceName?: string;
  /** Peer-dep loader (tests inject a stub `@opentelemetry/sdk-node`). */
  loader?: PeerDepLoader;
}

export interface OtelSdkHandle {
  /** Shut the SDK down (flushes pending spans). Idempotent. */
  stop(): Promise<void>;
}

/**
 * Construct + start a NodeSDK pointed at `endpoint`. Returns a handle whose
 * `stop()` flushes and shuts the SDK down. Throws `OtelSdkError` when the peer
 * dep is absent or `start()` fails — the caller (the `up` loop) catches this
 * and falls back to the noop tracer with a loud warning, never crashing boot.
 */
export async function startOtelSdk(opts: StartOtelSdkOptions): Promise<OtelSdkHandle> {
  const loader = opts.loader ?? defaultPeerLoader;
  let mod: SdkNodeModule;
  try {
    mod = (await loader('@opentelemetry/sdk-node')) as SdkNodeModule;
  } catch (err) {
    throw new OtelSdkError(
      `@opentelemetry/sdk-node is not installed — cannot start span export: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof mod?.NodeSDK !== 'function') {
    throw new OtelSdkError('@opentelemetry/sdk-node did not export a NodeSDK constructor');
  }
  const sdk = new mod.NodeSDK({
    serviceName: opts.serviceName ?? 'declaragent',
    // The SDK reads OTEL_EXPORTER_OTLP_ENDPOINT from the env by default; we also
    // pass it explicitly so an injected/test SDK sees the configured value.
    traceExporter: { url: opts.endpoint },
  });
  try {
    await sdk.start();
  } catch (err) {
    throw new OtelSdkError(
      `OTel SDK failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await sdk.shutdown();
    },
  };
}

export class OtelSdkError extends Error {
  readonly code = 'EOTEL_SDK';
  constructor(message: string) {
    super(message);
    this.name = 'OtelSdkError';
  }
}

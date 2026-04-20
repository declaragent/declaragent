import type {
  EventSourceAdapter,
  EventSourceInstance,
  SourceDependencies,
} from '@declaragent/core';
import { type SqsClient, type SqsClientOptions, createAwsSqsClient } from './client.js';
import { type SqsTriggerConfig, assertSqsConfig, regionFromQueueUrl } from './config.js';
import { SqsSourceInstance } from './instance.js';

export interface SqsAdapterOptions {
  /**
   * Test seam: supply a pre-built `SqsClient` (stub) instead of letting
   * the adapter build one from `@aws-sdk/client-sqs`. When set, all
   * `transport.*` AWS fields are ignored — the injected client is used
   * as-is.
   */
  client?: SqsClient;
  /** Test seam: override the factory used to build the default client. */
  createClient?(options: SqsClientOptions): SqsClient;
}

export function createSqsAdapter(
  opts: SqsAdapterOptions = {},
): EventSourceAdapter<SqsTriggerConfig> {
  const buildClient = opts.createClient ?? createAwsSqsClient;

  return {
    type: 'sqs',
    agentCompat: '>=0.0.1',
    validateConfig(config: unknown): asserts config is SqsTriggerConfig {
      assertSqsConfig(config);
    },
    async create(config: SqsTriggerConfig, deps: SourceDependencies): Promise<EventSourceInstance> {
      const region = config.transport.region ?? regionFromQueueUrl(config.transport.queueUrl);
      if (!region) {
        // Caught upstream by assertSqsConfig when no `endpoint` is set,
        // but defense-in-depth here catches endpoint-without-region too.
        throw new Error('sqs adapter: cannot resolve region. Set transport.region explicitly.');
      }
      const client =
        opts.client ??
        buildClient({
          region,
          ...(config.transport.endpoint !== undefined && {
            endpoint: config.transport.endpoint,
          }),
          ...(config.transport.accessKeyId !== undefined &&
            config.transport.secretAccessKey !== undefined && {
              credentials: {
                accessKeyId: config.transport.accessKeyId,
                secretAccessKey: config.transport.secretAccessKey,
                ...(config.transport.sessionToken !== undefined && {
                  sessionToken: config.transport.sessionToken,
                }),
              },
            }),
        });
      return new SqsSourceInstance(config, deps, client);
    },
  };
}

/** Default adapter instance. */
export const sqsAdapter = createSqsAdapter();

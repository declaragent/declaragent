/**
 * Resolve the `kafkajs` module from the testkit package's own dependency tree.
 *
 * `@declaragent/plugin-agent-rpc`'s `createKafkaTransport` falls back to a bare
 * `await import('kafkajs')` when no `kafkajsModule` is supplied. That import is
 * resolved relative to the plugin-agent-rpc module, which does NOT declare
 * `kafkajs` as a dependency — so under a non-hoisted / CI `node_modules` layout
 * (or in a freshly-spawned soak subprocess) the import throws MODULE_NOT_FOUND
 * and the Kafka nightly + 24h soak die within ~40s.
 *
 * `kafkajs` IS a dependency of `@declaragent/testkit`, so we resolve it from
 * THIS module's location with `createRequire(import.meta.url)` and hand the
 * resolved module to `createKafkaTransport({ kafkajsModule })` explicitly.
 * `import.meta.url` (not `process.cwd()`) is the correct anchor: the soak
 * subprocess is spawned with an arbitrary working directory, so a cwd-relative
 * resolve would miss the dependency.
 */

import { createRequire } from 'node:module';
import type { KafkaJSModule } from '@declaragent/plugin-agent-rpc';

const require = createRequire(import.meta.url);

let cached: KafkaJSModule | undefined;

/** Resolve kafkajs from the testkit package; cached after first call. */
export function resolveKafkaJsModule(): KafkaJSModule {
  if (cached) return cached;
  const mod = require('kafkajs') as { default?: KafkaJSModule } & KafkaJSModule;
  // kafkajs ships CJS; accept either the namespace or a `.default` wrapper.
  const resolved = mod.Kafka ? mod : mod.default;
  if (!resolved?.Kafka) {
    throw new Error('resolveKafkaJsModule: resolved "kafkajs" has no `Kafka` export');
  }
  cached = resolved;
  return resolved;
}

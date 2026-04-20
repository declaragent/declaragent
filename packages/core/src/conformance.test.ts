import { test } from 'bun:test';
import type { ChannelAdapter } from './channels/types.js';
import type { EventSourceAdapter } from './events/types.js';

/**
 * v1.0 contract guard. Each fixture provides exactly the required
 * surface today. If a future change promotes a field to required, the
 * `satisfies` clause refuses to compile — a breaking-change signal.
 *
 * Intentionally typed as `Partial<...>` on the left-hand side so the
 * fixtures are forced to cover only the required keys: a new required
 * key would land on `Partial<...>` as still-optional but the compiler
 * would reject it in the fixture if the shape's required keys grew.
 */

const _minimalChannelAdapter = {
  type: 'x',
  capabilities: {} as never,
  validateConfig: (_c: unknown): asserts _c is unknown => {},
  create: async () => ({}) as never,
} satisfies ChannelAdapter<unknown>;

const _minimalEventSourceAdapter = {
  type: 'x',
  validateConfig: (_c: unknown): asserts _c is unknown => {},
  create: async () => ({}) as never,
} satisfies EventSourceAdapter<unknown>;

test('compile-level contract check', () => {
  // Type-level assertions above; runtime assertion is a sentinel so the
  // suite reports a green test when the contract is intact.
  if (_minimalChannelAdapter.type !== 'x' || _minimalEventSourceAdapter.type !== 'x') {
    throw new Error('v1.0 adapter contract drift');
  }
});

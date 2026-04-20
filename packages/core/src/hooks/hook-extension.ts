import type { Extension, ExtensionSource } from '../extension/types.js';
import type { Hook, HookPoint, HookRegistry } from './types.js';

let counter = 0;

/**
 * Wrap a `Hook` (point + subscriber) as an `Extension<'hook'>`. Slice 6's
 * plugin loader collects these and `bindHookExtensions` subscribes them
 * to the engine's `HookRegistry`.
 */
export function hookExtension<P extends HookPoint>(
  hook: Hook<P>,
  source: ExtensionSource,
  id?: string,
): Extension<'hook'> {
  const resolvedId = id ?? `hook:${hook.point}:${++counter}`;
  return {
    descriptor: {
      id: resolvedId,
      kind: 'hook',
      source,
    },
    payload: hook as unknown as Hook,
    activate() {},
  };
}

/**
 * Subscribe every `Extension<'hook'>` in `extensions` to `registry`.
 * Returns the aggregate unsubscribe so the caller can tear down on
 * deactivation/reload.
 */
export function bindHookExtensions(
  registry: HookRegistry,
  extensions: readonly Extension<'hook'>[],
): () => void {
  const offs: Array<() => void> = [];
  for (const ext of extensions) {
    const hook = ext.payload as Hook;
    offs.push(registry.on(hook.point, hook.subscriber));
  }
  return () => {
    for (const off of offs) off();
  };
}

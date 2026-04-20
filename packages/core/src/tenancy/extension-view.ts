import type {
  Extension,
  ExtensionDescriptor,
  ExtensionKind,
  ExtensionRegistry,
} from '../extension/types.js';
import { globMatches } from '../permission/glob.js';
import type { ExtensionScope } from './config-loader.js';

/**
 * Phase 6 slice-6 scoped registry view.
 *
 * The extension registry stays global — plugins, adapters, and built-in
 * tools register once at process startup. Tenant enforcement happens at
 * lookup time: {@link scopeRegistry} wraps the registry in a read-only
 * view that filters entries by the tenant's `{ allow, deny }` globs.
 *
 * Semantics:
 *   - `deny` always wins. An id matching any deny pattern is invisible.
 *   - When `allow` is set + non-empty, the id must match at least one
 *     allow pattern to pass.
 *   - When `allow` is undefined / empty, every non-denied id passes.
 *   - A scope of `undefined` or `{}` is the identity view — no filter.
 *
 * Patterns use the Phase-1 permission glob matcher so `*` / `**` /
 * `?` behave the same way the permission gate expects.
 */

export interface ExtensionRegistryView {
  list(): readonly ExtensionDescriptor[];
  byKind<K extends ExtensionKind>(kind: K): readonly Extension<K>[];
  get(id: string): Extension | undefined;
  /** True when the id would be visible through this view. */
  isVisible(id: string): boolean;
}

export function scopeRegistry(
  registry: ExtensionRegistry,
  scope: ExtensionScope | undefined,
): ExtensionRegistryView {
  const allow = scope?.allow ?? [];
  const deny = scope?.deny ?? [];

  function passes(id: string): boolean {
    for (const pattern of deny) {
      if (globMatches(pattern, id)) return false;
    }
    if (allow.length === 0) return true;
    for (const pattern of allow) {
      if (globMatches(pattern, id)) return true;
    }
    return false;
  }

  return {
    list() {
      return registry.list().filter((d) => passes(d.id));
    },
    byKind<K extends ExtensionKind>(kind: K): readonly Extension<K>[] {
      return registry.byKind(kind).filter((e) => passes(e.descriptor.id));
    },
    get(id: string): Extension | undefined {
      if (!passes(id)) return undefined;
      return registry.get(id);
    },
    isVisible(id: string): boolean {
      // A pattern only matches a real entry so keep the two concerns
      // separate — `isVisible` says "would the view show this id" which
      // is answered purely by the scope, not by registry state.
      return passes(id);
    },
  };
}

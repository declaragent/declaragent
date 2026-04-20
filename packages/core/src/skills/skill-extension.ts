import type { Extension } from '../extension/types.js';
import type { Skill } from './types.js';

/**
 * Wrap a `Skill` for the `ExtensionRegistry`. The descriptor (id, kind,
 * source) was already populated by the loader so this is a thin adapter.
 */
export function skillExtension(skill: Skill): Extension<'skill'> {
  return {
    descriptor: skill.descriptor,
    payload: skill,
    activate() {
      // Skills load synchronously from disk; nothing to start.
    },
  };
}

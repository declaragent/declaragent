import { SkillTemplateError } from './types.js';

export interface InterpolateOptions {
  /**
   * What to do for `{{var}}` references whose `var` is missing from `vars`.
   * - `throw` (default) — raise `SkillTemplateError` listing all missing names
   * - `empty` — substitute an empty string
   * - `preserve` — leave `{{var}}` literal in the output
   */
  onMissing?: 'throw' | 'empty' | 'preserve';
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_$][\w$.]*)\s*\}\}/g;

/**
 * Mustache-style `{{var}}` interpolation with dotted-path access (`{{user.name}}`).
 * Deliberately tiny — no conditionals, loops, or HTML escaping; the output is
 * fed straight to an LLM prompt where escaping is the model's job.
 */
export function interpolate(
  template: string,
  vars: Readonly<Record<string, unknown>>,
  options: InterpolateOptions = {},
): string {
  const onMissing = options.onMissing ?? 'throw';
  const missing: string[] = [];
  const result = template.replace(PLACEHOLDER, (match, path: string) => {
    const value = resolvePath(vars, path);
    if (value === undefined) {
      if (onMissing === 'throw') missing.push(path);
      else if (onMissing === 'empty') return '';
      return match;
    }
    return stringify(value);
  });
  if (missing.length > 0) {
    throw new SkillTemplateError(
      `template references undefined variable(s): ${[...new Set(missing)].join(', ')}`,
    );
  }
  return result;
}

function resolvePath(vars: Readonly<Record<string, unknown>>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = vars;
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

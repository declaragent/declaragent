/**
 * Scope-root resolution + path-confinement checks for the builder.
 *
 * Scope precedence (BUILDER_PLAN §2):
 *   1. nearest `fleet.yaml` ancestor
 *   2. nearest `agent.yaml` ancestor
 *   3. cwd itself
 *
 * All file-writing builder tools check `assertWithinScope` before
 * touching the filesystem. Calls that need to reach outside must pass
 * `confirmOutsideScope: true`, which the proposal flow (Phase 3) will
 * then gate on an explicit user confirmation.
 *
 * @since 0.2.0
 */

import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { findFleetRoot } from '@declaragent/core';
import { BuilderScopeError } from './types.js';

const AGENT_MANIFEST_FILENAME = 'agent.yaml';
const FLEET_MANIFEST_FILENAME = 'fleet.yaml';

/**
 * Walk up from `cwd` looking for an `agent.yaml`. Returns the absolute
 * directory containing it, or `undefined` when the walk hits the fs
 * root. Mirrors the shape of `findFleetRoot` in core.
 */
export async function findAgentRoot(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);
  // Cap the walk at a sane depth so a bogus cwd can never hang the tool.
  for (let i = 0; i < 64; i++) {
    try {
      await access(join(dir, AGENT_MANIFEST_FILENAME));
      return dir;
    } catch {
      // fall through
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve the session's scope root — nearest fleet > nearest agent >
 * cwd. Called once on session startup; builder tools cache the result.
 */
export async function resolveScopeRoot(cwd: string): Promise<string> {
  const fleet = await findFleetRoot(cwd);
  if (fleet) return fleet;
  const agent = await findAgentRoot(cwd);
  if (agent) return agent;
  return resolve(cwd);
}

/**
 * Sync variant of {@link resolveScopeRoot} for call-sites that need an
 * answer synchronously (notably React component init, where tools are
 * constructed before the first render). Walks up the tree using
 * `existsSync` — negligibly slower than `access`, acceptable for a
 * one-shot lookup at session startup.
 */
export function resolveScopeRootSync(cwd: string): string {
  let dir = resolve(cwd);
  // Pass 1: nearest fleet root wins.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, FLEET_MANIFEST_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Pass 2: nearest agent root.
  dir = resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, AGENT_MANIFEST_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd);
}

export interface ScopeCheckOptions {
  confirmOutsideScope?: boolean;
}

/**
 * Strictly check that `path` lives at or beneath `scopeRoot`. Equal is
 * allowed (writing into the scope root itself). Uses `path.sep` to
 * avoid the classic prefix bug where `/foo` "starts with" `/foo-bar`.
 */
export function isWithinScope(pathArg: string, scopeRoot: string): boolean {
  const abs = isAbsolute(pathArg) ? pathArg : resolve(pathArg);
  const rootAbs = resolve(scopeRoot);
  if (abs === rootAbs) return true;
  const rootWithSep = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  return abs.startsWith(rootWithSep);
}

export function assertWithinScope(
  pathArg: string,
  scopeRoot: string,
  options: ScopeCheckOptions = {},
): void {
  if (options.confirmOutsideScope === true) return;
  if (isWithinScope(pathArg, scopeRoot)) return;
  const abs = isAbsolute(pathArg) ? pathArg : resolve(pathArg);
  throw new BuilderScopeError(abs, resolve(scopeRoot));
}

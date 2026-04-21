/**
 * `DeclaraAddPlugin` builder tool — install a local plugin into the
 * **user-global** plugin store at `~/.declaragent/plugins.json`.
 * Mirrors `declaragent plugin install <path>` from `plugin-cli.ts`,
 * with the consent gate satisfied by the proposal flow itself (the
 * user sees the plugin's permissions in the proposal preview, then
 * `/yes` = consent).
 *
 * **Scope note.** The plugin directory is typically outside the
 * agent scope — a global npm package, a sibling repo — so
 * `confirmOutsideScope` defaults to `true` for this tool's path
 * check (other builder tools default to `false`). The tool still
 * reports the resolved path in its output so the user sees where
 * the consent applies.
 *
 * Behaviour:
 *   1. Resolve `pluginPath` (relative → absolute from CWD).
 *   2. `loadPluginManifest(dir)` — the core loader validates
 *      `plugin.json` and rejects anything malformed / missing
 *      required fields.
 *   3. Reject duplicate plugin names (store's `add()` silently
 *      replaces; the builder surfaces it so the user opts in).
 *   4. Record the manifest's declared permissions as
 *      `consentedPermissions` with an ISO timestamp — this is the
 *      "user said yes to the proposal" handoff.
 *
 * @since 0.4.0
 */

import { resolve } from 'node:path';
import {
  type PluginManifest,
  PluginManifestError,
  type PluginStore,
  createPluginStore,
  loadPluginManifest,
} from '@declaragent/core';
import type { Tool, ToolEvent } from '@declaragent/core';
import { pluginStorePath } from '../paths.js';
import {
  type AddPluginInput,
  type AddPluginOutput,
  BuilderConflictError,
  BuilderValidationError,
  addPluginInputSchema,
  formatZodError,
} from './types.js';

// ── Internal runner (exported for tests) ───────────────────────────────

export interface RunAddPluginOptions {
  /** Override the store — tests inject a tmp-file-backed store. */
  store?: PluginStore;
  /** Override the store path when tests still want a real store. */
  storePath?: string;
  /** ISO timestamp factory. Tests pin this for deterministic `installedAt`. */
  now?: () => string;
}

export async function runAddPlugin(
  input: AddPluginInput,
  options: RunAddPluginOptions = {},
): Promise<AddPluginOutput> {
  const dir = resolve(input.pluginPath);
  const path = options.storePath ?? pluginStorePath();
  const store = options.store ?? createPluginStore(path);
  const now = options.now ?? (() => new Date().toISOString());

  let manifest: PluginManifest;
  try {
    manifest = await loadPluginManifest(dir);
  } catch (err) {
    if (err instanceof PluginManifestError) {
      throw new BuilderValidationError(`plugin manifest at ${dir} is invalid: ${err.message}`);
    }
    throw err;
  }

  const existing = await store.get(manifest.name);
  if (existing) {
    throw new BuilderConflictError(
      `plugin "${manifest.name}" is already installed (from ${existing.dir}). ` +
        `Remove it first with \`declaragent plugin remove ${manifest.name}\` or edit the entry directly.`,
    );
  }

  const timestamp = now();
  await store.add({
    name: manifest.name,
    version: manifest.version,
    dir,
    installedAt: timestamp,
    ...(manifest.permissions.length > 0
      ? {
          consentedPermissions: [...manifest.permissions],
          consentedAt: timestamp,
        }
      : {}),
  });

  return {
    ok: true,
    name: manifest.name,
    version: manifest.version,
    dir,
    pluginStorePath: path,
    writes: [path],
    consentedPermissions: manifest.permissions,
    hint: buildHint(manifest, dir),
  };
}

function buildHint(manifest: PluginManifest, dir: string): string {
  const perms =
    manifest.permissions.length > 0
      ? ` The proposal recorded consent for ${manifest.permissions.length} permission(s): ${manifest.permissions.join(', ')}.`
      : ' (no permissions declared).';
  const contrib: string[] = [];
  if (manifest.contributes.tools.length > 0)
    contrib.push(`${manifest.contributes.tools.length} tool(s)`);
  if (manifest.contributes.skills.length > 0)
    contrib.push(`${manifest.contributes.skills.length} skill(s)`);
  if (manifest.contributes.mcpServers.length > 0)
    contrib.push(`${manifest.contributes.mcpServers.length} mcp server(s)`);
  if (manifest.contributes.hooks.length > 0)
    contrib.push(`${manifest.contributes.hooks.length} hook(s)`);
  if (manifest.contributes.commands.length > 0)
    contrib.push(`${manifest.contributes.commands.length} command(s)`);
  const contribText =
    contrib.length > 0 ? ` Contributes ${contrib.join(', ')}.` : ' No contributions declared.';
  return `Installed ${manifest.name}@${manifest.version} from ${dir}.${contribText}${perms} Plugins are loaded user-globally — restart \`declaragent\` so the new contributions register.`;
}

// ── Public Tool ────────────────────────────────────────────────────────

export interface DeclaraAddPluginContext {
  scopeRoot: string;
}

export function createAddPluginTool(
  ctx: DeclaraAddPluginContext,
): Tool<AddPluginInput, AddPluginOutput> {
  return {
    name: 'DeclaraAddPlugin',
    description:
      'Install a local plugin (path to a directory containing plugin.json) into the user-global ' +
      "~/.declaragent/plugins.json store. Records the manifest's declared permissions as " +
      'consented — the user grants consent by approving the surrounding proposal. Plugins are ' +
      'NOT per-agent.',
    inputSchema: {
      type: 'object',
      properties: {
        pluginPath: {
          type: 'string',
          description:
            'Absolute or relative path to the plugin directory (must contain plugin.json).',
        },
        confirmOutsideScope: { type: 'boolean', default: true },
      },
      required: ['pluginPath'],
    },
    readonly: false,
    permissionKey(input) {
      return `${ctx.scopeRoot}:plugin:${resolve(input.pluginPath)}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<AddPluginOutput>> {
      const parsed = addPluginInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAddPlugin: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        if (toolCtx.abortSignal.aborted) {
          yield { type: 'error', error: { code: 'ABORTED', message: 'DeclaraAddPlugin aborted' } };
          return;
        }
        const out = await runAddPlugin(parsed.data);
        yield { type: 'result', output: out };
      } catch (err) {
        yield {
          type: 'error',
          error: {
            code:
              err && typeof err === 'object' && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'E_BUILDER',
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
        };
      }
    },
  };
}

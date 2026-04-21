/**
 * `DeclaraAddMCP` builder tool — register an MCP server in the
 * **user-global** config at `~/.declaragent/mcp-servers.json`. Mirrors
 * the `declaragent mcp add` CLI verb so a builder conversation and a
 * shell invocation land the same entry.
 *
 * **Scope note.** Like channels, MCP servers are user-global — not
 * per-agent. The hint + proposal preview mention this so the user
 * isn't surprised that authoring from inside one agent's scope root
 * actually edits a shared store.
 *
 * Behaviour:
 *   1. Resolve the store (default `mcpConfigPath()`; tests inject).
 *   2. Reject a duplicate `name` — the CLI verb silently replaces,
 *      but the builder flow is proposal-driven, and "would overwrite
 *      your existing `foo` server" is a surprise the user should get
 *      to confirm explicitly via DeclaraApplyChange-then-remove.
 *   3. Write the spec via the shared `MCPConfigStore`.
 *
 * @since 0.4.0
 */

import type { PluginMCPServerSpec, Tool, ToolEvent } from '@declaragent/core';
import { type MCPConfigStore, createMCPConfigStore } from '../mcp-config.js';
import { mcpConfigPath } from '../paths.js';
import {
  type AddMCPInput,
  type AddMCPOutput,
  BuilderConflictError,
  addMCPInputSchema,
  formatZodError,
} from './types.js';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

// ── Internal runner (exported for tests) ───────────────────────────────

export interface RunAddMCPOptions {
  /** Override the store — tests pass a tmp-file-backed store. */
  store?: MCPConfigStore;
  /** Override the store path for tests that still want a real store. */
  configPath?: string;
}

export async function runAddMCP(
  input: AddMCPInput,
  options: RunAddMCPOptions = {},
): Promise<AddMCPOutput> {
  const path = options.configPath ?? mcpConfigPath();
  const store = options.store ?? createMCPConfigStore(path);

  const existing = await store.get(input.name);
  if (existing) {
    throw new BuilderConflictError(
      `MCP server "${input.name}" already registered. Remove it first with \`declaragent mcp remove ${input.name}\` or pick a different name.`,
    );
  }

  const spec: PluginMCPServerSpec = {
    name: input.name,
    transport: {
      type: 'stdio',
      command: input.command,
      ...(input.args && input.args.length > 0 && { args: [...input.args] }),
      ...(input.env && Object.keys(input.env).length > 0 && { env: { ...input.env } }),
    },
    protocolVersion: input.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
  };

  await store.add(spec);

  return {
    ok: true,
    name: input.name,
    mcpConfigPath: path,
    writes: [path],
    toolPrefix: `mcp__${input.name}__`,
    hint: `Registered MCP server "${input.name}" in ${path}. Tools from this server appear as \`mcp__${input.name}__<tool>\` once the REPL restarts. MCP config is user-global, not per-agent — the server is shared across every scaffold you run from this machine.`,
  };
}

// ── Public Tool ────────────────────────────────────────────────────────

export interface DeclaraAddMCPContext {
  scopeRoot: string;
}

export function createAddMCPTool(ctx: DeclaraAddMCPContext): Tool<AddMCPInput, AddMCPOutput> {
  return {
    name: 'DeclaraAddMCP',
    description:
      'Register an MCP server (stdio transport) in the user-global ~/.declaragent/mcp-servers.json. ' +
      'Tools from the server become available under the `mcp__<name>__<tool>` namespace once the ' +
      'REPL restarts. Not written inside the agent scope root — MCP config is shared across agents.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9_-]*$',
          description: 'Short name — namespaces contributed tools as mcp__<name>__<tool>.',
        },
        command: {
          type: 'string',
          description: 'Absolute path or PATH-resolvable binary for the stdio MCP server.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command-line args passed to the binary.',
        },
        env: {
          type: 'object',
          description: 'Env vars layered on top of process env when spawning the server.',
          additionalProperties: { type: 'string' },
        },
        protocolVersion: {
          type: 'string',
          description: 'MCP protocol version. Defaults to 2024-11-05.',
        },
      },
      required: ['name', 'command'],
    },
    readonly: false,
    permissionKey(input) {
      return `${ctx.scopeRoot}:mcp:${input.name}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<AddMCPOutput>> {
      const parsed = addMCPInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAddMCP: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        if (toolCtx.abortSignal.aborted) {
          yield { type: 'error', error: { code: 'ABORTED', message: 'DeclaraAddMCP aborted' } };
          return;
        }
        const out = await runAddMCP(parsed.data);
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

/**
 * `DeclaraAddChannel` builder tool — register a channel (slack / telegram /
 * discord / whatsapp) in the **user-global** channels config at
 * `~/.declaragent/channels.json`. See USABILITY_PLAN.md Phase B (P1).
 *
 * **Scope note.** Unlike sources (which live per-agent), channels are
 * loaded globally by the daemon + REPL. Authoring them from inside a
 * builder conversation about one agent therefore writes outside the
 * current scope root — intentionally. The tool surfaces this in its
 * hint so the user isn't surprised; the proposal preview carries the
 * same language.
 *
 * Behaviour:
 *   1. Load (or synthesise) `~/.declaragent/channels.json` with the
 *      canonical shape `{ version: 1, channels: [...] }`.
 *   2. Reject duplicate `id`s (same as core's `normalizeChannelObjects`).
 *   3. Append the new entry with `{ type, id, ...config }`.
 *   4. Round-trip through `loadChannelsConfig` so a structurally
 *      broken result never lands on disk. Adapter-level validation
 *      (`validateChannelsConfig`) stays in the `channels validate`
 *      verb — it depends on adapter discovery, which the builder
 *      doesn't pay for in-loop.
 *
 * @since 0.4.0
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import type { Tool, ToolEvent } from '@declaragent/core';
import { channelsConfigPath } from '../paths.js';
import {
  type AddChannelInput,
  type AddChannelOutput,
  BuilderConflictError,
  BuilderValidationError,
  addChannelInputSchema,
  formatZodError,
} from './types.js';

// ── Internal runner (exported for tests) ───────────────────────────────

export interface RunAddChannelOptions {
  /** Override the config path — tests point this at a tmp file. */
  configPath?: string;
}

interface ChannelsFile {
  version: 1;
  channels: Array<Record<string, unknown>>;
}

export async function runAddChannel(
  input: AddChannelInput,
  options: RunAddChannelOptions = {},
): Promise<AddChannelOutput> {
  const path = options.configPath ?? channelsConfigPath();
  const { prior, existing } = await loadPrior(path);

  for (const [i, ch] of existing.channels.entries()) {
    if (ch.id === input.id) {
      throw new BuilderConflictError(
        `channels config already has a channel with id "${input.id}" (channels[${i}]). Pick a different id or edit ${path} directly.`,
      );
    }
  }

  const newEntry: Record<string, unknown> = {
    type: input.type,
    id: input.id,
    ...input.config,
  };
  // Defend against the input.config smuggling its own id / type that
  // disagrees with the top-level fields — last-writer wins via spread,
  // but we want the caller's stated id to be authoritative.
  newEntry.type = input.type;
  newEntry.id = input.id;

  const next: ChannelsFile = {
    version: 1,
    channels: [...existing.channels, newEntry],
  };

  // Inline structural validation before we touch disk. We can't call
  // `loadChannelsConfig` here because it eagerly resolves
  // `${env:…}` / `${secret:…}` refs against the host environment —
  // correct at runtime, wrong at authoring time when the user is
  // reserving slots (the very values they'll wire in later haven't
  // been set yet).
  assertChannelsShape(next, path);

  const nextJson = `${JSON.stringify(next, null, 2)}\n`;
  await writeFile(path, nextJson, 'utf-8');

  // Round-trip sanity: read what we just wrote + re-validate the
  // shape. Cheap defence against fs-level corruption or a stray
  // `writeFile` race.
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    assertChannelsShape(parsed, path);
  } catch (err) {
    if (prior === undefined) {
      await unlink(path).catch(() => {});
    } else {
      await writeFile(path, prior, 'utf-8');
    }
    throw new BuilderValidationError(
      `channels config would fail to load: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    ok: true,
    type: input.type,
    id: input.id,
    channelsPath: path,
    writes: [path],
    hint: buildHint(input.type, input.id, path),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Structural check that mirrors `normalizeChannelObjects` in core —
 * each entry has non-empty `type` + non-empty `id`, and ids are unique.
 * Keeps the builder fast (no secret resolution) while still catching
 * the shape mistakes the runtime loader would reject.
 */
function assertChannelsShape(value: unknown, path: string): void {
  const obj = value as { version?: unknown; channels?: unknown } | null;
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.channels)) {
    throw new BuilderValidationError(`channels config at ${path} must have a "channels" array`);
  }
  const seen = new Set<string>();
  for (const [i, entry] of (obj.channels as unknown[]).entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new BuilderValidationError(`channels[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || e.type.length === 0) {
      throw new BuilderValidationError(`channels[${i}].type must be a non-empty string`);
    }
    if (typeof e.id !== 'string' || e.id.length === 0) {
      throw new BuilderValidationError(`channels[${i}].id must be a non-empty string`);
    }
    if (seen.has(e.id)) {
      throw new BuilderValidationError(
        `channels[${i}].id "${e.id}" is duplicated; channel ids must be unique`,
      );
    }
    seen.add(e.id);
  }
}

interface LoadPriorResult {
  prior: string | undefined;
  existing: ChannelsFile;
}

async function loadPrior(path: string): Promise<LoadPriorResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { prior: undefined, existing: { version: 1, channels: [] } };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BuilderValidationError(
      `channels config is not valid JSON (${path}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Accept both the canonical and terse shapes that core's loader
  // understands, then always re-emit canonical so downstream tools see
  // a single, predictable shape.
  if (Array.isArray(parsed)) {
    return {
      prior: raw,
      existing: { version: 1, channels: parsed as Array<Record<string, unknown>> },
    };
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { channels?: unknown; version?: unknown };
    if (Array.isArray(obj.channels)) {
      return {
        prior: raw,
        existing: {
          version: 1,
          channels: obj.channels as Array<Record<string, unknown>>,
        },
      };
    }
  }
  throw new BuilderValidationError(
    `channels config at ${path} must be either an array or an object with a "channels" array`,
  );
}

function buildHint(type: string, id: string, path: string): string {
  const playbookHint = playbookFor(type);
  return `Registered ${type} channel "${id}" in ${path}. Channels live in your user-global config, not the agent scope. Before first send: ${playbookHint} Then restart \`declaragent\` so the adapter picks up the new entry.`;
}

function playbookFor(type: string): string {
  switch (type) {
    case 'slack':
      return 'run DeclaraAuthPlaybook({ provider: "slack" }) for the token/signing-secret setup.';
    case 'telegram':
      return 'set TELEGRAM_BOT_TOKEN (from @BotFather) and restart the REPL to pick up the adapter.';
    case 'discord':
      return 'set DISCORD_BOT_TOKEN (from the Discord developer portal) and restart the REPL.';
    case 'whatsapp':
      return 'supply Meta Graph credentials (WHATSAPP_APP_ID / WHATSAPP_ACCESS_TOKEN) per the WhatsApp adapter README.';
    default:
      return 'populate the credential env vars the adapter expects.';
  }
}

// ── Public Tool ────────────────────────────────────────────────────────

export interface DeclaraAddChannelContext {
  /** Scope root — recorded only for the permission-key namespace. */
  scopeRoot: string;
}

export function createAddChannelTool(
  ctx: DeclaraAddChannelContext,
): Tool<AddChannelInput, AddChannelOutput> {
  return {
    name: 'DeclaraAddChannel',
    description:
      'Register a user-facing channel (slack, telegram, discord, whatsapp) in the user-global ' +
      '~/.declaragent/channels.json. NOT written inside the agent scope root — channels are ' +
      'loaded once per user, shared across agents. Structural validation runs post-write; ' +
      'adapter-level checks stay in `declaragent channels validate`.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['slack', 'telegram', 'discord', 'whatsapp'],
        },
        id: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9_-]*$',
          description: 'Stable channel id — must be unique across the user config.',
        },
        config: {
          type: 'object',
          description:
            'Adapter-specific config. Slack: { token, signingSecret, ... }. Telegram: { botToken, ... }. See the channel adapter README for the required keys.',
        },
        confirmOutsideScope: { type: 'boolean', default: false },
      },
      required: ['type', 'id', 'config'],
    },
    readonly: false,
    permissionKey(input) {
      // Scope root is part of the key so permissions can differentiate
      // which session the channel edit was proposed from; the target
      // file itself is always user-global.
      return `${ctx.scopeRoot}:${input.type}:${input.id}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<AddChannelOutput>> {
      const parsed = addChannelInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAddChannel: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        if (toolCtx.abortSignal.aborted) {
          yield {
            type: 'error',
            error: { code: 'ABORTED', message: 'DeclaraAddChannel aborted' },
          };
          return;
        }
        const out = await runAddChannel(parsed.data);
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

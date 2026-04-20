/**
 * `channels.yaml` / `channels.json` loader (slice 3).
 *
 * Top-level accepts either:
 *   - `{ version: 1, channels: [{ id, type, ...rest }] }`  — canonical Phase-5 shape
 *   - `[{ type, config }]`                                  — Phase-4-style terse form
 *
 * Both normalize to `ConfiguredChannel[]` where each entry has a
 * `{ type, config }` pair; the adapter receives `config` and is
 * responsible for its own semantic validation via `validateConfig`.
 *
 * Two substitution passes run:
 *   1. `${channel:...}` pseudo-variables are stashed behind UUID
 *      sentinels so the default secret resolver doesn't error on an
 *      unknown scheme. The adapter / normalizer interprets them later.
 *   2. `${env:...}` / `${file:...}` refs are expanded via the Phase-4
 *      secret resolver (which also substitutes inside nested strings).
 * Sentinels are restored to their literal form before returning.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type CreateSecretResolverOptions,
  createDefaultSecretResolver,
} from '../events/secret-resolver.js';
import type { ChannelAdapter } from './types.js';

export class ChannelsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelsConfigError';
  }
}

/**
 * Normalized configured-channel entry. `config` carries the adapter-
 * specific shape alongside shared fields (`id`, `routing`, `delivery`,
 * `limits`, `permissions`, `outbound`). The adapter's `validateConfig`
 * decides whether the shape is acceptable.
 */
export interface ConfiguredChannel {
  type: string;
  config: Record<string, unknown>;
}

export interface LoadChannelsOptions {
  /** Absolute path to the config file. Extension drives parser (`.yaml`/`.yml`/`.json`). */
  path: string;
  /** Forwarded to the default `SecretResolver`. `fileRoot` defaults to the config file's dir. */
  secretResolver?: CreateSecretResolverOptions;
}

export interface LoadChannelsResult {
  channels: readonly ConfiguredChannel[];
  rawText: string;
  format: 'json' | 'yaml';
}

export interface ValidateChannelsOptions extends LoadChannelsOptions {
  /**
   * Adapter lookup by type. Unknown types are reported as warnings, not
   * fatal, so a partial validate against a subset of installed adapters
   * still surfaces other issues.
   */
  adapters?: Readonly<Record<string, Pick<ChannelAdapter<unknown>, 'validateConfig'>>>;
}

export interface ValidateChannelsReport {
  channels: readonly ConfiguredChannel[];
  format: 'json' | 'yaml';
  unknownTypes: readonly { index: number; type: string; id: string }[];
  errors: readonly { index: number; type: string; id: string; message: string }[];
}

// ── Pseudo-variable sentinels ───────────────────────────────────────────────

const CHANNEL_PSEUDO_PREFIX = '__CHANNEL_PSEUDO_';
const CHANNEL_PSEUDO_SUFFIX = '__';

/**
 * Walk a parsed config, replace `${channel:<name>}` tokens with sentinels
 * that won't trip the secret-resolver's scheme check. Returns the
 * stashed tokens so `restorePseudoVariables` can reverse the mapping.
 */
function stashPseudoVariables(value: unknown, stash: string[]): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(/\$\{channel:([^}]+)\}/g, (_match, name: string) => {
      const idx = stash.length;
      stash.push(name);
      return `${CHANNEL_PSEUDO_PREFIX}${idx}${CHANNEL_PSEUDO_SUFFIX}`;
    });
  }
  if (Array.isArray(value)) return value.map((v) => stashPseudoVariables(v, stash));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stashPseudoVariables(v, stash);
    }
    return out;
  }
  return value;
}

function restorePseudoVariables(value: unknown, stash: readonly string[]): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(
      /__CHANNEL_PSEUDO_(\d+)__/g,
      (_match, index: string) => `\${channel:${stash[Number.parseInt(index, 10)] ?? ''}}`,
    );
  }
  if (Array.isArray(value)) return value.map((v) => restorePseudoVariables(v, stash));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = restorePseudoVariables(v, stash);
    }
    return out;
  }
  return value;
}

// ── Parsing ────────────────────────────────────────────────────────────────

function detectFormat(path: string): 'json' | 'yaml' {
  const ext = extname(path).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  return 'json';
}

function parseConfigText(text: string, format: 'json' | 'yaml'): unknown {
  try {
    if (format === 'json') return JSON.parse(text);
    return parseYaml(text);
  } catch (err) {
    throw new ChannelsConfigError(
      `malformed ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function normalizeChannels(value: unknown): ConfiguredChannel[] {
  // Plain array form — Phase-4 style.
  if (Array.isArray(value)) return normalizeArray(value);

  if (value && typeof value === 'object') {
    const v = value as { version?: unknown; channels?: unknown };
    if (v.channels !== undefined) {
      if (!Array.isArray(v.channels)) {
        throw new ChannelsConfigError(
          `top-level "channels" must be an array (got ${typeof v.channels})`,
        );
      }
      return normalizeChannelObjects(v.channels);
    }
  }

  throw new ChannelsConfigError(
    'expected either an array of channels or an object with a "channels" array',
  );
}

function normalizeArray(arr: readonly unknown[]): ConfiguredChannel[] {
  const out: ConfiguredChannel[] = [];
  for (const [i, entry] of arr.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new ChannelsConfigError(`entry[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || e.type.length === 0) {
      throw new ChannelsConfigError(`entry[${i}].type must be a non-empty string`);
    }
    // If `config` is present, use the terse shape; otherwise hoist the
    // sibling fields (minus `type`) into `config`.
    if (e.config !== undefined) {
      if (typeof e.config !== 'object' || e.config === null) {
        throw new ChannelsConfigError(`entry[${i}].config must be an object when present`);
      }
      out.push({ type: e.type, config: e.config as Record<string, unknown> });
      continue;
    }
    const { type, ...rest } = e;
    void type;
    out.push({ type: e.type, config: rest });
  }
  return out;
}

function normalizeChannelObjects(arr: readonly unknown[]): ConfiguredChannel[] {
  const out: ConfiguredChannel[] = [];
  const seenIds = new Set<string>();
  for (const [i, entry] of arr.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new ChannelsConfigError(`channels[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || e.type.length === 0) {
      throw new ChannelsConfigError(`channels[${i}].type must be a non-empty string`);
    }
    if (typeof e.id !== 'string' || e.id.length === 0) {
      throw new ChannelsConfigError(`channels[${i}].id must be a non-empty string`);
    }
    if (seenIds.has(e.id)) {
      throw new ChannelsConfigError(
        `channels[${i}].id "${e.id}" is duplicated; channel ids must be unique`,
      );
    }
    seenIds.add(e.id);
    const { type, ...rest } = e;
    void type;
    out.push({ type: e.type, config: rest });
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function loadChannelsConfig(
  options: LoadChannelsOptions,
): Promise<LoadChannelsResult> {
  const format = detectFormat(options.path);
  let rawText: string;
  try {
    rawText = await readFile(options.path, 'utf-8');
  } catch (err) {
    throw new ChannelsConfigError(
      `failed to read config "${options.path}" (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const parsed = parseConfigText(rawText, format);
  const structural = normalizeChannels(parsed);

  // Stash channel: pseudo-vars so secret-resolver doesn't reject them.
  const stash: string[] = [];
  const stashed = stashPseudoVariables(structural, stash) as ConfiguredChannel[];

  const resolverOpts: CreateSecretResolverOptions = {
    ...(options.secretResolver ?? {}),
  };
  if (resolverOpts.fileRoot === undefined) {
    const dir = options.path.replace(/\/[^/]*$/, '');
    resolverOpts.fileRoot = dir;
  }
  const resolver = createDefaultSecretResolver(resolverOpts);

  const expanded: ConfiguredChannel[] = [];
  for (const [i, ch] of stashed.entries()) {
    try {
      const cfg = (await resolver.expand(ch.config)) as Record<string, unknown>;
      const restored = restorePseudoVariables(cfg, stash) as Record<string, unknown>;
      expanded.push({ type: ch.type, config: restored });
    } catch (err) {
      const id = (ch.config?.id as string | undefined) ?? '<unset>';
      throw new ChannelsConfigError(
        `channels[${i}] (type="${ch.type}", id="${id}"): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { channels: expanded, rawText, format };
}

export async function validateChannelsConfig(
  options: ValidateChannelsOptions,
): Promise<ValidateChannelsReport> {
  const loaded = await loadChannelsConfig(options);
  const unknownTypes: { index: number; type: string; id: string }[] = [];
  const errors: { index: number; type: string; id: string; message: string }[] = [];

  for (const [i, ch] of loaded.channels.entries()) {
    const id = (ch.config.id as string | undefined) ?? '<unset>';
    const adapter = options.adapters?.[ch.type];
    if (!adapter) {
      unknownTypes.push({ index: i, type: ch.type, id });
      continue;
    }
    try {
      const validate: (cfg: unknown) => void = adapter.validateConfig;
      validate(ch.config);
    } catch (err) {
      errors.push({
        index: i,
        type: ch.type,
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    channels: loaded.channels,
    format: loaded.format,
    unknownTypes,
    errors,
  };
}

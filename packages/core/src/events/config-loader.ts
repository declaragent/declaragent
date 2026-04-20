/**
 * Event-source configuration loader (slice 15).
 *
 * Supports both `event-sources.json` and `event-sources.yaml`/`.yml`.
 * Resolves `${env:...}` / `${file:...}` placeholders via the default
 * `SecretResolver`, then returns the parsed `ConfiguredSource[]` that
 * the daemon consumes.
 *
 * Validation against adapter-specific config shapes happens in two
 * places:
 *   1. Structural ("is it an array of { type, config }?") lives here.
 *   2. Semantic ("is the Kafka config's `brokers` a non-empty array?")
 *      is delegated to `adapter.validateConfig(...)`.
 *
 * The CLI's `events-config validate` command runs both by looking up
 * each entry's adapter in the provided registry.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ConfiguredSource } from './daemon.js';
import {
  type CreateSecretResolverOptions,
  createDefaultSecretResolver,
} from './secret-resolver.js';

export class EventSourcesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventSourcesConfigError';
  }
}

export interface LoadEventSourcesOptions {
  /** Absolute path to the config file. Extension decides parser (`.yaml`/`.yml`/`.json`). */
  path: string;
  /**
   * Options forwarded to the default `SecretResolver`. `fileRoot`
   * defaults to the config file's directory so `file:./secret` works
   * as a relative reference.
   */
  secretResolver?: CreateSecretResolverOptions;
}

export interface LoadEventSourcesResult {
  /** The substituted, validated source entries. */
  sources: readonly ConfiguredSource[];
  /** Raw (unsubstituted) contents for debugging + round-tripping. */
  rawText: string;
  /** Parser used (`json` or `yaml`). */
  format: 'json' | 'yaml';
}

function detectFormat(path: string): 'json' | 'yaml' {
  const ext = extname(path).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  return 'json';
}

/**
 * Parse a JSON or YAML string into a plain JS value. Throws a
 * `EventSourcesConfigError` with the original message so CLI output can
 * point at "your file isn't valid YAML" without a stack trace.
 */
function parseConfigText(text: string, format: 'json' | 'yaml'): unknown {
  try {
    if (format === 'json') return JSON.parse(text);
    return parseYaml(text);
  } catch (err) {
    throw new EventSourcesConfigError(
      `malformed ${format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validate the structural shape (array of `{ type: string, config: object }`)
 * without running adapter-specific checks.
 */
function normalizeSources(value: unknown): ConfiguredSource[] {
  if (!Array.isArray(value)) {
    throw new EventSourcesConfigError(
      `expected an array of event sources at top level, got ${Array.isArray(value) ? 'array' : typeof value}`,
    );
  }
  const out: ConfiguredSource[] = [];
  for (const [i, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new EventSourcesConfigError(`entry[${i}] is not an object`);
    }
    const e = entry as { type?: unknown; config?: unknown };
    if (typeof e.type !== 'string' || e.type.length === 0) {
      throw new EventSourcesConfigError(`entry[${i}].type must be a non-empty string`);
    }
    if (e.config !== undefined && (typeof e.config !== 'object' || e.config === null)) {
      throw new EventSourcesConfigError(`entry[${i}].config must be an object when present`);
    }
    out.push({ type: e.type, config: e.config ?? {} });
  }
  return out;
}

export async function loadEventSourcesConfig(
  options: LoadEventSourcesOptions,
): Promise<LoadEventSourcesResult> {
  const format = detectFormat(options.path);
  let rawText: string;
  try {
    rawText = await readFile(options.path, 'utf-8');
  } catch (err) {
    throw new EventSourcesConfigError(
      `failed to read config "${options.path}" (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const parsed = parseConfigText(rawText, format);
  const structural = normalizeSources(parsed);

  // Substitute `${env:...}` / `${file:...}` placeholders. We default
  // `fileRoot` to the config file's directory so relative refs work.
  const resolverOpts: CreateSecretResolverOptions = {
    ...(options.secretResolver ?? {}),
  };
  if (resolverOpts.fileRoot === undefined) {
    const dir = options.path.replace(/\/[^/]*$/, '');
    resolverOpts.fileRoot = dir;
  }
  const resolver = createDefaultSecretResolver(resolverOpts);
  const expanded: ConfiguredSource[] = [];
  for (const [i, src] of structural.entries()) {
    try {
      const cfg = (await resolver.expand(src.config)) as Record<string, unknown>;
      expanded.push({ type: src.type, config: cfg });
    } catch (err) {
      throw new EventSourcesConfigError(
        `entry[${i}] (type="${src.type}"): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { sources: expanded, rawText, format };
}

export interface ValidateEventSourcesOptions extends LoadEventSourcesOptions {
  /**
   * Adapter lookup by type. Structural load runs regardless; semantic
   * `validateConfig(...)` only runs for types registered here. Unknown
   * types are reported as warnings (not fatal) so a validate run
   * against a partial daemon still surfaces other issues.
   */
  // biome-ignore lint/suspicious/noExplicitAny: adapter value-type is intentionally loose at this seam
  adapters?: Readonly<Record<string, { validateConfig: (cfg: unknown) => void } | any>>;
}

export interface ValidateEventSourcesReport {
  sources: readonly ConfiguredSource[];
  format: 'json' | 'yaml';
  /** Entries whose type has no registered adapter — informational. */
  unknownTypes: readonly { index: number; type: string }[];
  /** Entries that failed their adapter's `validateConfig`. */
  errors: readonly { index: number; type: string; message: string }[];
}

/**
 * Load + validate a config file. Never throws on adapter-level validation
 * failures — they're collected into `errors` so the CLI can print them
 * all at once. A missing/malformed file still throws.
 */
export async function validateEventSourcesConfig(
  options: ValidateEventSourcesOptions,
): Promise<ValidateEventSourcesReport> {
  const loaded = await loadEventSourcesConfig(options);
  const unknownTypes: { index: number; type: string }[] = [];
  const errors: { index: number; type: string; message: string }[] = [];
  for (const [i, src] of loaded.sources.entries()) {
    const adapter = options.adapters?.[src.type];
    if (!adapter) {
      unknownTypes.push({ index: i, type: src.type });
      continue;
    }
    try {
      adapter.validateConfig(src.config);
    } catch (err) {
      errors.push({
        index: i,
        type: src.type,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    sources: loaded.sources,
    format: loaded.format,
    unknownTypes,
    errors,
  };
}

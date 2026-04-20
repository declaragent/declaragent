/**
 * `DeclaraAddSecret` builder tool — reserves a named env-var slot for
 * a secret **without ever accepting the value itself**. See
 * BUILDER_PLAN.md §3.8 and §5.6.
 *
 * Deviation from the plan: the plan says "writes a ref to
 * secrets.yaml + a placeholder to .env.example". In practice,
 * `@declaragent/core`'s `secretsConfigSchema` only declares secret
 * *providers* (vault-prod, aws-sm-prod, …), not individual refs;
 * individual refs resolve inline at run time via
 * `${secret:provider:path}` / `${env:VAR}`. This tool therefore:
 *
 *   1. Derives a stable env-var name from the ref (e.g.
 *      "vault:kv/data/acme/gh-token" → DECLARA_ACME_GH_TOKEN).
 *   2. Appends a commented block to `.env.example` at the scope root.
 *   3. For non-env providers, verifies `secrets.yaml` declares the
 *      named provider — otherwise the hint tells the user to declare
 *      it first.
 *   4. Returns an actionable hint the REPL renders as a system line.
 *
 * The tool never sees a secret value. If the `ref` field itself looks
 * like a pasted credential, the tool refuses via the secret-guard.
 *
 * @since 0.2.0
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Tool, ToolEvent } from '@declaragent/core';
import { parse as parseYaml } from 'yaml';
import { assertWithinScope } from './scope.js';
import { detectSecret } from './secret-guard.js';
import {
  type AddSecretInput,
  type AddSecretOutput,
  BuilderSecretLeakError,
  BuilderValidationError,
  addSecretInputSchema,
  formatZodError,
} from './types.js';

// ── Internal runner (exported for tests) ───────────────────────────────

export interface RunAddSecretOptions {
  scopeRoot: string;
}

export async function runAddSecret(
  input: AddSecretInput,
  options: RunAddSecretOptions,
): Promise<AddSecretOutput> {
  // Defence-in-depth: the pre-turn hook already redacts secrets in
  // user messages, but the tool call payload arrives through the
  // model, which could synthesise a leaked value. Refuse early.
  const leak = detectSecret(input.ref);
  if (leak) throw new BuilderSecretLeakError(leak.label);

  // Normalise the ref and validate the prefix if present.
  const { bareRef, prefixProvider } = splitRef(input.ref);
  if (prefixProvider && prefixProvider !== input.provider) {
    throw new BuilderValidationError(
      `secret ref prefix "${prefixProvider}:" does not match provider "${input.provider}"`,
    );
  }

  const agentPath = resolve(input.agentPath ?? options.scopeRoot);
  assertWithinScope(agentPath, options.scopeRoot, {
    ...(input.confirmOutsideScope !== undefined && {
      confirmOutsideScope: input.confirmOutsideScope,
    }),
  });

  // For non-env providers, verify the provider is declared in
  // secrets.yaml at the scope root. For `env`, there is no provider
  // table — env-refs resolve directly from the process environment.
  let providerHint = '';
  if (input.provider !== 'env') {
    const check = await verifyProviderDeclared(agentPath, input.provider);
    if (!check.declared) {
      providerHint = ` Warning: no provider of type "${input.provider}" is declared in ${check.checkedPath}. Run DeclaraAuthPlaybook({ provider: "${remapProviderForPlaybook(input.provider)}" }) for setup steps, then add the provider block before resolving this secret.`;
    }
  }

  const envVar = deriveEnvVar(bareRef, input.provider);
  const envExamplePath = join(agentPath, '.env.example');
  const writes: string[] = [];

  const { changed } = await appendEnvExampleEntry(envExamplePath, {
    envVar,
    ref: input.ref,
    provider: input.provider,
    ...(input.usedBy !== undefined && { usedBy: input.usedBy }),
    ...(input.tenantScope !== undefined && { tenantScope: input.tenantScope }),
  });
  if (changed) writes.push(envExamplePath);

  const hint = buildHint({
    envVar,
    provider: input.provider,
    ref: input.ref,
    agentPath,
    providerHint,
    envExampleChanged: changed,
  });

  return { ok: true, hint, envVar, writes };
}

// ── Ref parsing + env-var derivation ───────────────────────────────────

interface SplitRef {
  bareRef: string;
  prefixProvider?: string;
}

/**
 * Split an optional `provider:` prefix off the ref. We only recognise
 * prefixes that match a core provider type; otherwise assume the ref
 * is bare and a colon-containing resource path.
 */
function splitRef(ref: string): SplitRef {
  const knownPrefixes = ['env', 'vault', 'aws-sm', 'gcp-sm', 'k8s'];
  for (const prefix of knownPrefixes) {
    const needle = `${prefix}:`;
    if (ref.startsWith(needle)) {
      return { bareRef: ref.slice(needle.length), prefixProvider: prefix };
    }
  }
  return { bareRef: ref };
}

/**
 * Derive a stable env-var name from a bare ref. Rules:
 *   - Uppercase.
 *   - Non-alphanumeric runs collapse to a single `_`.
 *   - Strip leading/trailing `_`.
 *   - Strip common noise tokens (`kv`, `data`) that Vault paths use —
 *     they carry no information about what the secret *is*.
 *   - Prefix with `DECLARA_` so generated placeholders don't collide
 *     with well-known names the user might already have set.
 */
export function deriveEnvVar(bareRef: string, provider: string): string {
  const noiseTokens = new Set(['kv', 'data']);
  const parts = bareRef
    .split(/[^A-Za-z0-9]+/g)
    .filter((p) => p.length > 0)
    .filter((p) => !noiseTokens.has(p.toLowerCase()));

  if (parts.length === 0) {
    // Fall back to provider-name-only; still stable, still unique
    // enough because the user's provider + `_SECRET` suffix names it.
    return `DECLARA_${provider.toUpperCase().replace(/-/g, '_')}_SECRET`;
  }
  const body = parts
    .join('_')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
  return `DECLARA_${body}`;
}

// ── secrets.yaml provider verification ─────────────────────────────────

interface ProviderCheck {
  declared: boolean;
  checkedPath: string;
}

async function verifyProviderDeclared(agentPath: string, provider: string): Promise<ProviderCheck> {
  const candidates = ['secrets.yaml', 'secrets.yml'];
  for (const name of candidates) {
    const p = join(agentPath, name);
    try {
      const raw = await readFile(p, 'utf-8');
      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch {
        // Malformed secrets.yaml is an upstream problem — we report
        // "not declared" rather than throw, so the user sees a hint
        // instead of an opaque parse error from this tool.
        return { declared: false, checkedPath: p };
      }
      if (parsed && typeof parsed === 'object' && 'providers' in parsed) {
        const providers = (parsed as { providers?: unknown }).providers;
        if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
          for (const value of Object.values(providers as Record<string, unknown>)) {
            if (
              value &&
              typeof value === 'object' &&
              'type' in (value as Record<string, unknown>) &&
              (value as { type?: unknown }).type === provider
            ) {
              return { declared: true, checkedPath: p };
            }
          }
        }
      }
      return { declared: false, checkedPath: p };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return { declared: false, checkedPath: join(agentPath, 'secrets.yaml') };
}

function remapProviderForPlaybook(provider: string): string {
  // The 5 playbooks cover anthropic/openai/github/slack/vault. Non-env
  // core providers beyond vault don't have dedicated playbooks yet —
  // fall back to vault's, which is the most similar in shape.
  switch (provider) {
    case 'vault':
      return 'vault';
    case 'aws-sm':
    case 'gcp-sm':
    case 'k8s':
      return 'vault';
    default:
      return provider;
  }
}

// ── .env.example editing ───────────────────────────────────────────────

interface EnvExampleEntry {
  envVar: string;
  ref: string;
  provider: string;
  usedBy?: string;
  tenantScope?: string;
}

/**
 * Append a `# comment block + KEY=hint` entry to `.env.example`. We
 * preserve existing contents byte-for-byte — the append lands at the
 * end of the file. If the entry for this env var already exists,
 * return `{ changed: false }` (idempotent).
 */
export async function appendEnvExampleEntry(
  envExamplePath: string,
  entry: EnvExampleEntry,
): Promise<{ changed: boolean }> {
  let existing = '';
  try {
    existing = await readFile(envExamplePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Idempotence check — a line starting with `${envVar}=` means we've
  // already placed this entry.
  const lineRe = new RegExp(`^${escapeRegExp(entry.envVar)}=`, 'm');
  if (lineRe.test(existing)) {
    return { changed: false };
  }

  const block = renderEntryBlock(entry);
  const sep =
    existing.length === 0 || existing.endsWith('\n\n')
      ? ''
      : existing.endsWith('\n')
        ? '\n'
        : '\n\n';
  const next = existing + sep + block;
  await writeFile(envExamplePath, next, 'utf-8');
  return { changed: true };
}

function renderEntryBlock(entry: EnvExampleEntry): string {
  const lines: string[] = [];
  lines.push(`# Secret ref: ${entry.ref} (provider: ${entry.provider}).`);
  if (entry.usedBy !== undefined) {
    lines.push(`# Used by: ${entry.usedBy}.`);
  }
  if (entry.tenantScope !== undefined) {
    lines.push(`# Tenant scope: ${entry.tenantScope}.`);
  }
  if (entry.provider === 'env') {
    lines.push(`# Paste the value below — declaragent reads it via \${env:${entry.envVar}}.`);
  } else {
    lines.push(
      `# The runtime fetches the value from ${entry.provider}; this placeholder is a reminder of the slot your deployment must populate.`,
    );
  }
  lines.push(`${entry.envVar}=`);
  return `${lines.join('\n')}\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Hint composition ───────────────────────────────────────────────────

interface HintArgs {
  envVar: string;
  provider: string;
  ref: string;
  agentPath: string;
  providerHint: string;
  envExampleChanged: boolean;
}

function buildHint(args: HintArgs): string {
  const idem = args.envExampleChanged ? 'added' : 'already present in';
  const envPath = join(args.agentPath, '.env.example');
  if (args.provider === 'env') {
    return (
      `Placeholder ${args.envVar} ${idem} ${envPath}. ` +
      `Set the value in .env (e.g. ${args.envVar}=…) — declaragent reads it via ` +
      `\${env:${args.envVar}} at run time.${args.providerHint}`
    );
  }
  return (
    `Placeholder ${args.envVar} ${idem} ${envPath}. ` +
    `At run time the agent resolves ${args.ref} from the "${args.provider}" provider ` +
    `declared in secrets.yaml; use \${secret:<provider-id>:${refTail(args.ref)}} ` +
    `in your skills / sources / channels.${args.providerHint}`
  );
}

function refTail(ref: string): string {
  const idx = ref.indexOf(':');
  return idx === -1 ? ref : ref.slice(idx + 1);
}

// ── Public Tool ────────────────────────────────────────────────────────

export interface DeclaraAddSecretContext {
  scopeRoot: string;
}

export function createAddSecretTool(
  ctx: DeclaraAddSecretContext,
): Tool<AddSecretInput, AddSecretOutput> {
  return {
    name: 'DeclaraAddSecret',
    description:
      'Reserve a secret slot without ever accepting the value. Derives an env-var name ' +
      'from the ref, appends a commented placeholder to .env.example, and returns a hint ' +
      'the REPL surfaces to the user. Refuses to run if the ref itself looks like a leaked value.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Secret reference (e.g. vault:kv/data/my/secret or just SECRET_NAME).',
        },
        provider: { type: 'string', enum: ['env', 'vault', 'aws-sm', 'gcp-sm', 'k8s'] },
        usedBy: { type: 'string', description: 'Which tool / source / channel consumes this.' },
        tenantScope: { type: 'string', description: 'Restrict resolution to this tenant.' },
        agentPath: { type: 'string' },
        confirmOutsideScope: { type: 'boolean', default: false },
      },
      required: ['ref', 'provider'],
    },
    readonly: false,
    permissionKey(input) {
      const scopeKey =
        input.agentPath !== undefined
          ? relative(ctx.scopeRoot, resolve(input.agentPath)) || '.'
          : '.';
      return `${scopeKey}:${input.provider}:${input.ref}`;
    },
    async *execute(input, toolCtx): AsyncIterable<ToolEvent<AddSecretOutput>> {
      const parsed = addSecretInputSchema.safeParse(input);
      if (!parsed.success) {
        yield {
          type: 'error',
          error: {
            code: 'E_BUILDER_VALIDATION',
            message: `DeclaraAddSecret: ${formatZodError(parsed.error)}`,
          },
        };
        return;
      }
      try {
        if (toolCtx.abortSignal.aborted) {
          yield { type: 'error', error: { code: 'ABORTED', message: 'DeclaraAddSecret aborted' } };
          return;
        }
        const out = await runAddSecret(parsed.data, { scopeRoot: ctx.scopeRoot });
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

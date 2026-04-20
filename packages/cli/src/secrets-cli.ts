import { existsSync } from 'node:fs';
import type { LoadSecretsResult, SecretProvider, TenantAuditSink } from '@declaragent/core';
import { DEFAULT_TENANT_CONTEXT, SecretsConfigError, loadSecretsConfig } from '@declaragent/core';
import { createSqliteAuditSink } from '@declaragent/core';
import { auditDbPath, secretsConfigPath } from './paths.js';

export interface SecretsCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: SecretsCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface SecretsCliDeps {
  io?: SecretsCliIO;
  /** Path override; defaults to `${configDir}/secrets.yaml`. */
  configPath?: string;
  /** Injected loader for tests. */
  load?: (path: string) => Promise<LoadSecretsResult>;
  /** Audit DB path; defaults to `${configDir}/audit.db`. */
  auditDb?: string;
  /** Factory for the audit sink used by `rotate`. */
  openAuditSink?: (path: string) => Promise<TenantAuditSink>;
  /** Clock override used by `rotate`'s audit record. */
  now?: () => number;
}

async function loadOrExplain(
  deps: SecretsCliDeps,
  io: SecretsCliIO,
): Promise<LoadSecretsResult | 1> {
  const path = deps.configPath ?? secretsConfigPath();
  if (!deps.load && !existsSync(path)) {
    io.err(`✗ no secrets config found at "${path}". Create \`secrets.yaml\` in the config dir.\n`);
    return 1;
  }
  try {
    const loader = deps.load ?? ((p) => loadSecretsConfig({ path: p }));
    return await loader(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to load secrets config: ${msg}\n`);
    return 1;
  }
}

export interface SecretsListArgs {
  /** Optional provider filter — only list refs visible to this provider. */
  provider?: string;
  json?: boolean;
}

/** `declaragent secrets list [--provider <name>] [--json]` */
export async function secretsList(
  args: SecretsListArgs = {},
  deps: SecretsCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const loaded = await loadOrExplain(deps, io);
  if (loaded === 1) return 1;

  const providers = loaded.providers.filter(
    (p) => args.provider === undefined || p.name === args.provider,
  );

  if (args.provider !== undefined && providers.length === 0) {
    io.err(`✗ provider "${args.provider}" is not declared in secrets.yaml\n`);
    return 1;
  }

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          default: loaded.defaultProviderType,
          providers: providers.map((p) => ({ name: p.name, type: p.type })),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (loaded.defaultProviderType) {
    io.out(`default provider type: ${loaded.defaultProviderType}\n`);
  }
  io.out(`providers (${providers.length}):\n`);
  for (const p of providers) {
    io.out(`  • ${p.name} (${p.type})\n`);
  }
  io.out(
    '\nnote: enumerating individual refs visible to each provider is provider-specific and lands in slice 0.5.\n',
  );
  return 0;
}

/** Parse a secret ref of the form `"<providerName>:<path>"` or just `<path>` (for the default provider). */
function splitRef(ref: string): { providerName?: string; path: string } {
  const idx = ref.indexOf(':');
  if (idx <= 0) return { path: ref };
  return { providerName: ref.slice(0, idx), path: ref.slice(idx + 1) };
}

function resolveProvider(
  loaded: LoadSecretsResult,
  providerName?: string,
): SecretProvider | undefined {
  if (providerName) return loaded.providers.find((p) => p.name === providerName);
  if (!loaded.defaultProviderType) return undefined;
  return loaded.providers.find((p) => p.type === loaded.defaultProviderType);
}

export interface SecretsDescribeArgs {
  ref: string;
  json?: boolean;
}

/** `declaragent secrets describe <ref> [--json]` */
export async function secretsDescribe(
  args: SecretsDescribeArgs,
  deps: SecretsCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const loaded = await loadOrExplain(deps, io);
  if (loaded === 1) return 1;

  const { providerName, path } = splitRef(args.ref);
  const provider = resolveProvider(loaded, providerName);
  if (!provider) {
    io.err(
      `✗ no provider found for ref "${args.ref}"${
        providerName ? '' : ' and no default configured in secrets.yaml'
      }\n`,
    );
    return 1;
  }

  try {
    let metadata: Awaited<ReturnType<NonNullable<SecretProvider['metadata']>>> | undefined;
    if (provider.metadata) {
      metadata = await provider.metadata(path, {
        tenant: DEFAULT_TENANT_CONTEXT,
        requester: 'cli:secrets-describe',
      });
    }
    const shape = {
      ref: args.ref,
      provider: { name: provider.name, type: provider.type },
      path,
      metadata: metadata ?? null,
      supportsMetadata: provider.metadata !== undefined,
    };
    if (args.json) {
      io.out(`${JSON.stringify(shape, null, 2)}\n`);
      return 0;
    }
    io.out(`ref:      ${args.ref}\n`);
    io.out(`provider: ${provider.name} (${provider.type})\n`);
    io.out(`path:     ${path}\n`);
    if (!provider.metadata) {
      io.out(`metadata: (not supported by the ${provider.type} provider)\n`);
      return 0;
    }
    if (!metadata || Object.keys(metadata).length === 0) {
      io.out('metadata: (provider returned no metadata for this ref)\n');
      return 0;
    }
    io.out('metadata:\n');
    if (metadata.version !== undefined) io.out(`  version:         ${metadata.version}\n`);
    if (metadata.ttlMs !== undefined) io.out(`  ttlMs:           ${metadata.ttlMs}\n`);
    if (metadata.lastRotatedAt !== undefined) {
      io.out(`  lastRotatedAt:   ${new Date(metadata.lastRotatedAt).toISOString()}\n`);
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ describe failed: ${msg}\n`);
    return 1;
  }
}

export interface SecretsRotateArgs {
  ref: string;
  tenant?: string;
  reason?: string;
  json?: boolean;
}

/**
 * `declaragent secrets rotate <ref> [--tenant X] [--reason R] [--json]`
 *
 * Real rotation is provider-owned (Vault rotates itself, AWS-SM has
 * its own rotation pipeline, etc.). The CLI's role in v1.0 is to:
 *   1. Verify the provider + ref are reachable.
 *   2. Emit a `secret_access` audit record with `outcome: 'resolved'`
 *      so the rotation moment is traceable.
 *
 * Provider-delegated rotation APIs land in slice 0.5 once the provider
 * interface gains a `rotate()` hook.
 */
export async function secretsRotate(
  args: SecretsRotateArgs,
  deps: SecretsCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const loaded = await loadOrExplain(deps, io);
  if (loaded === 1) return 1;

  const { providerName, path } = splitRef(args.ref);
  const provider = resolveProvider(loaded, providerName);
  if (!provider) {
    io.err(`✗ no provider found for ref "${args.ref}"\n`);
    return 1;
  }

  // Resolve once to prove reachability. A resolver error is a clear
  // "rotate aborted" signal rather than a silent audit record.
  try {
    await provider.resolve(path, {
      tenant: {
        ...DEFAULT_TENANT_CONTEXT,
        ...(args.tenant !== undefined && { id: args.tenant }),
      },
      requester: 'cli:secrets-rotate',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ rotate aborted: resolve failed: ${msg}\n`);
    return 1;
  }

  const tenantId = args.tenant ?? DEFAULT_TENANT_CONTEXT.id;
  const now = (deps.now ?? Date.now)();
  const dbPath = deps.auditDb ?? auditDbPath();
  const opener = deps.openAuditSink ?? ((p) => createSqliteAuditSink({ path: p }));
  let sink: TenantAuditSink | undefined;
  try {
    sink = await opener(dbPath);
    await sink.record({
      kind: 'secret_access',
      ts: now,
      tenantId,
      ref: args.ref,
      requester: 'cli:secrets-rotate',
      outcome: 'resolved',
      providerType: provider.type,
      providerName: provider.name,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ rotate audit-record failed: ${msg}\n`);
    if (sink) await sink.close();
    return 1;
  } finally {
    if (sink) await sink.close();
  }

  if (args.json) {
    io.out(
      `${JSON.stringify(
        {
          rotated: true,
          ref: args.ref,
          providerName: provider.name,
          providerType: provider.type,
          tenantId,
          ts: now,
          auditRecorded: true,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  io.out(
    `✓ rotation recorded for ref "${args.ref}" via ${provider.name} (${provider.type}), tenant=${tenantId}.\n`,
  );
  io.out(
    '  note: real rotation is provider-owned; this CLI verifies reachability + records an audit entry only.\n',
  );
  return 0;
}

export { SecretsConfigError };

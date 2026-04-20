import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { renderDockerfile, renderDockerignore } from './deploy-dockerfile.js';
import {
  extractSecretRefs,
  renderServiceYaml,
  sanitizeServiceName,
} from './deploy-service-yaml.js';

export interface DeployCliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const STDIO_IO: DeployCliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export interface DeployFS {
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  mkdir: (path: string) => void;
  exists: (path: string) => boolean;
}

const DEFAULT_FS: DeployFS = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c, 'utf8');
  },
  mkdir: (p) => {
    mkdirSync(p, { recursive: true });
  },
  exists: (p) => existsSync(p),
};

export interface DeployGcloudResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DeployFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export interface DeployCliDeps {
  io?: DeployCliIO;
  fs?: DeployFS;
  /** Shell hook for `--verify`. Provide to stub `gcloud` invocations in tests. */
  gcloud?: (args: string[]) => Promise<DeployGcloudResult>;
  /** Health-check hook; defaults to the global `fetch`. */
  fetch?: (url: string) => Promise<DeployFetchResponse>;
}

export interface DeployGcpCloudRunArgs {
  /** Defaults to `./agent.yaml`. */
  agentYamlPath?: string;
  /** Defaults to `./.declaragent/deploy`. */
  outDir?: string;
  /** Overwrite existing artifacts. */
  force?: boolean;
  /** GCP project id — required only for a real image ref; falls back to placeholder. */
  project?: string;
  /** Cloud Run region; defaults to `us-central1`. */
  region?: string;
  /** Defaults to a sanitized form of `agent.yaml`'s `name`. */
  serviceName?: string;
  /** Defaults to 1 (daemon must stay warm for webhooks). */
  minInstances?: number;
  /** Defaults to 512. */
  memoryMib?: number;
  /** Defaults to 1. */
  cpu?: number;
  json?: boolean;
}

export interface ParsedDeployArgs {
  agentYamlPath: string;
  outDir: string;
  force: boolean;
  project: string;
  region: string;
  serviceName: string;
  minInstances: number;
  memoryMib: number;
  cpu: number;
  json: boolean;
}

const DEFAULT_PROJECT_PLACEHOLDER = 'YOUR_GCP_PROJECT';

/** Normalize CLI arg input into fully-resolved defaults. Exported for the orchestrator. */
export function resolveDeployArgs(
  args: DeployGcpCloudRunArgs,
  cwd: string = process.cwd(),
): ParsedDeployArgs {
  const agentYamlPath = args.agentYamlPath
    ? isAbsolute(args.agentYamlPath)
      ? args.agentYamlPath
      : resolve(cwd, args.agentYamlPath)
    : resolve(cwd, 'agent.yaml');
  const outDir = args.outDir
    ? isAbsolute(args.outDir)
      ? args.outDir
      : resolve(cwd, args.outDir)
    : resolve(cwd, '.declaragent', 'deploy');
  return {
    agentYamlPath,
    outDir,
    force: args.force ?? false,
    project: args.project ?? DEFAULT_PROJECT_PLACEHOLDER,
    region: args.region ?? 'us-central1',
    serviceName: args.serviceName ?? '',
    minInstances: args.minInstances ?? 1,
    memoryMib: args.memoryMib ?? 512,
    cpu: args.cpu ?? 1,
    json: args.json ?? false,
  };
}

interface LoadedAgent {
  raw: Record<string, unknown>;
  serviceName: string;
  concurrency: number | undefined;
}

function loadAgentYaml(fs: DeployFS, path: string, override: string): LoadedAgent {
  if (!fs.exists(path)) {
    throw new DeployError(
      `no agent.yaml found at "${path}". Run \`declaragent init\` first.`,
      'no-agent-yaml',
    );
  }
  const text = fs.readFile(path);
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeployError(`failed to parse agent.yaml: ${msg}`, 'parse-failed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeployError('agent.yaml must be a YAML mapping at the top level', 'parse-failed');
  }
  const obj = parsed as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  const resolvedName = override.length > 0 ? override : (name ?? 'declaragent');
  const concurrency = pickConcurrency(obj);
  return { raw: obj, serviceName: sanitizeServiceName(resolvedName), concurrency };
}

function pickConcurrency(agent: Record<string, unknown>): number | undefined {
  const quotas = agent.quotas as Record<string, unknown> | undefined;
  if (quotas && typeof quotas === 'object') {
    const raw = quotas.maxConcurrentToolCalls;
    if (typeof raw === 'number' && raw > 0) return Math.max(1, Math.floor(raw));
  }
  return undefined;
}

interface LoadedTenants {
  ids: string[];
}

function loadTenantsIfPresent(fs: DeployFS, agentYamlPath: string): LoadedTenants {
  const tenantsPath = join(dirname(agentYamlPath), 'tenants.yaml');
  if (!fs.exists(tenantsPath)) return { ids: [] };
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFile(tenantsPath));
  } catch {
    return { ids: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { ids: [] };
  const tenants = (parsed as Record<string, unknown>).tenants;
  if (!Array.isArray(tenants)) return { ids: [] };
  const ids: string[] = [];
  for (const t of tenants) {
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      const id = (t as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return { ids };
}

function loadChannelsIfPresent(
  fs: DeployFS,
  agentYamlPath: string,
): Array<{ id: string; type: string }> {
  const candidates = ['channels.yaml', 'channels.json'];
  for (const name of candidates) {
    const p = join(dirname(agentYamlPath), name);
    if (!fs.exists(p)) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(fs.readFile(p));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const channels = (parsed as Record<string, unknown>).channels;
    if (!Array.isArray(channels)) continue;
    const out: Array<{ id: string; type: string }> = [];
    for (const c of channels) {
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        const rec = c as Record<string, unknown>;
        const id = typeof rec.id === 'string' ? rec.id : undefined;
        const type = typeof rec.type === 'string' ? rec.type : undefined;
        if (id && type) out.push({ id, type });
      }
    }
    return out;
  }
  return [];
}

interface GeneratedArtifacts {
  dockerfilePath: string;
  dockerignorePath: string;
  serviceYamlPath: string;
  readmePath: string;
}

function renderReadme(ctx: {
  serviceName: string;
  project: string;
  region: string;
  memoryMib: number;
  cpu: number;
  minInstances: number;
}): string {
  const { serviceName, project, region, memoryMib, cpu, minInstances } = ctx;
  return `# Deploy ${serviceName} to GCP Cloud Run

Three commands:

    docker build -t gcr.io/${project}/${serviceName}:latest .
    docker push gcr.io/${project}/${serviceName}:latest
    gcloud run services replace service.yaml --region=${region}

After the third command completes, run:

    declaragent deploy gcp-cloud-run --verify --project ${project} --region ${region}

to confirm the daemon's \`/health\` endpoint is serving 200 OK.

Estimated cost: $40–$60 / month (lower bound) at cpu=${cpu}, memory=${memoryMib}MiB, minInstances=${minInstances}. Provider token costs are additive.
`;
}

/**
 * Generate Cloud Run deploy artifacts under `args.outDir` (default
 * `./.declaragent/deploy/`). Returns `0` on success, `1` on any user-facing
 * failure. Does NOT invoke `gcloud` — the user runs the three printed
 * commands themselves.
 */
export async function deployGcpCloudRun(
  args: DeployGcpCloudRunArgs = {},
  deps: DeployCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fs = deps.fs ?? DEFAULT_FS;
  const resolved = resolveDeployArgs(args);

  let loaded: LoadedAgent;
  try {
    loaded = loadAgentYaml(fs, resolved.agentYamlPath, resolved.serviceName);
  } catch (err) {
    if (err instanceof DeployError) {
      io.err(`✗ ${err.message}\n`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ deploy failed: ${msg}\n`);
    return 1;
  }

  const service = loaded.serviceName;
  const tenants = loadTenantsIfPresent(fs, resolved.agentYamlPath);
  const secretRefs = extractSecretRefs(loaded.raw);

  const artifacts: GeneratedArtifacts = {
    dockerfilePath: join(resolved.outDir, 'Dockerfile'),
    dockerignorePath: join(resolved.outDir, '.dockerignore'),
    serviceYamlPath: join(resolved.outDir, 'service.yaml'),
    readmePath: join(resolved.outDir, 'README.md'),
  };

  if (!resolved.force) {
    const collisions = Object.values(artifacts).filter((p) => fs.exists(p));
    if (collisions.length > 0) {
      io.err(
        `✗ deploy artifacts already exist at "${resolved.outDir}": ${collisions
          .map((p) => p.replace(`${resolved.outDir}/`, ''))
          .join(', ')}. Rerun with --force to overwrite.\n`,
      );
      return 1;
    }
  }

  try {
    fs.mkdir(resolved.outDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to create output directory "${resolved.outDir}": ${msg}\n`);
    return 1;
  }

  const dockerfile = renderDockerfile({});
  const dockerignore = renderDockerignore();
  const serviceYaml = renderServiceYaml({
    serviceName: service,
    project: resolved.project,
    region: resolved.region,
    cpu: resolved.cpu,
    memoryMib: resolved.memoryMib,
    minInstances: resolved.minInstances,
    ...(loaded.concurrency !== undefined && { concurrency: loaded.concurrency }),
    secretRefs,
    tenants: tenants.ids.map((id) => ({ id })),
  });
  const readme = renderReadme({
    serviceName: service,
    project: resolved.project,
    region: resolved.region,
    memoryMib: resolved.memoryMib,
    cpu: resolved.cpu,
    minInstances: resolved.minInstances,
  });

  try {
    fs.writeFile(artifacts.dockerfilePath, dockerfile);
    fs.writeFile(artifacts.dockerignorePath, dockerignore);
    fs.writeFile(artifacts.serviceYamlPath, serviceYaml);
    fs.writeFile(artifacts.readmePath, readme);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ failed to write artifacts: ${msg}\n`);
    return 1;
  }

  if (resolved.json) {
    io.out(
      `${JSON.stringify(
        {
          serviceName: service,
          project: resolved.project,
          region: resolved.region,
          outDir: resolved.outDir,
          artifacts,
          secretRefs,
          tenants: tenants.ids,
          cost: {
            lowerBoundUSD: 40,
            upperBoundUSD: 60,
            note: 'Provider token costs are additive.',
          },
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  io.out(`✓ wrote Cloud Run artifacts to ${resolved.outDir}\n`);
  io.out(`  Dockerfile      ${artifacts.dockerfilePath}\n`);
  io.out(`  .dockerignore   ${artifacts.dockerignorePath}\n`);
  io.out(`  service.yaml    ${artifacts.serviceYamlPath}\n`);
  io.out(`  README.md       ${artifacts.readmePath}\n`);
  if (secretRefs.length > 0) {
    io.out(`  secrets bound:  ${secretRefs.length} (${secretRefs.join(', ')})\n`);
  }
  if (tenants.ids.length > 0) {
    io.out(`  tenant volumes: ${tenants.ids.length} (${tenants.ids.join(', ')})\n`);
  }
  io.out('\nNext, run these three commands:\n');
  io.out(`  docker build -t gcr.io/${resolved.project}/${service}:latest .\n`);
  io.out(`  docker push gcr.io/${resolved.project}/${service}:latest\n`);
  io.out(`  gcloud run services replace service.yaml --region=${resolved.region}\n`);
  io.out(
    '\nEstimated cost: $40–$60 / month (lower bound) at the chosen resource preset. Provider token costs are additive.\n',
  );
  return 0;
}

export interface VerifyGcpCloudRunArgs {
  agentYamlPath?: string;
  project?: string;
  region?: string;
  serviceName?: string;
  json?: boolean;
}

/**
 * `declaragent deploy gcp-cloud-run --verify`: runs
 * `gcloud run services describe ...` + hits the daemon's `/health`. Returns
 * `0` on 200, `1` on any error. `gcloud` absence is a graceful fail.
 */
export async function verifyGcpCloudRunDeploy(
  args: VerifyGcpCloudRunArgs = {},
  deps: DeployCliDeps = {},
): Promise<number> {
  const io = deps.io ?? STDIO_IO;
  const fs = deps.fs ?? DEFAULT_FS;
  const region = args.region ?? 'us-central1';
  const project = args.project ?? DEFAULT_PROJECT_PLACEHOLDER;

  let service = args.serviceName ?? '';
  let channels: Array<{ id: string; type: string }> = [];
  const agentYamlPath = args.agentYamlPath
    ? isAbsolute(args.agentYamlPath)
      ? args.agentYamlPath
      : resolve(process.cwd(), args.agentYamlPath)
    : resolve(process.cwd(), 'agent.yaml');
  if (service.length === 0 && fs.exists(agentYamlPath)) {
    try {
      const loaded = loadAgentYaml(fs, agentYamlPath, '');
      service = loaded.serviceName;
    } catch {
      // fall through — service may still be supplied via flag below
    }
    channels = loadChannelsIfPresent(fs, agentYamlPath);
  }
  if (service.length === 0) {
    io.err('✗ verify requires a service name — pass --service or run from a project dir.\n');
    return 1;
  }

  if (!deps.gcloud) {
    const probe = spawnSync('gcloud', ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) {
      io.err(
        '✗ gcloud is not installed or not on $PATH. Install from https://cloud.google.com/sdk/docs/install and re-run.\n',
      );
      return 1;
    }
  }

  const runGcloud = deps.gcloud ?? ((a: string[]) => Promise.resolve(runGcloudSync(a)));

  const describe = await runGcloud([
    'run',
    'services',
    'describe',
    service,
    `--region=${region}`,
    `--project=${project}`,
    '--format=value(status.url)',
  ]);
  if (describe.code !== 0) {
    io.err(
      `✗ gcloud run services describe failed (code ${describe.code}): ${describe.stderr.trim() || describe.stdout.trim() || '(no output)'}\n`,
    );
    return 1;
  }
  const url = describe.stdout.trim();
  if (url.length === 0) {
    io.err(
      `✗ gcloud returned an empty URL for "${service}". Is the service deployed in region=${region}?\n`,
    );
    return 1;
  }

  const fetchImpl =
    deps.fetch ??
    (async (u: string) => {
      const r = await fetch(u);
      return { ok: r.ok, status: r.status, text: () => r.text() };
    });

  let health: DeployFetchResponse;
  try {
    health = await fetchImpl(`${url}/health`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`✗ health check threw: ${msg}\n`);
    return 1;
  }
  if (!health.ok || health.status !== 200) {
    io.err(`✗ ${url}/health returned ${health.status}. Deployment is not healthy yet.\n`);
    return 1;
  }

  const webhookConfig = buildWebhookSnippet(url, channels);
  if (args.json) {
    io.out(
      `${JSON.stringify(
        { url, service, region, project, health: 'ok', webhooks: webhookConfig },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  io.out(`✓ ${service} is live at ${url}\n`);
  io.out(`  health: ${url}/health returned 200\n`);
  io.out('\nWebhook configuration:\n');
  for (const line of webhookConfig) io.out(`  ${line}\n`);
  return 0;
}

function buildWebhookSnippet(url: string, channels: Array<{ id: string; type: string }>): string[] {
  if (channels.length === 0) {
    return [`generic webhook URL: ${url}/channels/<channel-id>/events`];
  }
  return channels.map((c) => `${c.type} (${c.id}) webhook URL: ${url}/channels/${c.id}/events`);
}

function runGcloudSync(args: string[]): DeployGcloudResult {
  const res = spawnSync('gcloud', args, { encoding: 'utf8' });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? res.error.message : ''),
  };
}

export class DeployError extends Error {
  constructor(
    message: string,
    readonly code: 'no-agent-yaml' | 'parse-failed' | 'overwrite-blocked',
  ) {
    super(message);
    this.name = 'DeployError';
  }
}

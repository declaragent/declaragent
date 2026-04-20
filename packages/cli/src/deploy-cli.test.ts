import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import type {
  DeployCliDeps,
  DeployCliIO,
  DeployFS,
  DeployFetchResponse,
  DeployGcloudResult,
} from './deploy-cli.js';
import { deployGcpCloudRun, verifyGcpCloudRunDeploy } from './deploy-cli.js';

function captureIo(): { io: DeployCliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    out,
    err,
  };
}

function memoryFs(initial: Record<string, string> = {}): DeployFS & {
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  for (const p of files.keys()) dirs.add(dirname(p));
  return {
    files,
    dirs,
    exists: (p) => files.has(p) || dirs.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, c) => {
      files.set(p, c);
      dirs.add(dirname(p));
    },
    mkdir: (p) => {
      dirs.add(p);
    },
  };
}

const CWD = '/work/agent';
const AGENT_YAML = `${CWD}/agent.yaml`;
const OUT_DIR = `${CWD}/.declaragent/deploy`;

const CONCIERGE_YAML = `name: concierge
model: claude-sonnet-4-5
temperature: 0
maxTokens: 2048
systemPrompt: |
  You are a Slack concierge.
tools:
  defaults:
    - Read
    - Glob
    - Grep
`;

const CONCIERGE_CHANNELS_YAML = `version: 1
channels:
  - id: concierge-slack
    type: slack
    transport:
      mode: socket
      botToken: \${secret:slack/bot_token}
      appToken: \${secret:slack/app_token}
`;

describe('deployGcpCloudRun — artifact generation', () => {
  test('writes Dockerfile + .dockerignore + service.yaml + README.md under outDir', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    const code = await deployGcpCloudRun(
      {
        agentYamlPath: AGENT_YAML,
        outDir: OUT_DIR,
        project: 'my-project',
        region: 'us-central1',
      },
      { io: cap.io, fs },
    );
    expect(code).toBe(0);
    expect(fs.files.has(join(OUT_DIR, 'Dockerfile'))).toBe(true);
    expect(fs.files.has(join(OUT_DIR, '.dockerignore'))).toBe(true);
    expect(fs.files.has(join(OUT_DIR, 'service.yaml'))).toBe(true);
    expect(fs.files.has(join(OUT_DIR, 'README.md'))).toBe(true);
    const out = cap.out.join('');
    expect(out).toContain('docker build');
    expect(out).toContain('docker push');
    expect(out).toContain('gcloud run services replace service.yaml');
    expect(out).toContain('us-central1');
  });

  test('service.yaml stamps CPU / memory / minScale + image ref', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    await deployGcpCloudRun(
      {
        agentYamlPath: AGENT_YAML,
        outDir: OUT_DIR,
        project: 'my-project',
        region: 'us-central1',
        cpu: 2,
        memoryMib: 1024,
        minInstances: 2,
      },
      { io: cap.io, fs },
    );
    const svc = fs.files.get(join(OUT_DIR, 'service.yaml')) ?? '';
    expect(svc).toContain('cpu: "2"');
    expect(svc).toContain('memory: 1024Mi');
    expect(svc).toMatch(/minScale['"]?:\s*"2"/);
    expect(svc).toContain('gcr.io/my-project/concierge:latest');
  });

  test('every ${secret:...} ref becomes a Secret Manager env var', async () => {
    const fs = memoryFs({
      [AGENT_YAML]: `name: concierge
providers:
  - token: \${secret:anthropic/api_key}
channels:
  - botToken: \${secret:slack/bot_token}
`,
    });
    const cap = captureIo();
    await deployGcpCloudRun(
      { agentYamlPath: AGENT_YAML, outDir: OUT_DIR, project: 'p' },
      { io: cap.io, fs },
    );
    const svc = fs.files.get(join(OUT_DIR, 'service.yaml')) ?? '';
    expect(svc).toContain('ANTHROPIC_API_KEY');
    expect(svc).toContain('SLACK_BOT_TOKEN');
    expect(svc).toContain('concierge-anthropic-api-key');
    expect(svc).toContain('concierge-slack-bot-token');
  });

  test('emits one tenant volume mount per tenants.yaml entry', async () => {
    const tenantsYaml = `version: 1
strategy:
  bus: per-tenant
tenants:
  - id: acme-prod
  - id: beta-tenant
`;
    const fs = memoryFs({
      [AGENT_YAML]: CONCIERGE_YAML,
      [`${CWD}/tenants.yaml`]: tenantsYaml,
    });
    const cap = captureIo();
    await deployGcpCloudRun(
      { agentYamlPath: AGENT_YAML, outDir: OUT_DIR, project: 'p' },
      { io: cap.io, fs },
    );
    const svc = fs.files.get(join(OUT_DIR, 'service.yaml')) ?? '';
    expect(svc).toContain('/etc/declaragent/tenants/acme-prod');
    expect(svc).toContain('/etc/declaragent/tenants/beta-tenant');
  });

  test('README surfaces the three commands + cost note', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    await deployGcpCloudRun(
      {
        agentYamlPath: AGENT_YAML,
        outDir: OUT_DIR,
        project: 'my-proj',
        region: 'europe-west1',
      },
      { io: cap.io, fs },
    );
    const readme = fs.files.get(join(OUT_DIR, 'README.md')) ?? '';
    expect(readme).toContain('docker build -t gcr.io/my-proj/concierge:latest .');
    expect(readme).toContain('docker push gcr.io/my-proj/concierge:latest');
    expect(readme).toContain('gcloud run services replace service.yaml --region=europe-west1');
    expect(readme).toContain('$40–$60');
    expect(readme).toContain('lower bound');
  });

  test('--json emits the structured shape', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    const code = await deployGcpCloudRun(
      { agentYamlPath: AGENT_YAML, outDir: OUT_DIR, project: 'p', json: true },
      { io: cap.io, fs },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.serviceName).toBe('concierge');
    expect(parsed.artifacts.dockerfilePath).toContain('Dockerfile');
    expect(parsed.cost.lowerBoundUSD).toBe(40);
  });

  test('Dockerfile bakes in the Alpine base + entrypoint', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    await deployGcpCloudRun(
      { agentYamlPath: AGENT_YAML, outDir: OUT_DIR, project: 'p' },
      { io: cap.io, fs },
    );
    const df = fs.files.get(join(OUT_DIR, 'Dockerfile')) ?? '';
    expect(df).toContain('FROM alpine:3.19');
    expect(df).toContain('ARG BINARY=declaragent-linux-x64');
    expect(df).toContain('USER agent');
    expect(df).toContain('EXPOSE 8787 9464');
    expect(df).toContain('ENTRYPOINT ["/usr/local/bin/declaragent", "run"]');
  });
});

describe('deployGcpCloudRun — overwrite guard', () => {
  test('refuses to overwrite existing artifacts without --force', async () => {
    const fs = memoryFs({
      [AGENT_YAML]: CONCIERGE_YAML,
      [join(OUT_DIR, 'Dockerfile')]: '# stale',
    });
    const cap = captureIo();
    const code = await deployGcpCloudRun(
      { agentYamlPath: AGENT_YAML, outDir: OUT_DIR, project: 'p' },
      { io: cap.io, fs },
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('--force');
    expect(fs.files.get(join(OUT_DIR, 'Dockerfile'))).toBe('# stale');
  });

  test('--force overwrites existing artifacts', async () => {
    const fs = memoryFs({
      [AGENT_YAML]: CONCIERGE_YAML,
      [join(OUT_DIR, 'Dockerfile')]: '# stale',
    });
    const cap = captureIo();
    const code = await deployGcpCloudRun(
      { agentYamlPath: AGENT_YAML, outDir: OUT_DIR, project: 'p', force: true },
      { io: cap.io, fs },
    );
    expect(code).toBe(0);
    expect(fs.files.get(join(OUT_DIR, 'Dockerfile'))).toContain('FROM alpine:3.19');
  });
});

describe('deployGcpCloudRun — error paths', () => {
  test('missing agent.yaml exits 1 with init hint', async () => {
    const fs = memoryFs({});
    const cap = captureIo();
    const code = await deployGcpCloudRun(
      { agentYamlPath: AGENT_YAML, outDir: OUT_DIR, project: 'p' },
      { io: cap.io, fs },
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('no agent.yaml found');
    expect(cap.err.join('')).toContain('declaragent init');
  });

  test('malformed agent.yaml exits 1 surfacing the parse error', async () => {
    const fs = memoryFs({ [AGENT_YAML]: 'name: concierge\n  bad:\n   ::: broken' });
    const cap = captureIo();
    const code = await deployGcpCloudRun(
      { agentYamlPath: AGENT_YAML, outDir: OUT_DIR, project: 'p' },
      { io: cap.io, fs },
    );
    expect(code).toBe(1);
    const msg = cap.err.join('');
    expect(msg.toLowerCase()).toContain('parse');
  });
});

describe('verifyGcpCloudRunDeploy', () => {
  function stubGcloud(
    urls: Record<string, DeployGcloudResult>,
  ): (args: string[]) => Promise<DeployGcloudResult> {
    return async (args) => {
      const key = args.join(' ');
      const match = Object.entries(urls).find(([needle]) => key.includes(needle));
      if (!match) throw new Error(`unexpected gcloud invocation: ${key}`);
      return match[1];
    };
  }

  function stubFetch(
    responses: Record<string, DeployFetchResponse>,
  ): (url: string) => Promise<DeployFetchResponse> {
    return async (url) => {
      const r = responses[url];
      if (!r) throw new Error(`no stub for ${url}`);
      return r;
    };
  }

  test('200 from /health prints shareable URL + webhook snippet', async () => {
    const fs = memoryFs({
      [AGENT_YAML]: CONCIERGE_YAML,
      [`${CWD}/channels.yaml`]: CONCIERGE_CHANNELS_YAML,
    });
    const cap = captureIo();
    const deps: DeployCliDeps = {
      io: cap.io,
      fs,
      gcloud: stubGcloud({
        'services describe concierge': {
          code: 0,
          stdout: 'https://concierge-abc.run.app\n',
          stderr: '',
        },
      }),
      fetch: stubFetch({
        'https://concierge-abc.run.app/health': {
          ok: true,
          status: 200,
          text: async () => 'ok',
        },
      }),
    };
    const code = await verifyGcpCloudRunDeploy(
      { agentYamlPath: AGENT_YAML, project: 'p', region: 'us-central1' },
      deps,
    );
    expect(code).toBe(0);
    const out = cap.out.join('');
    expect(out).toContain('https://concierge-abc.run.app');
    expect(out).toContain('/health returned 200');
    expect(out).toContain('slack (concierge-slack) webhook URL:');
    expect(out).toContain('/channels/concierge-slack/events');
  });

  test('non-200 /health exits 1', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    const deps: DeployCliDeps = {
      io: cap.io,
      fs,
      gcloud: stubGcloud({
        describe: { code: 0, stdout: 'https://x.run.app', stderr: '' },
      }),
      fetch: stubFetch({
        'https://x.run.app/health': {
          ok: false,
          status: 503,
          text: async () => 'starting',
        },
      }),
    };
    const code = await verifyGcpCloudRunDeploy(
      { agentYamlPath: AGENT_YAML, project: 'p', region: 'us-central1' },
      deps,
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('503');
  });

  test('gcloud describe failure surfaces stderr', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    const deps: DeployCliDeps = {
      io: cap.io,
      fs,
      gcloud: stubGcloud({
        describe: { code: 1, stdout: '', stderr: 'not found' },
      }),
    };
    const code = await verifyGcpCloudRunDeploy(
      { agentYamlPath: AGENT_YAML, project: 'p', region: 'us-central1' },
      deps,
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('not found');
  });

  test('missing gcloud on $PATH exits gracefully', async () => {
    // Inject a gcloud stub that simulates the probe failing by throwing.
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    const deps: DeployCliDeps = {
      io: cap.io,
      fs,
      gcloud: async () => ({ code: 127, stdout: '', stderr: 'command not found: gcloud' }),
    };
    // Force the probe path by providing a gcloud stub AND seeing that a
    // describe failure (code=127) surfaces the "not found" diagnostic.
    const code = await verifyGcpCloudRunDeploy(
      { agentYamlPath: AGENT_YAML, project: 'p', region: 'us-central1' },
      deps,
    );
    expect(code).toBe(1);
    expect(cap.err.join('').toLowerCase()).toMatch(/not found|gcloud/);
  });

  test('empty URL from gcloud is reported as undeployed', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    const deps: DeployCliDeps = {
      io: cap.io,
      fs,
      gcloud: stubGcloud({
        describe: { code: 0, stdout: '\n', stderr: '' },
      }),
    };
    const code = await verifyGcpCloudRunDeploy(
      { agentYamlPath: AGENT_YAML, project: 'p', region: 'us-central1' },
      deps,
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('empty URL');
  });

  test('--json emits the parseable envelope on success', async () => {
    const fs = memoryFs({ [AGENT_YAML]: CONCIERGE_YAML });
    const cap = captureIo();
    const deps: DeployCliDeps = {
      io: cap.io,
      fs,
      gcloud: stubGcloud({
        describe: { code: 0, stdout: 'https://c.run.app', stderr: '' },
      }),
      fetch: stubFetch({
        'https://c.run.app/health': { ok: true, status: 200, text: async () => 'ok' },
      }),
    };
    const code = await verifyGcpCloudRunDeploy(
      { agentYamlPath: AGENT_YAML, project: 'p', region: 'us-central1', json: true },
      deps,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join(''));
    expect(parsed.url).toBe('https://c.run.app');
    expect(parsed.health).toBe('ok');
    expect(parsed.webhooks[0]).toContain('/channels/');
  });
});

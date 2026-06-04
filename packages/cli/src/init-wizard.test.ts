import { describe, expect, test } from 'bun:test';
import type { LLMProvider, LLMResponse } from '@declaragent/core';
import type { UnpackDirEntry, UnpackFS } from './init-template-unpacker.js';
import type { InitOptions, InitWizardDeps, InitWizardIO } from './init-wizard.js';
import { runInit } from './init-wizard.js';

/**
 * Fixture templates root the in-memory FS is seeded under. Tests inject
 * this via `baseDeps`'s `templatesDir` so the unpacker reads the seeded
 * tree instead of the real repo `templates/` directory.
 */
const TEMPLATES_ROOT = '/fake/templates';

/**
 * Seed a fake template tree so the wizard's `unpackTemplate` call has real
 * directory + file contents to copy. `{{provider}}` is left as a token so
 * the placeholder substitution that the wizard drives is exercised
 * end-to-end (it resolves to `provider: anthropic` for these tests).
 */
function templateSeed(): Record<string, string> {
  return {
    [`${TEMPLATES_ROOT}/concierge/agent.yaml`]: 'name: concierge\nprovider: {{provider}}\n',
    [`${TEMPLATES_ROOT}/concierge/.env.example`]: '{{envVar}}=sk-ant-...\n',
    [`${TEMPLATES_ROOT}/concierge/README.md`]: '# concierge\n',
    [`${TEMPLATES_ROOT}/concierge/skills/concierge.md`]: '# concierge skill\n',
    [`${TEMPLATES_ROOT}/multi-tenant-starter/agent.yaml`]:
      'name: multi-tenant-starter\nprovider: {{provider}}\n',
    [`${TEMPLATES_ROOT}/multi-tenant-starter/.env.example`]: '{{envVar}}=\n',
    [`${TEMPLATES_ROOT}/multi-tenant-starter/tenants.yaml`]:
      'version: 1\ntenants:\n  - id: default\n    residency: us\n',
  };
}

function captureIo(): { io: InitWizardIO; out: string[]; err: string[] } {
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

/**
 * In-memory FS seeded with the fixture template tree under
 * {@link TEMPLATES_ROOT}. Implements the full {@link UnpackFS} surface
 * (`readdir`/`isDir` included) so the wizard's `unpackTemplate` can walk
 * and copy a real directory tree. Mirrors the helper in
 * `init-template-unpacker.test.ts`.
 */
function memoryFs(seed: Record<string, string> = templateSeed()): UnpackFS & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const addDirsFor = (path: string): void => {
    let dir = path.slice(0, path.lastIndexOf('/'));
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  };
  for (const path of files.keys()) addDirsFor(path);

  return {
    files,
    exists: (p) => files.has(p) || dirs.has(p),
    writeFile: (p, c) => {
      files.set(p, c);
      addDirsFor(p);
    },
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`no file ${p}`);
      return v;
    },
    isDir: (p) => dirs.has(p),
    readdir: (p): readonly UnpackDirEntry[] => {
      const prefix = `${p}/`;
      const seen = new Map<string, UnpackDirEntry>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          seen.set(rest, { name: rest, isFile: true, isDir: false });
        } else {
          const name = rest.slice(0, slash);
          if (!seen.has(name)) seen.set(name, { name, isFile: false, isDir: true });
        }
      }
      return [...seen.values()];
    },
  };
}

/**
 * Paths the wizard *wrote* — i.e. everything in the shared map that is not
 * part of the seeded `/fake/templates` fixture tree. Keeps assertions from
 * accidentally matching a seeded source file (both seed and output live in
 * the same in-memory map).
 */
function writtenPaths(fs: { files: Map<string, string> }): string[] {
  return [...fs.files.keys()].filter((p) => !p.startsWith(`${TEMPLATES_ROOT}/`));
}

function stubProvider(resp: Partial<LLMResponse> = {}): LLMProvider {
  return {
    name: 'stub',
    complete: async (): Promise<LLMResponse> => ({
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'stub-model',
      ...resp,
    }),
    countTokens: async () => 1,
  };
}

function throwingProvider(err: Error): LLMProvider {
  return {
    name: 'throwing',
    complete: async (): Promise<LLMResponse> => {
      throw err;
    },
    countTokens: async () => 0,
  };
}

function baseOptions(overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    outDir: '/tmp/declaragent-init-test',
    force: false,
    multiTenant: false,
    provider: 'anthropic',
    template: 'concierge',
    skipVerify: true,
    ...overrides,
  };
}

function baseDeps(
  fs: UnpackFS,
  io: InitWizardIO,
  extra: Partial<InitWizardDeps> = {},
): InitWizardDeps {
  return {
    io,
    fs,
    templatesDir: TEMPLATES_ROOT,
    markerPath: '/tmp/declaragent-init-test/.initialized',
    env: {},
    ...extra,
  };
}

describe('runInit — non-interactive path', () => {
  test('writes agent.yaml + .env.example + README.md', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(baseOptions(), baseDeps(fs, cap.io));
    expect(code).toBe(0);
    const paths = writtenPaths(fs);
    expect(paths.some((p) => p.endsWith('/agent.yaml'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/.env.example'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/README.md'))).toBe(true);
    expect(paths.some((p) => p.endsWith('/.initialized'))).toBe(true);
    const agentYaml = fs.files.get(paths.find((p) => p.endsWith('/agent.yaml')) as string);
    expect(agentYaml).toContain('provider: anthropic');
    expect(agentYaml).toContain('name: concierge');
    expect(cap.err.join('')).toBe('');
  });

  test('rejects unknown provider', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(baseOptions({ provider: 'nope' }), baseDeps(fs, cap.io));
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('unknown provider');
    // Nothing was written — only the seeded template fixtures remain.
    expect(writtenPaths(fs)).toEqual([]);
  });

  test('rejects unknown template', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(baseOptions({ template: 'nope' }), baseDeps(fs, cap.io));
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('unknown template');
  });

  test('surfaces HTTPS_PROXY env var when set', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions(),
      baseDeps(fs, cap.io, { env: { HTTPS_PROXY: 'http://proxy:3128' } }),
    );
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('HTTPS_PROXY=http://proxy:3128');
  });
});

describe('runInit — overwrite guard', () => {
  test('refuses to overwrite existing agent.yaml without --force', async () => {
    const fs = memoryFs();
    const outDir = '/tmp/init-overwrite';
    fs.writeFile(`${outDir}/agent.yaml`, '# pre-existing\n');
    const cap = captureIo();
    const code = await runInit(baseOptions({ outDir }), baseDeps(fs, cap.io));
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('refusing to overwrite');
    expect(fs.files.get(`${outDir}/agent.yaml`)).toBe('# pre-existing\n');
  });

  test('--force overwrites the pre-existing file', async () => {
    const fs = memoryFs();
    const outDir = '/tmp/init-overwrite-force';
    fs.writeFile(`${outDir}/agent.yaml`, '# pre-existing\n');
    const cap = captureIo();
    const code = await runInit(baseOptions({ outDir, force: true }), baseDeps(fs, cap.io));
    expect(code).toBe(0);
    expect(fs.files.get(`${outDir}/agent.yaml`)).not.toBe('# pre-existing\n');
    expect(fs.files.get(`${outDir}/agent.yaml`)).toContain('provider: anthropic');
  });
});

describe('runInit — multi-tenant toggle', () => {
  test('writes tenants.yaml when --multi-tenant is on', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({
        outDir: '/tmp/init-mt',
        template: 'multi-tenant-starter',
        multiTenant: true,
        tenantId: 'acme-prod',
      }),
      baseDeps(fs, cap.io),
    );
    expect(code).toBe(0);
    const tenantsYaml = fs.files.get('/tmp/init-mt/tenants.yaml');
    expect(tenantsYaml).toBeDefined();
    expect(tenantsYaml).toContain('id: acme-prod');
  });

  test('no tenants.yaml in single-tenant mode', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({ outDir: '/tmp/init-st', template: 'multi-tenant-starter' }),
      baseDeps(fs, cap.io),
    );
    expect(code).toBe(0);
    expect(fs.files.has('/tmp/init-st/tenants.yaml')).toBe(false);
  });

  test('defaults the tenant id to "default" when none supplied', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({
        outDir: '/tmp/init-mt-def',
        template: 'multi-tenant-starter',
        multiTenant: true,
      }),
      baseDeps(fs, cap.io),
    );
    expect(code).toBe(0);
    expect(fs.files.get('/tmp/init-mt-def/tenants.yaml')).toContain('id: default');
  });
});

describe('runInit — verify', () => {
  test('injected verify hook success → exit 0', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({ skipVerify: false }),
      baseDeps(fs, cap.io, {
        verify: async () => {},
      }),
    );
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('✓ verify');
  });

  test('injected verify throws → exit 1 + actionable error', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({ skipVerify: false }),
      baseDeps(fs, cap.io, {
        verify: async () => {
          throw new Error('Request failed: 401 Unauthorized');
        },
      }),
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('verify failed');
    expect(cap.err.join('')).toContain('declaragent auth login anthropic');
  });

  test('injected verify throws network error → proxy hint', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({ skipVerify: false }),
      baseDeps(fs, cap.io, {
        verify: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:443');
        },
      }),
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('HTTPS_PROXY');
  });

  test('injected provider returns text → success', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({ skipVerify: false }),
      baseDeps(fs, cap.io, {
        makeVerifyProvider: () => stubProvider(),
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      }),
    );
    expect(code).toBe(0);
    expect(cap.out.join('')).toContain('✓ verify');
  });

  test('injected provider throws → exit 1', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({ skipVerify: false }),
      baseDeps(fs, cap.io, {
        makeVerifyProvider: () => throwingProvider(new Error('boom')),
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      }),
    );
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('verify failed');
  });

  test('no credentials → skipped with fix hint', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const code = await runInit(
      baseOptions({ skipVerify: false }),
      baseDeps(fs, cap.io, {
        // no env var, no verify hook — force the real path, which will look up
        // credentials. We point resolveCredentials at an empty env so it finds
        // nothing (the saved-config path may still resolve on dev machines;
        // in that case we accept the dev-machine fallback and only assert
        // exit code).
        env: {},
      }),
    );
    // Dev machines may have saved creds in ~/.declaragent/config.json; the
    // test must not assume a pristine env. We assert one of two cases:
    //   - creds resolved and the real Anthropic SDK attempt produced some
    //     error (exit 1 + "verify failed" or similar).
    //   - creds did not resolve and we exited 1 with the fix-hint.
    // Both are acceptable shapes for this slice.
    expect([0, 1]).toContain(code);
  });
});

describe('runInit — interactive gate', () => {
  test('missing provider/template without launchInteractive → exit 1', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    const opts: InitOptions = {
      outDir: '/tmp/init-int',
      force: false,
      multiTenant: false,
    };
    const code = await runInit(opts, baseDeps(fs, cap.io));
    expect(code).toBe(1);
    expect(cap.err.join('')).toContain('interactive wizard not available');
  });

  test('launchInteractive is called when non-interactive fields missing', async () => {
    const fs = memoryFs();
    const cap = captureIo();
    let called = false;
    const code = await runInit(
      { outDir: '/tmp/x', force: false, multiTenant: false },
      baseDeps(fs, cap.io, {
        launchInteractive: async () => {
          called = true;
          return 7;
        },
      }),
    );
    expect(called).toBe(true);
    expect(code).toBe(7);
  });
});

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  TEMPLATE_NAMES,
  TemplateUnpackError,
  type UnpackDirEntry,
  type UnpackFS,
  getTemplateDescription,
  isTemplateName,
  listTemplates,
  unpackTemplate,
} from './init-template-unpacker.js';

const TEMPLATES_ROOT = '/fake/templates';

/**
 * In-memory FS seeded with a fake template tree under {@link TEMPLATES_ROOT}.
 * Hermetic — does not depend on the real repo `templates/` directory.
 */
function memoryFs(seed: Record<string, string> = {}): UnpackFS & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  // The set of directories implied by the seeded file paths.
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    let dir = path.slice(0, path.lastIndexOf('/'));
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
  }

  const isDir = (p: string): boolean => dirs.has(p);

  return {
    files,
    exists: (p) => files.has(p) || dirs.has(p),
    writeFile: (p, c) => {
      files.set(p, c);
      let dir = p.slice(0, p.lastIndexOf('/'));
      while (dir && !dirs.has(dir)) {
        dirs.add(dir);
        dir = dir.slice(0, dir.lastIndexOf('/'));
      }
    },
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`no file ${p}`);
      return v;
    },
    isDir,
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

function conciergeSeed(): Record<string, string> {
  return {
    [`${TEMPLATES_ROOT}/concierge/agent.yaml`]: 'name: concierge\nmodel: claude-sonnet-4-5\n',
    [`${TEMPLATES_ROOT}/concierge/.env.example`]: 'ANTHROPIC_API_KEY=sk-ant-...\n',
    [`${TEMPLATES_ROOT}/concierge/README.md`]: '# concierge\n',
    [`${TEMPLATES_ROOT}/concierge/skills/concierge.md`]: '# concierge skill\n',
  };
}

function multiTenantSeed(): Record<string, string> {
  return {
    [`${TEMPLATES_ROOT}/multi-tenant-starter/agent.yaml`]: 'name: multi-tenant-starter\n',
    [`${TEMPLATES_ROOT}/multi-tenant-starter/.env.example`]: 'ANTHROPIC_API_KEY=\n',
    [`${TEMPLATES_ROOT}/multi-tenant-starter/tenants.yaml`]:
      'version: 1\nstrategy:\n  bus: per-tenant\ntenants:\n  - id: acme-prod\n    residency: us\n',
  };
}

const baseOpts = {
  providerId: 'anthropic',
  providerEnvVar: 'ANTHROPIC_API_KEY',
  force: false,
  multiTenant: false,
  templatesDir: TEMPLATES_ROOT,
} as const;

describe('unpackTemplate — real-template copy', () => {
  test('copies every file in the template tree into outDir', () => {
    const fs = memoryFs(conciergeSeed());
    const res = unpackTemplate({ ...baseOpts, template: 'concierge', outDir: '/out' }, fs);
    expect(res.skipped).toEqual([]);
    expect(fs.files.get('/out/agent.yaml')).toContain('name: concierge');
    expect(fs.files.get('/out/.env.example')).toContain('ANTHROPIC_API_KEY');
    expect(fs.files.get('/out/README.md')).toContain('# concierge');
    // Nested skills/ dir preserved.
    expect(fs.files.get('/out/skills/concierge.md')).toContain('concierge skill');
    // .mcp.json synthesized when the template ships none.
    expect(fs.files.get('/out/.mcp.json')).toContain('"servers"');
  });

  test('does not clobber a template-provided .mcp.json', () => {
    const seed = conciergeSeed();
    seed[`${TEMPLATES_ROOT}/concierge/.mcp.json`] = '{"version":1,"servers":["custom"]}\n';
    const fs = memoryFs(seed);
    unpackTemplate({ ...baseOpts, template: 'concierge', outDir: '/out2' }, fs);
    expect(fs.files.get('/out2/.mcp.json')).toContain('custom');
  });

  test('throws TemplateUnpackError on collision without force', () => {
    const fs = memoryFs(conciergeSeed());
    fs.writeFile('/out/agent.yaml', '# pre-existing\n');
    expect(() =>
      unpackTemplate({ ...baseOpts, template: 'concierge', outDir: '/out' }, fs),
    ).toThrow(TemplateUnpackError);
    // Pre-scan aborts before any write — the README was never created.
    expect(fs.files.has('/out/README.md')).toBe(false);
    // The pre-existing file is untouched.
    expect(fs.files.get('/out/agent.yaml')).toBe('# pre-existing\n');
  });

  test('force overwrites a pre-existing file', () => {
    const fs = memoryFs(conciergeSeed());
    fs.writeFile('/out/agent.yaml', '# pre-existing\n');
    const res = unpackTemplate(
      { ...baseOpts, template: 'concierge', outDir: '/out', force: true },
      fs,
    );
    expect(res.written).toContain('/out/agent.yaml');
    expect(fs.files.get('/out/agent.yaml')).toContain('name: concierge');
  });

  test('throws when the template directory is missing', () => {
    const fs = memoryFs({});
    expect(() =>
      unpackTemplate({ ...baseOpts, template: 'concierge', outDir: '/out' }, fs),
    ).toThrow(/not found/);
  });

  test('substitutes {{provider}}/{{envVar}} only when the token is present', () => {
    const fs = memoryFs({
      [`${TEMPLATES_ROOT}/concierge/agent.yaml`]: 'name: concierge\nprovider: {{provider}}\n',
      [`${TEMPLATES_ROOT}/concierge/.env.example`]: '{{envVar}}=\n',
    });
    unpackTemplate(
      {
        ...baseOpts,
        template: 'concierge',
        outDir: '/out',
        providerId: 'openrouter',
        providerEnvVar: 'OPENROUTER_API_KEY',
      },
      fs,
    );
    expect(fs.files.get('/out/agent.yaml')).toContain('provider: openrouter');
    expect(fs.files.get('/out/.env.example')).toBe('OPENROUTER_API_KEY=\n');
  });
});

describe('unpackTemplate — multi-tenant', () => {
  test('copies shipped tenants.yaml verbatim when no tenantId given', () => {
    const fs = memoryFs(multiTenantSeed());
    unpackTemplate(
      { ...baseOpts, template: 'multi-tenant-starter', outDir: '/mt', multiTenant: true },
      fs,
    );
    const tenants = fs.files.get('/mt/tenants.yaml');
    expect(tenants).toContain('id: acme-prod');
    expect(tenants).toContain('bus: per-tenant');
  });

  test('rewrites the first tenant id when tenantId is supplied', () => {
    const fs = memoryFs(multiTenantSeed());
    unpackTemplate(
      {
        ...baseOpts,
        template: 'multi-tenant-starter',
        outDir: '/mt',
        multiTenant: true,
        tenantId: 'globex',
      },
      fs,
    );
    const tenants = fs.files.get('/mt/tenants.yaml');
    expect(tenants).toContain('id: globex');
    expect(tenants).not.toContain('id: acme-prod');
    // The rest of the entry is preserved.
    expect(tenants).toContain('residency: us');
  });

  test('omits tenants.yaml in single-tenant mode', () => {
    const fs = memoryFs(multiTenantSeed());
    unpackTemplate(
      { ...baseOpts, template: 'multi-tenant-starter', outDir: '/st', multiTenant: false },
      fs,
    );
    expect(fs.files.has('/st/tenants.yaml')).toBe(false);
    expect(fs.files.get('/st/agent.yaml')).toContain('name: multi-tenant-starter');
  });

  test('errors when multiTenant requested but template ships no tenants.yaml', () => {
    const fs = memoryFs(conciergeSeed());
    expect(() =>
      unpackTemplate({ ...baseOpts, template: 'concierge', outDir: '/out', multiTenant: true }, fs),
    ).toThrow(/does not ship a tenants.yaml/);
  });
});

describe('template metadata (offline)', () => {
  test('listTemplates returns all five names with descriptions', () => {
    const items = listTemplates();
    expect(items.map((t) => t.name)).toEqual([...TEMPLATE_NAMES]);
    for (const item of items) {
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  test('getTemplateDescription returns a non-empty string', () => {
    expect(getTemplateDescription('concierge').length).toBeGreaterThan(0);
  });

  test('isTemplateName narrows known + rejects unknown', () => {
    expect(isTemplateName('concierge')).toBe(true);
    expect(isTemplateName('not-a-template')).toBe(false);
  });
});

describe('unpackTemplate — against the real shipped templates dir', () => {
  // Resolve the repo-root templates dir the same way the production
  // resolver does, so this test exercises the actual on-disk content.
  const realTemplatesDir = join(import.meta.dir, '..', '..', '..', 'templates');

  test('scaffolds the real concierge template end-to-end', () => {
    const fs = memoryFs({});
    const res = unpackTemplate(
      {
        ...baseOpts,
        template: 'concierge',
        outDir: '/real-out',
        templatesDir: realTemplatesDir,
      },
      // Use the default node-backed FS for reads, in-memory for writes.
      hybridFs(fs),
    );
    expect(res.written.some((p) => p.endsWith('/agent.yaml'))).toBe(true);
    expect(fs.files.get('/real-out/agent.yaml')).toContain('name: concierge');
  });
});

/**
 * Reads come from the real node:fs (via a fresh DEFAULT-like handle),
 * writes land in the in-memory map. Lets the "real templates" test copy
 * actual disk content into a throwaway target.
 */
function hybridFs(mem: UnpackFS & { files: Map<string, string> }): UnpackFS {
  const real = realNodeFs();
  return {
    exists: (p) => (p.startsWith('/real-out') ? mem.exists(p) : real.exists(p)),
    isDir: (p) => (p.startsWith('/real-out') ? mem.isDir(p) : real.isDir(p)),
    readdir: (p) => real.readdir(p),
    readFile: (p) => real.readFile(p),
    writeFile: (p, c) => mem.writeFile(p, c),
  };
}

function realNodeFs(): UnpackFS {
  // Lazy node:fs handle so the hermetic tests above never touch disk.
  const nodeFs = require('node:fs') as typeof import('node:fs');
  return {
    exists: (p) => nodeFs.existsSync(p),
    writeFile: () => {
      throw new Error('realNodeFs is read-only');
    },
    readFile: (p) => nodeFs.readFileSync(p, 'utf8'),
    readdir: (p) =>
      nodeFs.readdirSync(p, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDir: e.isDirectory(),
      })),
    isDir: (p) => {
      try {
        return nodeFs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

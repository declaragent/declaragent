import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPluginStore } from '@declaragent/core';
import { skillList } from './skill-cli.js';

const FIXTURE_DIR = resolve(
  __dirname,
  '..',
  '..',
  'core',
  'src',
  'plugins',
  '__fixtures__',
  'plugin-sample',
);

let workDir: string;
let userDir: string;
let teamDir: string;
let storePath: string;

interface CapturedIO {
  stdout: string;
  stderr: string;
  io: { out: (s: string) => void; err: (s: string) => void };
}

function captureIO(): CapturedIO {
  const cap: CapturedIO = {
    stdout: '',
    stderr: '',
    io: {
      out(s: string) {
        cap.stdout += s;
      },
      err(s: string) {
        cap.stderr += s;
      },
    },
  };
  return cap;
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'declaragent-skillcli-'));
  userDir = join(workDir, 'user');
  teamDir = join(workDir, 'team');
  storePath = join(workDir, 'plugins.json');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('skill list', () => {
  test('reports "no skills" when nothing is configured', async () => {
    const store = createPluginStore(storePath);
    const cap = captureIO();
    expect(await skillList({ io: cap.io, store, userDir, teamDir })).toBe(0);
    expect(cap.stdout).toContain('no skills found');
  });

  test('aggregates user, team, and plugin skills with tier labels', async () => {
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(
      join(userDir, 'u.md'),
      '---\nname: user-only\ndescription: u\n---\nbody',
      'utf-8',
    );
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      join(teamDir, 't.md'),
      '---\nname: team-only\ndescription: t\n---\nbody',
      'utf-8',
    );
    const store = createPluginStore(storePath);
    await store.add({
      name: '@declaragent/plugin-sample',
      version: '0.1.0',
      dir: FIXTURE_DIR,
      installedAt: new Date().toISOString(),
    });

    const cap = captureIO();
    expect(await skillList({ io: cap.io, store, userDir, teamDir })).toBe(0);
    expect(cap.stdout).toContain('user-only  (user)');
    expect(cap.stdout).toContain('team-only  (team)');
    expect(cap.stdout).toContain('@declaragent/plugin-sample:greet  (plugin');
  });

  test('user beats team for unqualified collisions and surfaces the conflict', async () => {
    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      join(userDir, 'pr.md'),
      '---\nname: pr-review\ndescription: U\n---\nu',
      'utf-8',
    );
    await fs.writeFile(
      join(teamDir, 'pr.md'),
      '---\nname: pr-review\ndescription: T\n---\nt',
      'utf-8',
    );
    const store = createPluginStore(storePath);
    const cap = captureIO();
    expect(await skillList({ io: cap.io, store, userDir, teamDir })).toBe(0);
    expect(cap.stdout).toContain('pr-review  (user)');
    expect(cap.stdout).toContain('conflicts');
    expect(cap.stdout).toContain('shadowed');
  });
});

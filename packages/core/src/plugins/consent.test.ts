import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPermissionGate } from '../permission/gate.js';
import { consentedPermissionRules } from './consent.js';
import { createPluginStore } from './store.js';

let workDir: string;
let storePath: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'declaragent-consent-'));
  storePath = join(workDir, 'plugins.json');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('consentedPermissionRules', () => {
  test('returns an empty list when no plugins are consented', async () => {
    const store = createPluginStore(storePath);
    expect(await consentedPermissionRules(store)).toEqual([]);
  });

  test('returns one allow rule per consented pattern, deduped across plugins', async () => {
    const store = createPluginStore(storePath);
    await store.add({
      name: 'a',
      version: '1.0.0',
      dir: '/x',
      installedAt: '2026-04-16T12:00:00.000Z',
      consentedPermissions: ['Bash:gh *', 'Read:**'],
      consentedAt: '2026-04-16T12:00:00.000Z',
    });
    await store.add({
      name: 'b',
      version: '1.0.0',
      dir: '/y',
      installedAt: '2026-04-16T12:00:00.000Z',
      consentedPermissions: ['Bash:gh *', 'Bash:gh status'],
      consentedAt: '2026-04-16T12:00:00.000Z',
    });
    const rules = await consentedPermissionRules(store);
    expect(rules.map((r) => r.pattern).sort()).toEqual(['Bash:gh *', 'Bash:gh status', 'Read:**']);
    expect(rules.every((r) => r.decision === 'allow')).toBe(true);
  });

  test('skips entries with no consentedPermissions field', async () => {
    const store = createPluginStore(storePath);
    await store.add({
      name: 'no-consent',
      version: '0.0.1',
      dir: '/z',
      installedAt: '2026-04-16T12:00:00.000Z',
    });
    expect(await consentedPermissionRules(store)).toEqual([]);
  });

  test('feeding the rules into the gate auto-allows the consented patterns', async () => {
    const store = createPluginStore(storePath);
    await store.add({
      name: 'gh',
      version: '1.0.0',
      dir: '/x',
      installedAt: '2026-04-16T12:00:00.000Z',
      consentedPermissions: ['Bash:gh *'],
      consentedAt: '2026-04-16T12:00:00.000Z',
    });
    const rules = await consentedPermissionRules(store);
    const gate = createPermissionGate({ mode: 'default', rules });
    const decision = await gate.check('Bash', 'gh status');
    expect(decision.outcome).toBe('allow');
    expect(decision.matchedRule?.pattern).toBe('Bash:gh *');
  });

  test('removing a plugin drops its consent from the rule set', async () => {
    const store = createPluginStore(storePath);
    await store.add({
      name: 'a',
      version: '1.0.0',
      dir: '/x',
      installedAt: '2026-04-16T12:00:00.000Z',
      consentedPermissions: ['Bash:gh *'],
      consentedAt: '2026-04-16T12:00:00.000Z',
    });
    expect((await consentedPermissionRules(store)).length).toBe(1);

    expect(await store.remove('a')).toBe(true);
    expect(await consentedPermissionRules(store)).toEqual([]);

    // And the gate built from those rules now prompts instead of allowing.
    const gate = createPermissionGate({
      mode: 'default',
      rules: await consentedPermissionRules(store),
    });
    const decision = await gate.check('Bash', 'gh status');
    expect(decision.outcome).toBe('prompt');
  });
});

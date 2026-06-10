/**
 * Slice-2 acceptance wiring: the FLEET_PLAN.md §16 check #1 flow.
 *
 *   `fleet new my-fleet` → `fleet add rpc-client` → `fleet add rpc-server`
 *   → `fleet list` + `fleet validate` + `fleet capabilities` all pass.
 *
 * Everything runs against a tmpdir with an injected templates directory
 * so this test is hermetic.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleetAdd } from './fleet-add-cli.js';
import { fleetCapabilities, fleetList, fleetValidate } from './fleet-cli.js';
import { fleetInit } from './fleet-init-cli.js';

function captureIo(): {
  io: { out: (s: string) => void; err: (s: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

function writeTemplate(root: string, rel: string, contents: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents, 'utf-8');
}

describe('fleet e2e — init → add → list → validate', () => {
  test('§16 acceptance check #1: two-agent fleet scaffolds and validates clean', async () => {
    const root = mkdtempSync(join(tmpdir(), 'declaragent-fleet-e2e-'));
    try {
      writeTemplate(
        root,
        'templates/rpc-client/agent.yaml',
        'name: concierge\nmodel: m\nsystemPrompt: hi\ntools:\n  defaults: [RequestAgent]\n',
      );
      writeTemplate(
        root,
        'templates/rpc-server/agent.yaml',
        'name: pr-reviewer\nmodel: m\nsystemPrompt: hi\ntools:\n  defaults: [Read]\n',
      );
      writeTemplate(
        root,
        'templates/rpc-server/capabilities.yaml',
        `version: 1
agent: agent://pr-reviewer
transports:
  - kind: memory
    topics: { requests: agents.pr-reviewer.requests }
capabilities:
  - name: review-pr
    timeoutMs: 60000
    idempotent: true
`,
      );
      const templatesDir = join(root, 'templates');
      const fleetRoot = join(root, 'my-fleet');

      // 1. Scaffold.
      expect(await fleetInit({ name: 'my-fleet' }, { io: captureIo().io, cwd: root })).toBe(0);

      // 2. Add both agents.
      expect(
        await fleetAdd(
          { template: 'rpc-client', id: 'concierge' },
          { io: captureIo().io, fleetRoot, templatesDir },
        ),
      ).toBe(0);
      expect(
        await fleetAdd(
          { template: 'rpc-server', id: 'pr-reviewer' },
          { io: captureIo().io, fleetRoot, templatesDir },
        ),
      ).toBe(0);

      // 3. `fleet list` shows both agents.
      const listCap = captureIo();
      expect(await fleetList({}, { io: listCap.io, root: fleetRoot })).toBe(0);
      const listOut = listCap.out.join('');
      expect(listOut).toContain('concierge');
      expect(listOut).toContain('pr-reviewer');
      expect(listOut).toContain('capabilities=1');

      // 4. `fleet capabilities` surfaces the pr-reviewer capability.
      const capCap = captureIo();
      expect(await fleetCapabilities({}, { io: capCap.io, root: fleetRoot })).toBe(0);
      expect(capCap.out.join('')).toContain('review-pr');

      // 5. `fleet validate` exits clean.
      const valCap = captureIo();
      expect(await fleetValidate({}, { io: valCap.io, root: fleetRoot })).toBe(0);
      expect(valCap.out.join('')).toContain('fleet validates clean');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

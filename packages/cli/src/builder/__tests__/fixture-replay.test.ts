/**
 * Fixture replay regression tests. Enterprise Production Plan §3 Item
 * #12 — one test per canonical fixture. Each test builds an isolated
 * scope root (tmpdir), seeds the minimum filesystem shape the fixture's
 * tool calls expect, then replays the fixture through the real Engine
 * via {@link replayFixture} and asserts the expected step kinds land on
 * `DeclaraApplyChange`.
 *
 * What these tests prove:
 *   - The builder system prompt's tool-call shape (as captured in each
 *     fixture) still drives the expected propose → apply sequence.
 *   - A fixture-level contract (step kinds + counts) is enforced, so
 *     an accidental system-prompt regression that drops or reorders
 *     tool calls surfaces here instead of in a user session.
 *
 * What these tests DON'T prove:
 *   - That a live model (claude-opus-4-7 / claude-sonnet-4-6) currently
 *     emits the same shape. That's the stretch goal — see
 *     `BUILDER_RECORD=1` in the spec — and needs network access. The
 *     manual-authored fixtures in this directory are the MVP.
 *   - That the on-disk output is byte-identical; the fleet-e2e test
 *     already covers that axis for the two-agent fixture.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetInit } from '../../fleet-init-cli.js';
import {
  computeCacheHitRate,
  expectCacheHitRateAtLeast,
  loadFixture,
  replayFixture,
} from './replay-harness.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const AGENT_YAML = `name: demo
model: claude-sonnet-4-5
systemPrompt: |
  You are demo.
skills: []
tools:
  defaults:
    - Read
`;

describe('builder fixture replay — regression for the system prompt', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'declara-fixture-replay-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('01 · single-agent webhook triager proposes addSource + addSkill and applies', async () => {
    // Single-agent scope root: one agent.yaml at the top, skills/ dir
    // so runAddSkill's write target exists.
    writeFileSync(join(tmp, 'agent.yaml'), AGENT_YAML);
    mkdirSync(join(tmp, 'skills'));

    const result = await replayFixture({
      fixturePath: join(FIXTURES_DIR, '01-single-agent-webhook-triager.jsonl'),
      scopeRoot: tmp,
    });

    expect(result.appliedStepKinds).toEqual(['addSource', 'addSkill']);
    expect(result.appliedResults).toHaveLength(1);
    if (result.appliedResults[0]?.ok !== true) {
      throw new Error(
        `apply failed: firstError=${result.appliedResults[0]?.firstError ?? '(none)'}`,
      );
    }
    expect(result.turnCount).toBe(1);
    // 3 LLM turns inside the single user runAgent: the two tool_use
    // responses plus the closing end_turn. Exhaustion of the queue
    // would throw from RecordedProvider, so hitting this number
    // confirms the engine drained the fixture exactly.
    expect(result.providerCallCount).toBe(3);
  });

  test('02 · two-agent fleet proposes addAgent×2 + addPeer and applies', async () => {
    // Fleet scope: real scaffoldFleet produces fleet.yaml + rpc-peers.yaml.
    await fleetInit({ name: 'demo' }, { cwd: tmp, io: { out: () => {}, err: () => {} } });
    const fleetRoot = join(tmp, 'demo');

    const result = await replayFixture({
      fixturePath: join(FIXTURES_DIR, '02-two-agent-fleet.jsonl'),
      scopeRoot: fleetRoot,
    });

    expect(result.appliedStepKinds).toEqual(['addAgent', 'addAgent', 'addPeer']);
    expect(result.appliedResults).toHaveLength(1);
    expect(result.appliedResults[0]?.ok).toBe(true);
    expect(result.turnCount).toBe(1);
  });

  test('03 · cron digest — discovery tool + addSource + addSkill apply', async () => {
    writeFileSync(join(tmp, 'agent.yaml'), AGENT_YAML);
    mkdirSync(join(tmp, 'skills'));

    const result = await replayFixture({
      fixturePath: join(FIXTURES_DIR, '03-cron-daily-digest.jsonl'),
      scopeRoot: tmp,
    });

    // The DeclaraAuthPlaybook call is a pure-read discovery tool — it
    // doesn't touch the registry, so it must NOT appear in the step
    // kinds list. Only the two apply-through steps should.
    expect(result.appliedStepKinds).toEqual(['addSource', 'addSkill']);
    expect(result.appliedResults).toHaveLength(1);
    expect(result.appliedResults[0]?.ok).toBe(true);
  });

  test('04 · leaked token is redacted before the engine sees it, secret ref applies', async () => {
    writeFileSync(join(tmp, 'agent.yaml'), AGENT_YAML);

    const result = await replayFixture({
      fixturePath: join(FIXTURES_DIR, '04-leaked-token-redaction.jsonl'),
      scopeRoot: tmp,
      redactUserMessages: true,
    });

    // The redactor MUST have found the PAT; otherwise the fixture
    // regressed to checking an empty path.
    expect(result.redactionFindings.length).toBeGreaterThan(0);
    expect(result.redactionFindings[0]?.label).toBe('GitHub PAT');
    expect(result.appliedStepKinds).toEqual(['addSecret']);
    expect(result.appliedResults[0]?.ok).toBe(true);
  });

  test('07 · replay merges recorded toolResults into response content (backlog #36)', async () => {
    // Fixture 07 carries a `toolResults` array with one synthetic
    // entry. The replay harness must merge it into the emitted
    // `LLMResponse.content` so the engine's transcript state records
    // the synthesised result. The fixture applies no proposal, so
    // the step-kind list stays empty — the assertion surface here is
    // that replay completes without throwing (i.e., the fixture was
    // loadable + the merged response was accepted by the engine).
    writeFileSync(join(tmp, 'agent.yaml'), AGENT_YAML);
    const result = await replayFixture({
      fixturePath: join(FIXTURES_DIR, '07-tool-result-replay.jsonl'),
      scopeRoot: tmp,
    });
    expect(result.appliedStepKinds).toEqual([]);
    expect(result.providerCallCount).toBe(1);
    expect(result.turnCount).toBe(1);
  });

  test('06 · cache-hit rate holds at >=80% across the fixture (backlog #37)', () => {
    // Cost-regression coverage: the cacheable system-prompt preamble
    // should keep the cache-read share above the threshold. A drop
    // below 80% indicates the prompt lost prefix stability between
    // turns — usually a whitespace / reordering edit that rotated
    // the cache key.
    const path = join(FIXTURES_DIR, '06-cache-usage-regression.jsonl');
    const rate = expectCacheHitRateAtLeast(path, 0.8);
    // Fixture sums to (96k + 101k) cache-read over (4k + 4.2k + 96k
    // + 101k) total input+cache — ~96%.
    expect(rate).toBeGreaterThan(0.9);

    // Also exercise the manual compute helper on the same data so a
    // future refactor that moves the ratio math off the assertion
    // doesn't silently stop covering both paths.
    const entries = loadFixture(path);
    const manual = computeCacheHitRate(entries);
    expect(manual).not.toBeNull();
    if (manual !== null) expect(manual).toBe(rate);
  });

  test('expectCacheHitRateAtLeast throws on a fixture missing usage data', () => {
    // Fixtures 01–05 were authored before backlog #37 landed and
    // carry no usage telemetry. The helper must fail loudly rather
    // than silently pass — "no data" is a fixture bug, not a green
    // run.
    const path = join(FIXTURES_DIR, '01-single-agent-webhook-triager.jsonl');
    expect(() => expectCacheHitRateAtLeast(path, 0.8)).toThrow(/no usage data/);
  });

  test('05 · scope-escape proposal rejected — no apply, clean recovery', async () => {
    writeFileSync(join(tmp, 'agent.yaml'), AGENT_YAML);

    const result = await replayFixture({
      fixturePath: join(FIXTURES_DIR, '05-scope-escape-rejected.jsonl'),
      scopeRoot: tmp,
      rejectProposalSummaries: ['SCOPE_ESCAPE'],
    });

    // Rejection path: no DeclaraApplyChange fires, so the captured
    // step-kinds list stays empty. The provider still finishes its
    // queue (the model's recovery text turn), proving the loop
    // didn't wedge on the rejection.
    expect(result.appliedStepKinds).toEqual([]);
    expect(result.appliedResults).toHaveLength(0);
    expect(result.turnCount).toBe(1);
  });
});
